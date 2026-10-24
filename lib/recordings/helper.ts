import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { JobCancelled, killOnCancel } from "@/lib/llm/cancel";
import { WHISPER_MODELS, type WhisperChoice } from "@/lib/modes";
import { dataDir } from "@/lib/paths";

/**
 * The transcription helper (swift/LockinWhisper): Whisper on Apple Silicon, and the
 * cutting of a recording's sound into parts. It ships inside the Mac app; in
 * development, a local `swift build -c release` is found too. Null where there is none.
 */
export function whisperHelper(): string | null {
  const candidates = [
    process.env.LOCKIN_WHISPER,
    path.join(process.cwd(), "swift", "LockinWhisper", ".build", "release", "lockin-whisper"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Where Whisper's models are kept once downloaded. */
export function whisperModelsDir(): string {
  return path.join(dataDir(), "whisper");
}

export { WHISPER_MODELS, type WhisperChoice };

export interface HelperProgress {
  stage: string;
  progress: number;
}

/**
 * Runs the helper and returns its final message. It speaks in JSON lines; progress
 * lines go to `onProgress`, anything that isn't JSON is ignored, and an {"error"} line
 * or a failed exit throws. Cancelling the job kills it.
 */
export function runHelper(args: string[], onProgress?: (p: HelperProgress) => void): Promise<Record<string, unknown>> {
  const binary = whisperHelper();
  if (!binary) return Promise.reject(new Error("the transcription helper isn't installed — download the latest Lockin.dmg"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let cancelled = false;
    const unhook = killOnCancel(child, () => (cancelled = true));
    let result: Record<string, unknown> | null = null;
    let error: string | null = null;
    let partial = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message.error === "string") error = message.error;
        else if (typeof message.stage === "string" && typeof message.progress === "number") {
          onProgress?.({ stage: message.stage, progress: message.progress });
        } else result = message;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (err) => {
      unhook();
      reject(err);
    });
    child.on("close", (code) => {
      unhook();
      if (cancelled) return reject(new JobCancelled());
      if (error) return reject(new Error(error));
      if (code !== 0 || !result) {
        const last = stderr.trim().split("\n").pop();
        return reject(new Error(`the transcription helper stopped${last ? `: ${last}` : ` (exit ${code})`}`));
      }
      resolve(result);
    });
  });
}

export interface AudioPart {
  path: string;
  /** Seconds into the recording. */
  start: number;
  duration: number;
}

/** The recording's sound as AAC parts of about `minutes` each, cut where it's quiet. */
export async function cutSound(file: string, outDir: string, minutes: number, onProgress?: (p: HelperProgress) => void) {
  const result = await runHelper(["audio", file, outDir, "--part-minutes", String(minutes)], onProgress);
  const parts = Array.isArray(result.parts) ? (result.parts as AudioPart[]) : [];
  if (!parts.length) throw new Error("the recording's sound couldn't be read");
  return { parts, duration: Number(result.duration) || 0 };
}

/** What was said, with times, by Whisper on this Mac. */
export async function whisper(
  file: string,
  opts: { model: WhisperChoice; prompt?: string },
  onProgress?: (p: HelperProgress) => void,
): Promise<{ segments: Array<{ start: number; text: string }>; duration: number }> {
  const args = ["transcribe", file, "--model", WHISPER_MODELS[opts.model].variant, "--models", whisperModelsDir()];
  if (opts.prompt) args.push("--prompt", opts.prompt);
  const result = await runHelper(args, onProgress);
  const segments = Array.isArray(result.segments) ? (result.segments as Array<{ start: number; text: string }>) : [];
  return { segments: segments.filter((s) => typeof s.text === "string" && Number.isFinite(s.start)), duration: Number(result.duration) || 0 };
}
