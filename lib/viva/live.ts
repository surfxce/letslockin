import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";

import { runHelper, WHISPER_MODELS, whisperHelper, whisperModelsDir, type WhisperChoice } from "@/lib/recordings/helper";

/**
 * A spoken answer heard while it's said: Whisper on this Mac (the speech helper's
 * `listen`), kept running while a viva goes on so each answer starts at once. The viva
 * page sends its sound a piece at a time and gets back what's been heard so far; the end
 * of the answer is heard once more for the final text.
 */

const IDLE_MS = 10 * 60_000;
const FINAL_MS = 120_000;

export interface Heard {
  /** Words that won't change now. */
  confirmed: string;
  /** The end of what's been said so far, which still may. */
  tentative: string;
  /** What Whisper is doing before it's ready to hear (downloading, loading), else null. */
  preparing: string | null;
}

interface Answer {
  id: string;
  confirmed: string;
  tentative: string;
  error: string | null;
  final: { resolve: (text: string) => void; reject: (err: Error) => void } | null;
}

interface Listener {
  variant: string;
  child: ChildProcessWithoutNullStreams;
  preparing: string | null;
  failed: string | null;
  answer: Answer | null;
  idle: NodeJS.Timeout | null;
}

let listener: Listener | null = null;
let known: { binary: string; changed: number; live: boolean } | null = null;

/** Whether the installed speech helper can hear live (it can from version 5). */
export async function canHearLive(): Promise<boolean> {
  const binary = whisperHelper();
  if (!binary) return false;
  const changed = statSync(binary).mtimeMs;
  if (known?.binary !== binary || known.changed !== changed) {
    const info = await runHelper(["version"]).catch(() => ({}) as Record<string, unknown>);
    known = { binary, changed, live: info.live === true };
  }
  return known.live;
}

/** Stops hearing, if it's running. */
export function stopLive() {
  const l = listener;
  listener = null;
  if (!l) return;
  if (l.idle) clearTimeout(l.idle);
  l.child.kill();
}

function startListener(variant: string): Listener {
  const binary = whisperHelper();
  if (!binary) throw new Error("Hearing answers needs the speech helper — install the latest Lockin.dmg.");
  const child = spawn(binary, ["listen", "--model", variant, "--models", whisperModelsDir()], { stdio: ["pipe", "pipe", "pipe"] });
  const l: Listener = { variant, child, preparing: "Loading Whisper…", failed: null, answer: null, idle: null };
  let partial = "";
  let lastError = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    partial += chunk;
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      let m: { ready?: boolean; stage?: string; progress?: number; id?: string; confirmed?: string; tentative?: string; text?: string; final?: boolean; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.ready) l.preparing = null;
      else if (m.stage === "download") l.preparing = `Downloading Whisper (the first time only)… ${Math.round((m.progress ?? 0) * 100)}%`;
      else if (m.id) {
        const a = l.answer;
        if (!a || a.id !== m.id) continue;
        if (typeof m.error === "string") {
          a.error = m.error;
          a.final?.reject(new Error(m.error));
          a.final = null;
        } else if (m.final) {
          a.confirmed = m.text ?? "";
          a.tentative = "";
          a.final?.resolve(a.confirmed);
          l.answer = null;
        } else {
          a.confirmed = m.confirmed ?? a.confirmed;
          a.tentative = m.tentative ?? "";
        }
      } else if (m.error) lastError = m.error;
    }
  });
  // Anything it printed besides is kept, so a crash still says something useful.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  // Writing to a helper that has just died must not take Lockin's server with it.
  child.stdin.on("error", () => undefined);
  child.on("close", (code) => {
    l.failed = lastError || stderr.trim().split("\n").at(-1) || `Whisper stopped (exit code ${code ?? "none"}).`;
    l.answer?.final?.reject(new Error(l.failed));
    if (l.idle) clearTimeout(l.idle);
  });
  child.on("error", (err) => {
    l.failed = err.message;
    l.answer?.final?.reject(err);
  });
  return l;
}

function send(l: Listener, message: Record<string, unknown>) {
  l.child.stdin.write(`${JSON.stringify(message)}\n`);
  if (l.idle) clearTimeout(l.idle);
  l.idle = setTimeout(() => {
    if (listener === l) stopLive();
  }, IDLE_MS);
  // An idle helper is no reason to keep Lockin's server running.
  l.idle.unref();
}

/** Starts hearing a new answer; any answer before it is dropped. */
export function startLive(id: string, opts: { model: WhisperChoice; prompt?: string }) {
  const variant = WHISPER_MODELS[opts.model].variant;
  if (listener && (listener.variant !== variant || listener.failed)) stopLive();
  listener ??= startListener(variant);
  const l = listener;
  l.answer?.final?.reject(new Error("Another answer was started."));
  l.answer = { id, confirmed: "", tentative: "", error: null, final: null };
  send(l, { id, start: true, ...(opts.prompt ? { prompt: opts.prompt } : {}) });
}

function current(id: string): { l: Listener; a: Answer } {
  const l = listener;
  if (l?.failed) throw new Error(l.failed);
  const a = l?.answer;
  if (!l || !a || a.id !== id) throw new Error("This answer isn't being heard any more — try again.");
  if (a.error) throw new Error(a.error);
  return { l, a };
}

/** More of the answer's sound (16 kHz mono 16-bit PCM); what's been heard so far comes back. */
export function feedLive(id: string, pcm: Uint8Array): Heard {
  const { l, a } = current(id);
  if (pcm.length) send(l, { id, audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  return { confirmed: a.confirmed, tentative: a.tentative, preparing: l.preparing };
}

/** The answer's last sound; then, once Whisper has heard it to the end, the whole text. */
export function finishLive(id: string, pcm: Uint8Array): Promise<string> {
  feedLive(id, pcm);
  const { l, a } = current(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      a.final = null;
      reject(new Error("Whisper took too long to finish hearing that."));
    }, FINAL_MS);
    a.final = {
      resolve: (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
    send(l, { id, end: true });
  });
}
