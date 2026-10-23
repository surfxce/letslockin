/**
 * Lockin as a desktop app.
 *
 * Electron owns the window and the lifecycle. The migrator, the Next server and the
 * job worker each run as child processes:
 *
 *   - Packaged, they run under Electron's own Node (ELECTRON_RUN_AS_NODE), because
 *     better-sqlite3 inside the bundle is rebuilt against Electron's ABI.
 *   - From the repo, they run under the system Node, whose ABI matches the
 *     better-sqlite3 in node_modules. Rebuilding it for Electron would break
 *     `npm run worker`, the tests and the Prisma CLI.
 *
 * Electron itself never imports Prisma, so it never has to care which one is which.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";

import { isExportPath, safeFileName } from "../lib/export";
import { startPhoneGateway, type PhoneGateway } from "./phone-gateway";
import { checkForUpdate, installUpdate, type Manifest } from "./updates";

const DEV = process.env.LOCKIN_DEV === "1";
const PORT = Number(process.env.LOCKIN_PORT ?? 3579);
/** Where a paired iPhone reaches this computer on the local network (electron/phone-gateway.ts). */
const PHONE_PORT = Number(process.env.LOCKIN_PHONE_PORT ?? 47821);
let phoneGateway: PhoneGateway | null = null;

const PACKAGED = app.isPackaged;

// Run from the repo, the app is Electron's own binary and would call itself "Electron"
// in menus, notifications and dialogs. Its browser storage (reading places, table
// views) stays where it has always been, under Electron's name.
if (!PACKAGED) app.setPath("userData", app.getPath("userData"));
app.setName("Lockin");
/** The bundle's own code — Electron and the libraries, which updates never replace. */
const BUNDLE = PACKAGED ? app.getAppPath() : path.resolve(__dirname, "..", "..");
/** Lockin's code: the bundle's, or an update downloaded from Settings (electron/boot.ts). */
const ROOT = process.env.LOCKIN_APP_ROOT ?? BUNDLE;
/** Read-only things that ship with the app: prompt files and migration SQL. An update carries its own. */
const RESOURCES = process.env.LOCKIN_APP_ROOT ?? (PACKAGED ? process.resourcesPath : ROOT);
/** Everything writable. Inside a packaged .app the bundle itself is read-only. */
const DATA = PACKAGED ? app.getPath("userData") : ROOT;

const children: ChildProcess[] = [];
let window: BrowserWindow | null = null;

/**
 * A GUI app launched from Finder inherits launchd's PATH, which has none of the
 * places a CLI actually lives — so `claude` would be missing in the packaged app
 * and present when run from a terminal, which is a maddening bug to chase.
 */
function searchPath(): string {
  const home = app.getPath("home");
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
  ];
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...extra, ...current, "/usr/bin", "/bin"])].join(":");
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: searchPath(),
    NODE_ENV: DEV ? "development" : "production",
    ...(PACKAGED ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    LOCKIN_DATA_DIR: DATA,
    LOCKIN_PROMPTS_DIR: path.join(RESOURCES, "prompts"),
    // The MLX engine ships inside the bundle (never in an update): see lib/llm/mlx.ts.
    ...(PACKAGED ? { LOCKIN_ENGINE: path.join(process.resourcesPath, "engine", "lockin-engine") } : {}),
    // So does the transcription helper (Whisper): see lib/recordings/helper.ts.
    ...(PACKAGED ? { LOCKIN_WHISPER: path.join(process.resourcesPath, "engine", "lockin-whisper") } : {}),
    LOCKIN_MIGRATIONS_DIR: PACKAGED
      ? path.join(RESOURCES, "migrations")
      : path.join(ROOT, "prisma", "migrations"),
    // Packaged, the database lives in the data folder. From the repo, each process
    // reads .env, so this is the same database `npm run dev` and `prisma migrate` use.
    ...(PACKAGED ? { DATABASE_URL: `file:${path.join(DATA, "lockin.db")}` } : {}),
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    LOCKIN_PHONE_PORT: String(PHONE_PORT),
  };
}

/** Electron's Node when packaged, the system Node when running from the repo. */
const RUNTIME = PACKAGED ? process.execPath : (process.env.LOCKIN_NODE ?? "node");

function fork(script: string, args: string[], label: string): ChildProcess {
  const child = spawn(RUNTIME, [script, ...args], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.on("error", (err) => {
    dialog.showErrorBox(
      `Lockin could not start the ${label} process`,
      `${err.message}\n\nIf you are running from the repository, Lockin uses the ` +
        `system Node so the SQLite driver matches the one it was built for. Set ` +
        `LOCKIN_NODE to Node's full path if it is installed somewhere unusual.`,
    );
  });
  children.push(child);
  return child;
}

/** Runs a script to completion — used for migrations, which must finish first. */
function runOnce(script: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = fork(script, args, label);
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${label} failed (${code})\n${stderr.slice(-800)}`)),
    );
  });
}

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`server never came up on :${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          { label: "Open Data Folder", click: () => shell.openPath(DATA) },
          { type: "separator" as const },
          isMac ? { role: "close" as const } : { role: "quit" as const },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" as const },
          { role: "forceReload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const },
          { role: "resetZoom" as const },
          { role: "zoomIn" as const },
          { role: "zoomOut" as const },
          { role: "togglefullscreen" as const },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** Shows the window at a page, creating it if every window was closed. */
async function openAt(pathname: string) {
  if (window) {
    await window.loadURL(`http://localhost:${PORT}${pathname}`);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else {
    await createWindow(pathname);
  }
}

async function createWindow(pathname = "/") {
  window = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 720,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#101715",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  await window.loadURL(`http://localhost:${PORT}${pathname}`);
  window.show();
  window.on("closed", () => (window = null));
}

// ---------------------------------------------------------------------------
// Saving summaries as a PDF. The export page is printed in a hidden window of its
// own, so the visible one stays usable and its scroll position or anything open in
// it never ends up in the file.

/** The PDFs saved this session: the only files the page may ask to open. */
const savedPdfs = new Set<string>();
let pdfFolder: string | null = null;

/** Every picture loaded or failed (slides are drawn on first request), and the fonts. */
const PICTURES_READY = `(async () => {
  await document.fonts.ready;
  const imgs = [...document.images];
  await Promise.all(imgs.map((img) => img.complete ? null : new Promise((done) => {
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  })));
  // The page swaps a failed picture for a note saying why; let that land.
  await new Promise((done) => setTimeout(done, 400));
})()`;

/** Page numbers at the foot of each page; `title` is the page's, which names the export. */
const FOOTER =
  '<div style="width:100%;padding:0 15mm;display:flex;justify-content:space-between;' +
  "font:8px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#9b9a97\">" +
  '<span class="title"></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';

type SavePdfResult = { ok: true; path: string; name: string } | { ok: false; message: string } | null;

async function savePdf(owner: BrowserWindow | null, pathname: unknown, title: unknown): Promise<SavePdfResult> {
  if (typeof pathname !== "string" || !isExportPath(pathname)) {
    return { ok: false, message: "only the export page can be saved as a PDF" };
  }
  const options: Electron.SaveDialogOptions = {
    title: "Save summaries as a PDF",
    defaultPath: path.join(pdfFolder ?? app.getPath("documents"), `${safeFileName(String(title ?? ""))}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  };
  const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return null;
  const file = /\.pdf$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.pdf`;
  pdfFolder = path.dirname(file);

  const printer = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1300,
    webPreferences: {
      // The same bridge as the main window, so the page knows it is the desktop app and
      // leaves reminders to this process rather than raising its own.
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // It prints the export page and nothing else: no popups, links or redirects.
  printer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  printer.webContents.on("will-navigate", (event) => event.preventDefault());
  printer.webContents.on("will-redirect", (event) => event.preventDefault());
  let timer: NodeJS.Timeout | undefined;
  try {
    // Loading waits for every picture, and a course's worth of slides can take a while
    // to draw the first time; past three minutes, print what there is.
    const loaded = (async () => {
      await printer.loadURL(`http://localhost:${PORT}${pathname}`);
      await printer.webContents.executeJavaScript(PICTURES_READY, true);
    })();
    loaded.catch(() => undefined);
    await Promise.race([loaded, new Promise((done) => (timer = setTimeout(done, 180_000)))]);
    if (new URL(printer.webContents.getURL()).pathname !== "/export") {
      return { ok: false, message: "the export page didn't load" };
    }
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      // The page sets the paper size and margins the user chose.
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER,
      // Bookmarks from the headings: a lecture per top-level entry.
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    await writeFile(file, pdf);
    savedPdfs.add(file);
    return { ok: true, path: file, name: path.basename(file) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    printer.destroy();
  }
}

// ---------------------------------------------------------------------------
// Reminders. They come from here rather than the page so they arrive with no
// window open — on macOS the app keeps running in the dock after its window closes.

interface Due {
  lectureId: string;
  title: string;
  courseCode: string;
}

const REMINDER_CHECK_MS = 5 * 60_000;
/** lectureId → the day it was last announced, so each lecture nags once a day at most. */
const announced = new Map<string, string>();
/** Notifications are garbage-collected (and their click handlers lost) unless held. */
const live = new Set<Notification>();

async function checkReminders() {
  let status: { notify: boolean; due: Due[] };
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    if (!res.ok) return;
    status = await res.json();
  } catch {
    return; // the server is restarting; try again next round
  }

  // The dock badge is the quiet reminder; it shows whether or not notifications are on.
  app.setBadgeCount(status.due.length);

  const hour = new Date().getHours();
  if (!status.notify || !Notification.isSupported() || hour < 8 || hour >= 22) return;
  const today = new Date().toDateString();
  const fresh = status.due.filter((d) => announced.get(d.lectureId) !== today);
  if (fresh.length === 0) return;

  const one = fresh.length === 1;
  const n = new Notification({
    title: one ? "Time to redo your LAQs" : `${fresh.length} lectures are due for LAQs`,
    body: one
      ? `${fresh[0].courseCode} · ${fresh[0].title}`
      : fresh.slice(0, 3).map((d) => d.title).join(" · "),
  });
  live.add(n);
  n.on("click", () => {
    live.delete(n);
    void openAt(one ? `/lectures/${fresh[0].lectureId}` : "/#due");
  });
  n.on("close", () => live.delete(n));
  n.show();
  for (const d of fresh) announced.set(d.lectureId, today);
}

const script = (packagedPath: string, devScript: string, devArgs: string[] = []) =>
  PACKAGED
    ? { file: path.join(ROOT, packagedPath), args: [] as string[] }
    : { file: devScript, args: devArgs };

app.whenReady().then(async () => {
  // The packaged app has its icon in its bundle; from the repo, show it in the dock.
  if (!PACKAGED && process.platform === "darwin") app.dock?.setIcon(path.join(ROOT, "build", "icon.png"));
  buildMenu();
  // Windows only shows notifications for an app with a registered id.
  if (process.platform === "win32") app.setAppUserModelId("app.lockin");

  try {
    // Migrations first: on a fresh machine there is no database yet, and the server
    // would fail its first query rather than create one.
    // From the repo the migrator runs through tsx, which needs the entry as an arg:
    // without one it opens a REPL, which exits 0 at once and migrates nothing.
    const migrate = script(
      "dist/scripts/migrate.cjs",
      path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      [path.join(ROOT, "scripts", "migrate.ts")],
    );
    await runOnce(migrate.file, migrate.args, "migrate");

    fork(
      path.join(ROOT, "node_modules", "next", "dist", "bin", "next"),
      [DEV ? "dev" : "start", "-p", String(PORT)],
      "next",
    );
    if (PACKAGED) {
      fork(path.join(ROOT, "dist", "worker", "index.cjs"), [], "worker");
    } else {
      fork(
        path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
        [path.join(ROOT, "worker", "index.ts")],
        "worker",
      );
    }

    // Listens on the network only while a phone is paired; it asks the server.
    phoneGateway = startPhoneGateway({ serverPort: PORT, phonePort: PHONE_PORT });

    await waitForPort(PORT);
    await createWindow();
    setTimeout(() => void checkReminders(), 15_000);
    setInterval(() => void checkReminders(), REMINDER_CHECK_MS);
  } catch (err) {
    dialog.showErrorBox(
      "Lockin could not start",
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
  }

  ipcMain.handle("lockin:pickFolder", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "Choose the folder your lecture files are in",
      properties: ["openDirectory"],
      buttonLabel: "Scan this folder",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("lockin:savePdf", (event, pathname: unknown, title: unknown) =>
    savePdf(BrowserWindow.fromWebContents(event.sender), pathname, title),
  );
  // Each answers with what went wrong, or null.
  ipcMain.handle("lockin:openFile", async (_event, file: unknown) => {
    if (typeof file !== "string" || !savedPdfs.has(file)) return "that isn't a PDF Lockin saved";
    return (await shell.openPath(file)) || null;
  });
  // Updates from Settings: check, then download and restart into the new version.
  let latest: Manifest | null = null;
  ipcMain.handle("lockin:checkUpdate", async () => {
    const check = await checkForUpdate({ packaged: PACKAGED, root: ROOT, bundle: BUNDLE });
    latest = check.state === "available" ? check.latest : null;
    return check;
  });
  ipcMain.handle("lockin:installUpdate", async () => {
    if (!latest) return "check for updates first";
    try {
      await installUpdate(latest, { userData: app.getPath("userData"), bundle: BUNDLE });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    app.relaunch();
    shutdown();
    app.exit(0);
    return null;
  });

  ipcMain.handle("lockin:showFile", (_event, file: unknown) => {
    if (typeof file !== "string" || !savedPdfs.has(file)) return "that isn't a PDF Lockin saved";
    shell.showItemInFolder(file);
    return null;
  });

  app.on("activate", () => {
    // Not "no windows at all": a PDF being printed has a hidden one.
    if (!window) createWindow();
  });
});

function shutdown() {
  phoneGateway?.stop();
  phoneGateway = null;
  for (const child of children) child.kill("SIGTERM");
}
app.on("window-all-closed", () => {
  // On macOS the app stays in the dock with its server and worker still running, so
  // a lecture keeps preparing, a reminder can still fire, and reopening the window
  // finds a live server rather than a dead page. Elsewhere, closing the window quits.
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", shutdown);
process.on("exit", shutdown);
