import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/paths";
import { runHelper, whisperHelper } from "@/lib/recordings/helper";
import { QWEN_MODELS, type QwenModel, type QwenVoice } from "@/lib/voice/choice";

/**
 * The examiner's voice: Qwen3-TTS (CustomVoice, 0.6B or 1.7B) running on the Mac's
 * Neural Engine through the speech helper (swift/LockinWhisper, TTSKit), downloaded
 * once. One helper stays running while it's in use, so each line is quick once the
 * first is said.
 */

const modelsDir = () => path.join(dataDir(), "voices");
const IDLE_MS = 10 * 60_000;

/** The helper's mark that a model is downloaded (the 0.6B keeps its first name). */
const marker = (model: QwenModel) => path.join(modelsDir(), model === "0.6b" ? "ready.json" : `ready-${model}.json`);

export function naturalVoiceReady(model: QwenModel): boolean {
  return existsSync(marker(model));
}

interface Download {
  progress: number;
  error: string | null;
  running: boolean;
}

const downloads: Partial<Record<QwenModel, Download>> = {};

export interface NaturalStatus {
  /** The speech helper is here (it comes with the Mac app). */
  helper: boolean;
  ready: Record<QwenModel, boolean>;
  downloading: Record<QwenModel, Download | null>;
}

export function naturalStatus(): NaturalStatus {
  const ready = {} as Record<QwenModel, boolean>;
  const downloading = {} as Record<QwenModel, Download | null>;
  for (const m of QWEN_MODELS) {
    ready[m.id] = naturalVoiceReady(m.id);
    downloading[m.id] = downloads[m.id] ?? null;
  }
  return { helper: !!whisperHelper(), ready, downloading };
}

/** Starts a model's one-time download; its progress shows in naturalStatus(). */
export function startNaturalDownload(model: QwenModel): NaturalStatus {
  if (!whisperHelper()) throw new Error("Qwen voices come with the Mac app — install the latest Lockin.dmg.");
  if (downloads[model]?.running || naturalVoiceReady(model)) return naturalStatus();
  const state: Download = { progress: 0, error: null, running: true };
  downloads[model] = state;
  runHelper(["voice-download", "--models", modelsDir(), "--variant", model], (p) => {
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
  model: QwenModel;
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<string, { resolve: (file: string) => void; reject: (err: Error) => void }>;
  idle: NodeJS.Timeout | null;
}

let server: Server | null = null;

/** Stops the voice's helper, if it's running. */
export function stopNaturalVoice() {
  stopServer("Stopped.");
}

function stopServer(why: string) {
  const s = server;
  server = null;
  if (!s) return;
  if (s.idle) clearTimeout(s.idle);
  for (const p of s.pending.values()) p.reject(new Error(why));
  s.child.kill();
}

function startServer(model: QwenModel): Server {
  const binary = whisperHelper();
  if (!binary) throw new Error("Qwen voices come with the Mac app — install the latest Lockin.dmg.");
  const child = spawn(binary, ["speak", "--models", modelsDir(), "--variant", model], { stdio: ["pipe", "pipe", "pipe"] });
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
        else p.reject(new Error(message.error ?? "The voice couldn't say that."));
      } else if (message.error) lastError = message.error;
    }
  });
  // The helper says what went wrong as JSON; anything it printed besides is kept too,
  // so a crash still says something useful.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on("close", (code) => {
    const why = lastError || stderr.trim().split("\n").at(-1) || `The voice stopped (exit code ${code ?? "none"}).`;
    failReady(new Error(why));
    if (server?.child === child) stopServer(why);
  });
  child.on("error", (err) => failReady(err));
  return { model, child, ready, pending, idle: null };
}

export interface SayOptions {
  voice: QwenVoice;
  model: QwenModel;
  /** A speaking style, followed by the 1.7B model only. */
  style?: string;
}

/** Says a line in a Qwen voice: WAV audio. The first one waits for the model to load. */
export async function speakNatural(text: string, opts: SayOptions): Promise<Buffer> {
  const model = QWEN_MODELS.find((m) => m.id === opts.model);
  if (!model || !naturalVoiceReady(model.id)) {
    throw new Error(`${model?.label ?? "That voice"} hasn't been downloaded yet (Settings → Viva voice).`);
  }
  // One model in memory at a time: switching models starts the helper afresh.
  if (server && server.model !== model.id) stopServer("Switched model.");
  server ??= startServer(model.id);
  const s = server;
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => stopServer("Stopped while idle."), IDLE_MS);
  // An idle helper is no reason to keep Lockin's server running.
  s.idle.unref();
  await s.ready;
  const id = Math.random().toString(36).slice(2, 10);
  const file = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error("The voice took too long."));
    }, 90_000);
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
    const instruction = model.id === "1.7b" && opts.style ? opts.style : undefined;
    s.child.stdin.write(`${JSON.stringify({ id, text: text.slice(0, 2000), voice: opts.voice, ...(instruction ? { instruction } : {}) })}\n`);
  });
  try {
    return await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
}
