import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
} from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Starting other programs the same way on every platform.
 *
 * On macOS and Linux everything here is the plain child_process call, unchanged.
 * Windows differs in three ways that each break a naive spawn():
 *
 *   - A bare name needs its extension found. `claude` is claude.exe from the native
 *     installer, or the claude.cmd shim `npm i -g` writes, and spawn() only tries .exe.
 *   - A .cmd or .bat runs only through cmd.exe, and since CVE-2024-27980 Node refuses
 *     to do that implicitly (EINVAL). So it is run through cmd.exe here, with every
 *     argument escaped for it.
 *   - There are no signals. kill() ends one process at once and leaves whatever it
 *     started still running, so a tree is ended with taskkill.
 */

type Env = Record<string, string | undefined>;

/** Windows variable names ignore case; a copied env object does not ("Path" vs "PATH"). */
function envGet(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Where Windows tools are installed that PATH may not list yet — a terminal opened
 * before the install, or an app started from the Start menu before the next sign-in.
 */
export function windowsToolDirs(env: Env = process.env): string[] {
  const w = path.win32;
  const home = envGet(env, "USERPROFILE");
  const roaming = envGet(env, "APPDATA");
  const local = envGet(env, "LOCALAPPDATA");
  const programs = envGet(env, "ProgramFiles");
  return [
    home && w.join(home, ".local", "bin"), // Claude Code's native installer
    roaming && w.join(roaming, "npm"), // npm i -g
    local && w.join(local, "pnpm"),
    home && w.join(home, ".bun", "bin"),
    home && w.join(home, "scoop", "shims"),
    local && w.join(local, "Microsoft", "WinGet", "Links"),
    programs && w.join(programs, "nodejs"), // node itself, for npm's shims
  ].filter((d): d is string => Boolean(d));
}

function isFileOnDisk(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface FindOptions {
  platform?: NodeJS.Platform;
  env?: Env;
  /** What a relative path is relative to. */
  cwd?: string;
  isFile?: (p: string) => boolean;
}

const NATIVE = [".exe", ".com"];

/**
 * The file Windows would run for `command`, or null when there is none. A native
 * executable anywhere wins over a .cmd shim: it runs with no cmd.exe in between, so its
 * arguments arrive exactly as given. Elsewhere the command comes back as it is, and
 * spawn() searches PATH itself, as it always has.
 */
export function findCommand(command: string, opts: FindOptions = {}): string | null {
  if ((opts.platform ?? process.platform) !== "win32") return command;
  const w = path.win32;
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? isFileOnDisk;
  const cwd = opts.cwd ?? process.cwd();

  const listed = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const tiers = listed.includes(w.extname(command).toLowerCase())
    ? [[""]]
    : [NATIVE, listed.filter((e) => !NATIVE.includes(e))];

  const dirs = /[\\/]/.test(command)
    ? [cwd]
    : [
        ...(envGet(env, "PATH") ?? "")
          .split(";")
          .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
          .filter(Boolean),
        ...windowsToolDirs(env),
      ];
  for (const exts of tiers) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = w.resolve(cwd, dir, command + ext);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** cmd.exe's special characters, each escaped with ^ (cross-spawn's list). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument quoted the way the C runtime, and so Node, splits a command line back up. */
export function quoteArg(arg: string): string {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

export interface Invocation {
  file: string;
  args: string[];
  /** For spawn's windowsVerbatimArguments: the line is already escaped. */
  verbatim: boolean;
}

/**
 * How to start `command` with `args`. Only a Windows .cmd or .bat changes: it runs as
 * `cmd.exe /d /s /c "<line>"` with the line built here, every special character
 * escaped, so nothing in an argument (a space, &, a quote) can end it early or start
 * another command. npm's shims hand their arguments on through %* to a second command
 * line, so cmd.exe reads them twice and the escapes are doubled.
 */
export function commandFor(
  command: string,
  args: readonly string[],
  opts: FindOptions & { comspec?: string } = {},
): Invocation {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args], verbatim: false };
  const file = findCommand(command, opts) ?? command;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false };
  const escape = (s: string) => s.replace(CMD_META, "^$1");
  const line = [escape(path.win32.normalize(file)), ...args.map((a) => escape(escape(quoteArg(a))))].join(" ");
  const comspec = opts.comspec ?? envGet(opts.env ?? process.env, "ComSpec") ?? "cmd.exe";
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * spawn(), able to run a .cmd shim on Windows and never opening a console window
 * there — the packaged app has none, so each call would flash one up. Elsewhere it is
 * exactly spawn().
 */
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCommand(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform !== "win32") return spawn(command, args, options);
  const run = commandFor(command, args, { env: options.env });
  return spawn(run.file, run.args, { windowsHide: true, ...options, windowsVerbatimArguments: run.verbatim });
}

/**
 * A NODE_OPTIONS entry that makes a Node process exit once process `pid` has gone.
 * Every Node process started below inherits it, so a whole tree follows — tsx's
 * second node, `next dev`'s forked server, an npm-installed claude.
 *
 * For Windows, where a parent killed outright leaves its children running: Ctrl+C on
 * `electron .` in a terminal reaches only console programs, and Electron's own
 * launcher answers it with TerminateProcess, so the app never gets to stop its server
 * and worker — which then hold the port and keep taking jobs beside the next launch's.
 * Elsewhere Ctrl+C reaches the whole process group, and this is not needed.
 */
export function exitWithProcessOption(pid: number, intervalMs = 2000): string {
  const code =
    `const p=${Math.trunc(pid)};setInterval(()=>{try{process.kill(p,0)}catch(e){` +
    `if(e.code==="ESRCH")process.exit(1)}},${Math.trunc(intervalMs)}).unref();`;
  // Percent-encoded, it has no spaces or quotes for NODE_OPTIONS to split on.
  return `--import=data:text/javascript,${encodeURIComponent(code)}`;
}

function taskkill(): string {
  return path.win32.join(envGet(process.env, "SystemRoot") ?? "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Ends a process and everything it started. On Windows a .cmd shim is cmd.exe running
 * node, tsx runs its script in a second node, and `next dev` forks its server: kill()
 * there ends only the first of each, leaving the rest running — holding the port, or
 * still writing — with nothing left to stop them. taskkill /T ends the whole tree; a
 * console program has no gentle way to be asked, so it is /F. `wait` blocks until it
 * is done, for an app that is about to exit. Elsewhere it is child.kill(signal).
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM", opts: { wait?: boolean } = {}): void {
  if (process.platform !== "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const args = ["/pid", String(child.pid), "/T", "/F"];
  if (opts.wait) {
    try {
      execFileSync(taskkill(), args, { stdio: "ignore", windowsHide: true });
    } catch {
      child.kill(signal); // already gone, or taskkill missing: at least the process itself
    }
  } else {
    execFile(taskkill(), args, { windowsHide: true }, (err) => {
      if (err) child.kill(signal);
    });
  }
}
