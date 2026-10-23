import { readFile } from "node:fs/promises";
import path from "node:path";

import { CloudError } from "@/lib/llm/base";
import { throwIfCancelled, timeoutOrCancel } from "@/lib/llm/cancel";
import { detectAntigravity } from "@/lib/llm/detect";
import { renderPrompt } from "@/lib/llm/prompts";
import { lastLine, runTool } from "@/lib/llm/process";
import type { AudioPart } from "@/lib/recordings/helper";
import { parseTimedLines, type Segment } from "@/lib/recordings/transcript";
import { getApiKey, getSettings } from "@/lib/settings";

/** Gemini listens to audio itself: the AI to use for a recording when it's the one chosen. */
export type Listener =
  | { kind: "api"; key: string; model: string }
  | { kind: "cli"; binary: string; model: string };

const BASE = "https://generativelanguage.googleapis.com";
/** When Settings name no Gemini model for a key, the quick, cheap one that listens well. */
const DEFAULT_MODEL = "gemini-2.5-flash";

/** Gemini, if it is the AI Settings have chosen; otherwise null and Whisper is used. */
export async function geminiListener(): Promise<Listener | null> {
  const s = await getSettings();
  if (s.mode !== "auto") return null;
  if (s.cloudEngine === "api" && s.apiService === "gemini") {
    const key = await getApiKey();
    return key ? { kind: "api", key, model: s.apiModel.trim().replace(/^models\//, "") || DEFAULT_MODEL } : null;
  }
  if (s.cloudEngine === "antigravity") {
    const found = await detectAntigravity();
    return found.found ? { kind: "cli", binary: found.binary, model: s.agyModel.trim() } : null;
  }
  return null;
}

export function listenerLabel(l: Listener): string {
  return l.kind === "api" ? `Gemini · ${l.model}` : `Gemini (${path.basename(l.binary)}) · ${l.model || "auto"}`;
}

async function apiError(res: Response, what: string): Promise<CloudError> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 300);
  try {
    message = JSON.parse(body).error?.message ?? message;
  } catch {
    // Not JSON: the start of the body says enough.
  }
  if (res.status === 400 && /API key/i.test(message)) return new CloudError("Google refused the Gemini API key — check it in Settings");
  return new CloudError(`Gemini couldn't ${what} (${res.status}): ${message || res.statusText}`);
}

/** Sends one part through Google's Files API: no size limit to fit under, and it's gone in two days. */
async function upload(file: string, mime: string, key: string): Promise<{ uri: string; name: string; mimeType: string }> {
  const bytes = await readFile(file);
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: path.basename(file) } }),
    signal: timeoutOrCancel(60_000),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) throw await apiError(start, "take the recording");
  const done = await fetch(url, {
    method: "POST",
    headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
    signal: timeoutOrCancel(15 * 60_000),
  });
  if (!done.ok) throw await apiError(done, "take the recording");
  let info = ((await done.json()) as { file?: { name: string; uri: string; state?: string; mimeType?: string } }).file;
  // Audio is usually ready at once; give it a minute if not.
  for (let i = 0; info && info.state === "PROCESSING" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    throwIfCancelled();
    const res = await fetch(`${BASE}/v1beta/${info.name}`, { headers: { "x-goog-api-key": key }, signal: timeoutOrCancel(30_000) });
    if (!res.ok) throw await apiError(res, "take the recording");
    info = (await res.json()) as typeof info;
  }
  if (!info?.uri || info.state === "FAILED") throw new CloudError("Gemini couldn't read that recording");
  return { uri: info.uri, name: info.name, mimeType: info.mimeType ?? mime };
}

async function forget(name: string, key: string) {
  await fetch(`${BASE}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
}

async function listenApi(part: AudioPart, mime: string, prompt: string, l: Extract<Listener, { kind: "api" }>): Promise<string> {
  const file = await upload(part.path, mime, l.key);
  try {
    const res = await fetch(`${BASE}/v1beta/models/${encodeURIComponent(l.model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": l.key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ file_data: { mime_type: file.mimeType, file_uri: file.uri } }, { text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
      signal: timeoutOrCancel(20 * 60_000),
    });
    if (!res.ok) throw await apiError(res, "transcribe the recording");
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (!text.trim()) {
      throw new CloudError(`Gemini gave no transcript${json.promptFeedback?.blockReason ? ` (${json.promptFeedback.blockReason})` : candidate?.finishReason ? ` (${candidate.finishReason})` : ""}`);
    }
    return text;
  } finally {
    await forget(file.name, l.key);
  }
}

async function listenCli(part: AudioPart, prompt: string, l: Extract<Listener, { kind: "cli" }>): Promise<string> {
  const args = [
    "--output-format",
    "json",
    "--skip-trust",
    ...(l.model ? ["--model", l.model] : []),
    "--include-directories",
    path.dirname(part.path),
    "--prompt",
    `The recording: @${part.path} — listen to all of it, then follow the instructions above.`,
  ];
  const run = await runTool(l.binary, args, prompt, {
    timeoutMs: 20 * 60_000,
    what: "Antigravity",
    install: "Install the Antigravity CLI (antigravity.google/cli) and run `agy` once to sign in.",
  });
  let parsed: { response?: unknown; error?: { message?: string } | string };
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    throw new CloudError(`Antigravity couldn't transcribe: ${lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.code}`}`);
  }
  if (parsed.error || typeof parsed.response !== "string") {
    const why = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "no reply");
    throw new CloudError(`Antigravity couldn't transcribe: ${why}`);
  }
  return parsed.response;
}

/**
 * The recording's parts, heard by Gemini one at a time, as timed segments of the whole
 * recording. A part that comes back with no timed lines fails the lot: better Whisper
 * than a transcript with a hole in it.
 */
export async function listen(
  parts: Array<AudioPart & { mime: string }>,
  opts: { title: string; vocabulary: string[] },
  l: Listener,
  onPart?: (done: number) => void,
): Promise<{ segments: Segment[]; promptVersion: string }> {
  const segments: Segment[] = [];
  let promptVersion = "";
  for (const [i, part] of parts.entries()) {
    const rendered = await renderPrompt("transcribe-audio", {
      title: opts.title,
      part: String(i + 1),
      parts: String(parts.length),
      vocabulary: opts.vocabulary.length ? opts.vocabulary.join(", ") : "(no slides to go by)",
    });
    promptVersion = rendered.version;
    const text = l.kind === "api" ? await listenApi(part, part.mime, rendered.text, l) : await listenCli(part, rendered.text, l);
    throwIfCancelled();
    const heard = parseTimedLines(text, part.start);
    if (!heard.length) throw new CloudError(`Gemini's transcript of part ${i + 1} had no times in it`);
    segments.push(...heard);
    onPart?.(i + 1);
  }
  return { segments, promptVersion };
}
