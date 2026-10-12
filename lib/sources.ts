import { mergeSkipped, stripAims, type Skipped } from "@/lib/parse/aims";

export interface LectureSources {
  transcript: string;
  slidesText?: string;
  /** Aims and objectives slides removed before any model sees the text. */
  skipped: Skipped[];
}

/**
 * The text every prompt about a lecture is built from, whether the worker sends it
 * or the student copies it into a chat. A transcript split across files is joined in
 * upload order; slides alone still make a lecture. Module aims are stripped from the
 * slides here, at prompt time, so the stored text stays complete and the filter can
 * improve without re-importing anything.
 */
export function lectureSources(
  materials: Array<{ kind: string; extractedText: string | null; originalName?: string }>,
): LectureSources {
  const textOf = (kind: string) =>
    materials
      .filter((m) => m.kind === kind && (m.extractedText ?? "").trim())
      .map((m) => m.extractedText!.trim());

  const transcripts = textOf("TRANSCRIPT");
  const decks = textOf("SLIDES").map(stripAims);
  const slidesText = decks.map((d) => d.text).filter(Boolean).join("\n\n") || undefined;
  const skipped = mergeSkipped(decks.flatMap((d) => d.skipped));

  if (transcripts.length) return { transcript: transcripts.join("\n\n"), slidesText, skipped };
  if (slidesText) return { transcript: slidesText, skipped };
  throw new Error("this lecture has no transcript or slides with readable text yet");
}

/** Parsed `Lecture.skipped`, tolerant of nulls and hand edits. */
export function readSkipped(json: string | null): Skipped[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.what === "string").map((s) => ({ what: s.what, where: String(s.where ?? "") }))
      : [];
  } catch {
    return [];
  }
}
