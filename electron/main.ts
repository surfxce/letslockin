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
import { createConnection } from "node:net";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";

const DEV = process.env.LOCKIN_DEV === "1";
const PORT = Number(process.env.LOCKIN_PORT ?? 3579);

const PACKAGED = app.isPackaged;
const ROOT = PACKAGED ? app.getAppPath() : path.resolve(__dirname, "..", "..");
/** Read-only things that ship with the app: prompt files and migration SQL. */
const RESOURCES = PACKAGED ? process.resourcesPath : ROOT;
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
    LOCKIN_MIGRATIONS_DIR: PACKAGED
      ? path.join(RESOURCES, "migrations")
      : path.join(ROOT, "prisma", "migrations"),
    // Packaged, the database lives in the data folder. From the repo, each process
    // reads .env, so this is the same database `npm run dev` and `prisma migrate` use.
    ...(PACKAGED ? { DATABASE_URL: `file:${path.join(DATA, "lockin.db")}` } : {}),
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
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
