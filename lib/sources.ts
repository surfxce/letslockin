import { mergeSkipped, stripAims, type Skipped } from "@/lib/parse/aims";

export interface LectureSources {
  transcript: string;
  slidesText?: string;
  /** Aims and objectives slides removed before any model sees the text. */
  skipped: Skipped[];
}

type SourceMaterial = {
  kind: string;
  extractedText: string | null;
  originalName?: string;
  id?: string;
  createdAt?: Date;
  pageCount?: number | null;
};

/** Decks in the order their slides are numbered: as uploaded. */
export function slideOrder(a: SourceMaterial, b: SourceMaterial): number {
  return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || (a.id ?? "").localeCompare(b.id ?? "");
}

const MARKER = /^-{3} (?:Page|Slide) (\d+) -{3}$/gm;

/** How many slides a deck has: as counted at import, else its highest marked slide. */
export function deckPages(m: SourceMaterial): number {
  if (m.pageCount != null) return m.pageCount;
  return Math.max(0, ...[...(m.extractedText ?? "").matchAll(MARKER)].map((x) => Number(x[1])));
}

/**
 * The text every prompt about a lecture is built from, whether the worker sends it
 * or the student copies it into a chat. A transcript split across files is joined in
 * upload order; slides alone still make a lecture. Module aims are stripped from the
 * slides here, at prompt time, so the stored text stays complete and the filter can
 * improve without re-importing anything.
 *
 * Slides are numbered across the lecture ("--- Slide 31 ---" is the first page of a
 * second 30-page deck), the same numbers lib/slides.ts shows pictures for.
 */
export function lectureSources(materials: SourceMaterial[]): LectureSources {
  const transcripts = materials
    .filter((m) => m.kind === "TRANSCRIPT" && (m.extractedText ?? "").trim())
    .map((m) => m.extractedText!.trim());

  const slideDecks = materials.filter((m) => m.kind === "SLIDES").sort(slideOrder);
  let offset = 0;
  const decks = slideDecks.map((m) => {
    const shift = offset;
    offset += deckPages(m);
    const text = (m.extractedText ?? "").trim().replace(MARKER, (_, n: string) => `--- Slide ${shift + Number(n)} ---`);
    return stripAims(text);
  });
  const slidesText = decks.map((d) => d.text).filter(Boolean).join("\n\n") || undefined;
  const skipped = mergeSkipped(decks.flatMap((d) => d.skipped));

  if (transcripts.length) return { transcript: transcripts.join("\n\n"), slidesText, skipped };
  if (slidesText) return { transcript: slidesText, skipped };
  // A deck of pictures: nothing to read as text, but a model that sees the pages can.
  if (offset > 0) {
    return {
      transcript: "(No transcript, and the slides have no selectable text — work from the slides themselves.)",
      skipped,
    };
  }
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

export interface SlideNote {
  slide: number;
  notes: string;
}

/** Parsed `Lecture.slideNotes`, tolerant of nulls and hand edits. */
export function readSlideNotes(json: string | null): SlideNote[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed
          .filter((s) => s && Number.isInteger(s.slide) && typeof s.notes === "string" && s.notes.trim())
          .map((s) => ({ slide: s.slide, notes: s.notes.trim() }))
      : [];
  } catch {
    return [];
  }
}

/** Slide notes as the text a prompt reads in place of the extracted slide text. */
export function slideNotesText(notes: SlideNote[]): string {
  return notes.map((n) => `--- Slide ${n.slide} ---\n${n.notes}`).join("\n\n");
}
