import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { JobCancelled, jobSignal } from "@/lib/llm/cancel";

/**
 * The MLX engine (swift/LockinEngine): runs offline models on Apple Silicon's GPU,
 * faster than llama.cpp there. One process holds the loaded model between requests
 * and answers them one at a time over stdin/stdout, a line of JSON each way. The
 * desktop app ships it and says where it is (LOCKIN_ENGINE); without it — Windows, an
 * Intel Mac, running from the repo — offline models run on llama.cpp as before.
 */

export function enginePath(): string | null {
  const configured = process.env.LOCKIN_ENGINE;
  if (configured && existsSync(configured)) return configured;
  // Built from the repo: `xcodebuild … -derivedDataPath .build-xcode` in swift/LockinEngine.
  const built = path.join(process.cwd(), "swift", "LockinEngine", ".build-xcode", "Build", "Products", "Release", "lockin-engine");
  return existsSync(built) ? built : null;
}

/** Whether offline models can run on MLX here. */
export function mlxAvailable(): boolean {
  return process.platform === "darwin" && process.arch === "arm64" && enginePath() !== null;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  onTokens?: (tokens: number) => void;
}

let engine: { child: ChildProcess; pending: Map<string, Pending> } | null = null;
let nextId = 0;
let idleTimer: NodeJS.Timeout | null = null;
/** An idle engine still holds the model's memory; let it go after a while. */
const IDLE_MS = 5 * 60_000;

function start() {
  const binary = enginePath();
  if (!binary) throw new Error("the MLX engine isn't installed");
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], cwd: path.dirname(binary) });
  const pending = new Map<string, Pending>();
  let buffer = "";
  let log = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: { id?: string; text?: string; error?: string; progress?: { tokens?: number } };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // the libraries' own chatter
      }
      const waiting = message.id ? pending.get(message.id) : undefined;
      if (!waiting) continue;
      if (message.progress) waiting.onTokens?.(message.progress.tokens ?? 0);
      else {
        pending.delete(message.id!);
        if (message.error !== undefined) waiting.reject(new Error(`MLX: ${message.error}`));
        else waiting.resolve(message.text ?? "");
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => (log = (log + chunk.toString("utf8")).slice(-2000)));
  const fail = (why: string) => {
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
    if (engine?.child === child) engine = null;
  };
  child.on("error", (err) => fail(`the MLX engine couldn't start: ${err.message}`));
  child.on("exit", (code, signal) => {
    const tail = log.trim().split("\n").at(-1);
    fail(`the MLX engine stopped (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ""}`);
  });
  engine = { child, pending };
  return engine;
}

/** Ends the engine, freeing the model's memory. Anything it was doing fails. */
export function stopEngine() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  engine?.child.kill("SIGKILL");
  engine = null;
}

/**
 * One request to the engine. With a schema the reply is valid JSON of that shape. A
 * cancelled job ends the engine — the only way to stop a model mid-answer — and the
 * next request starts it again.
 */
export function engineGenerate(request: {
  model: string;
  prompt: string;
  images?: string[];
  schema?: unknown;
  maxTokens: number;
  temperature: number;
  onTokens?: (tokens: number) => void;
}): Promise<string> {
  const signal = jobSignal();
  if (signal?.aborted) return Promise.reject(new JobCancelled());
  if (idleTimer) clearTimeout(idleTimer);
  const { child, pending } = engine ?? start();
  const id = String(++nextId);
  const { onTokens, ...body } = request;
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      stopEngine();
      reject(new JobCancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      if (engine && engine.pending.size === 0) idleTimer = setTimeout(stopEngine, IDLE_MS);
    };
    pending.set(id, {
      onTokens,
      resolve: (text) => {
        done();
        resolve(text);
      },
      reject: (err) => {
        done();
        reject(err);
      },
    });
    child.stdin!.write(JSON.stringify({ id, op: "generate", ...body }) + "\n");
  });
}
