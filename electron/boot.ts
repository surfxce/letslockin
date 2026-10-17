/**
 * The desktop app's entry. Packaged, it first looks for an update downloaded from
 * Settings (electron/updates.ts unpacks them into the data folder; the app bundle itself
 * is never changed) and runs that if it is newer than this bundle and needs the same
 * libraries — otherwise the code inside the bundle. From the repo it always runs that.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

interface BuildInfo {
  version: string;
  builtAt: string;
  depsHash: string;
}

function readInfo(dir: string): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

// Evaluated at run time: the update's main.cjs is not something to bundle.
const load = eval("require") as NodeRequire;

let entry = path.join(__dirname, "main.cjs");
if (app.isPackaged) {
  const update = path.join(app.getPath("userData"), "app-update", "current");
  const bundled = readInfo(app.getAppPath());
  const downloaded = readInfo(update);
  const usable =
    bundled &&
    downloaded &&
    downloaded.depsHash === bundled.depsHash &&
    downloaded.builtAt > bundled.builtAt &&
    existsSync(path.join(update, "dist", "electron", "main.cjs"));
  if (usable) {
    process.env.LOCKIN_APP_ROOT = update;
    entry = path.join(update, "dist", "electron", "main.cjs");
  }
}
load(entry);
