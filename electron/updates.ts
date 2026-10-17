/**
 * Updating Lockin from Settings, without downloading the whole .dmg again. Each build
 * publishes update.json and a small archive of Lockin's own code beside the .dmg
 * (scripts/pack-update.mjs). An update is unpacked into the data folder next to the
 * bundle's libraries, which it borrows, and electron/boot.ts runs it from the next
 * launch. When a build needs different libraries or a newer Electron, only the .dmg
 * will do, and Settings says so.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST = "https://github.com/surfxce/letslockin/releases/download/mac-latest/update.json";
/** The Mac app's builds, newest first: one may be under way for changes not released yet. */
const RUNS = "https://api.github.com/repos/surfxce/letslockin/actions/workflows/mac-app.yml/runs?per_page=10&exclude_pull_requests=true";

export interface BuildInfo {
  version: string;
  builtAt: string;
  depsHash: string;
  notes?: string;
}

export interface Manifest extends BuildInfo {
  url: string;
  size: number;
  sha256: string;
  dmg: string;
}

/** Newer changes still being built into an update: when it should be ready. */
export interface Building {
  version: string;
  notes: string;
  readyAt: string;
}

export type UpdateCheck =
  | { state: "unsupported"; current: BuildInfo | null }
  | { state: "current"; current: BuildInfo; building?: Building }
  | { state: "available"; current: BuildInfo; latest: Manifest; inPlace: boolean; building?: Building }
  | { state: "error"; current: BuildInfo | null; message: string };

export function readInfo(dir: string): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

export async function checkForUpdate(opts: { packaged: boolean; root: string; bundle: string }): Promise<UpdateCheck> {
  const current = readInfo(opts.root);
  // From the repo, `git pull` is the update.
  if (!opts.packaged || !current) return { state: "unsupported", current };
  try {
    const [res, run] = await Promise.all([
      fetch(MANIFEST, { cache: "no-store", signal: AbortSignal.timeout(20_000) }),
      buildUnderWay().catch(() => null),
    ]);
    if (res.status === 404) return { state: "current", current, ...(run && { building: run }) };
    if (!res.ok) throw new Error(`the update server answered ${res.status}`);
    const latest = (await res.json()) as Manifest;
    const building = run && run.version !== current.version && run.version !== latest.version ? run : undefined;
    if (latest.version === current.version || latest.builtAt <= current.builtAt) return { state: "current", current, building };
    const bundled = readInfo(opts.bundle);
    return { state: "available", current, latest, inPlace: !!bundled && latest.depsHash === bundled.depsHash, building };
  } catch (err) {
    return { state: "error", current, message: err instanceof Error ? err.message : String(err) };
  }
}

interface Run {
  head_sha: string;
  status: string;
  conclusion: string | null;
  run_started_at: string;
  updated_at: string;
  head_commit?: { message?: string };
}

/**
 * A build of newer changes, queued or running on GitHub, with when it should finish:
 * as long after it started as the last finished build took. Null when none is running.
 */
async function buildUnderWay(): Promise<Building | null> {
  const res = await fetch(RUNS, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const { workflow_runs: runs } = (await res.json()) as { workflow_runs: Run[] };
  const running = runs.find((r) => r.status !== "completed");
  if (!running) return null;
  const done = runs.find((r) => r.status === "completed" && r.conclusion === "success");
  const took = done ? Date.parse(done.updated_at) - Date.parse(done.run_started_at) : 15 * 60_000;
  return {
    version: running.head_sha.slice(0, 7),
    notes: running.head_commit?.message?.split("\n")[0] ?? "",
    readyAt: new Date(Date.parse(running.run_started_at) + took).toISOString(),
  };
}

/** Downloads, checks and unpacks an update; it runs from the next launch. */
export async function installUpdate(latest: Manifest, dirs: { userData: string; bundle: string }) {
  const base = path.join(dirs.userData, "app-update");
  const incoming = path.join(base, `incoming-${Date.now()}`);
  const archive = path.join(base, "lockin-update.tar.gz");
  await mkdir(incoming, { recursive: true });
  try {
    const res = await fetch(latest.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`the download answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== latest.sha256) {
      throw new Error("the download didn't match — try again");
    }
    await writeFile(archive, bytes);
    await new Promise<void>((resolve, reject) =>
      execFile("tar", ["-xzf", archive, "-C", incoming], (err) => (err ? reject(err) : resolve())),
    );
    if (!existsSync(path.join(incoming, "dist", "electron", "main.cjs")) || !existsSync(path.join(incoming, ".next"))) {
      throw new Error("the update was incomplete");
    }
    // The libraries stay the bundle's.
    await symlink(path.join(dirs.bundle, "node_modules"), path.join(incoming, "node_modules"), "dir");
    const current = path.join(base, "current");
    const old = path.join(base, `old-${Date.now()}`);
    if (existsSync(current)) await rename(current, old);
    await rename(incoming, current);
    await rm(old, { recursive: true, force: true });
  } catch (err) {
    await rm(incoming, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(archive, { force: true });
  }
}
