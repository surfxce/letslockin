import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/paths";
import { runHelper, whisperHelper } from "@/lib/recordings/helper";

/**
 * The natural voice: Qwen3-TTS running on the Mac's Neural Engine through the speech
 * helper (swift/LockinWhisper, TTSKit), downloaded once (about 1 GB). One helper stays
 * running while it's in use, so each line is quick once the first is said.
 */

const modelsDir = () => path.join(dataDir(), "voices");
const IDLE_MS = 10 * 60_000;

export function naturalVoiceReady(): boolean {
  return existsSync(path.join(modelsDir(), "ready.json"));
}

let download: { progress: number; error: string | null; running: boolean } | null = null;

export interface NaturalStatus {
  /** The speech helper is here (it comes with the Mac app). */
  helper: boolean;
  ready: boolean;
  downloading: { progress: number; error: string | null; running: boolean } | null;
}

export function naturalStatus(): NaturalStatus {
  return { helper: !!whisperHelper(), ready: naturalVoiceReady(), downloading: download };
}

/** Starts the one-time download; its progress shows in naturalStatus(). */
export function startNaturalDownload(): NaturalStatus {
  if (!whisperHelper()) throw new Error("The natural voice comes with the Mac app — install the latest Lockin.dmg.");
  if (download?.running || naturalVoiceReady()) return naturalStatus();
  download = { progress: 0, error: null, running: true };
  const state = download;
  runHelper(["voice-download", "--models", modelsDir()], (p) => {
    if (p.stage === "download") state.progress = p.progress;
  })
    .then(() => {
      state.running = false;
      state.progress = 1;
    })
    .catch((err) => {
      state.running = false;
      state.error = err instanceof Error ? err.message : String(err);
    });
  return naturalStatus();
}

interface Server {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<string, { resolve: (file: string) => void; reject: (err: Error) => void }>;
  idle: NodeJS.Timeout | null;
}

let server: Server | null = null;

function stopServer(why: string) {
  const s = server;
  server = null;
  if (!s) return;
  for (const p of s.pending.values()) p.reject(new Error(why));
  s.child.kill();
}

function startServer(): Server {
  const binary = whisperHelper();
  if (!binary) throw new Error("The natural voice comes with the Mac app — install the latest Lockin.dmg.");
  const child = spawn(binary, ["speak", "--models", modelsDir()], { stdio: ["pipe", "pipe", "pipe"] });
  const pending: Server["pending"] = new Map();
  let markReady: () => void = () => undefined;
  let failReady: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // Nothing waiting on it yet must not count as an unhandled failure.
  ready.catch(() => undefined);
  let partial = "";
  let lastError = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    partial += chunk;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      let message: { ready?: boolean; id?: string; path?: string; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ready) markReady();
      else if (message.id && pending.has(message.id)) {
        const p = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.path) p.resolve(message.path);
        else p.reject(new Error(message.error ?? "The natural voice couldn't say that."));
      } else if (message.error) lastError = message.error;
    }
  });
  child.stderr.on("data", () => undefined);
  child.on("close", () => {
    failReady(new Error(lastError || "The natural voice stopped."));
    if (server?.child === child) stopServer(lastError || "The natural voice stopped.");
  });
  child.on("error", (err) => failReady(err));
  return { child, ready, pending, idle: null };
}

/** Says a line in the natural voice: WAV audio. The first one waits for the model to load. */
export async function speakNatural(text: string, voice = "aiden"): Promise<Buffer> {
  if (!naturalVoiceReady()) throw new Error("The natural voice hasn't been downloaded yet (Settings → Viva voice).");
  server ??= startServer();
  const s = server;
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => stopServer("Stopped while idle."), IDLE_MS);
  await s.ready;
  const id = Math.random().toString(36).slice(2, 10);
  const file = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error("The natural voice took too long."));
    }, 60_000);
    s.pending.set(id, {
      resolve: (f) => {
        clearTimeout(timer);
        resolve(f);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    s.child.stdin.write(`${JSON.stringify({ id, text: text.slice(0, 2000), voice })}\n`);
  });
  try {
    return await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
}
