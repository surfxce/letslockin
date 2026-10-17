/**
 * Finding a lecture's glossary terms in the text of its summary, so each can be
 * underlined where it appears. Client-safe and pure; the page does the wrapping.
 */

/** The longest phrase kept as a glossary term — a sentence, not a paragraph. */
export const MAX_TERM = 300;

/** A selection made into a term: one line of words, without the stray spaces and
 *  punctuation a drag tends to pick up at either end. */
export function cleanTerm(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'“‘(\[•·,;:–—-]+/, "")
    .replace(/[\s"'”’)\],;:.!?–—-]+$/, "")
    .slice(0, MAX_TERM)
    .trim();
}

const WORDISH = /[\p{L}\p{N}]/u;

function patternFor(term: string): RegExp | null {
  const t = cleanTerm(term);
  if (!t) return null;
  const body = t
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  // Whole words only at a word's edge: "GLUT2" must not light up inside "GLUT21".
  const before = WORDISH.test(t[0]) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORDISH.test(t[t.length - 1]) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${body}${after}`, "giu");
}

export interface TermRange {
  start: number;
  end: number;
  /** Index into the terms given. */
  index: number;
}

/**
 * Every place a term appears in `text`, case-insensitively, allowing any whitespace
 * between its words. Where two terms overlap the longer wins ("insulin resistance"
 * over "insulin"); the result is in text order and never overlaps.
 */
export function findTermRanges(text: string, terms: string[]): TermRange[] {
  const order = terms
    .map((term, index) => ({ index, pattern: patternFor(term), length: cleanTerm(term).length }))
    .filter((t): t is { index: number; pattern: RegExp; length: number } => !!t.pattern)
    .sort((a, b) => b.length - a.length || a.index - b.index);

  const taken: TermRange[] = [];
  const overlaps = (s: number, e: number) => taken.some((r) => s < r.end && e > r.start);
  for (const { index, pattern } of order) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (end > start && !overlaps(start, end)) taken.push({ start, end, index });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}
