import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CloudError } from "@/lib/llm/base";
import { geminiListener, listen, listenerLabel } from "@/lib/recordings/gemini";
import { whisper, whisperHelper } from "@/lib/recordings/helper";
import { wordsFor } from "@/lib/recordings/service";
import { getSettings } from "@/lib/settings";

/** How a spoken answer would be heard here, or null when only typing works. */
export async function speechVia(): Promise<string | null> {
  const gemini = await geminiListener().catch(() => null);
  if (gemini) return listenerLabel(gemini);
  return whisperHelper() ? "Whisper on this Mac" : null;
}

/**
 * A spoken answer (WAV, from the viva page's microphone) as text: Gemini hears it when
 * it's the AI, otherwise Whisper on this Mac — with the lecture's technical words as a
 * guide either way.
 */
export async function hearAnswer(wav: Buffer, lectureId: string): Promise<{ text: string; via: string }> {
  const work = await mkdtemp(path.join(tmpdir(), "lockin-answer-"));
  try {
    const file = path.join(work, "answer.wav");
    await writeFile(file, wav);
    const { title, words } = await wordsFor(lectureId);
    const join = (segments: Array<{ text: string }>) => segments.map((s) => s.text.trim()).filter(Boolean).join(" ");
    const gemini = await geminiListener().catch(() => null);
    if (gemini) {
      try {
        const { segments } = await listen([{ path: file, start: 0, duration: 0, mime: "audio/wav" }], { title, vocabulary: words.slice(0, 150), untimed: true }, gemini);
        return { text: join(segments), via: listenerLabel(gemini) };
      } catch (err) {
        if (!(err instanceof CloudError) || !whisperHelper()) throw err;
      }
    }
    if (!whisperHelper()) throw new Error("Nothing here can turn speech into text — type your answer instead.");
    const { segments } = await whisper(file, { model: (await getSettings()).whisperModel, prompt: words.slice(0, 40).join(", ") });
    return { text: join(segments), via: "Whisper" };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
