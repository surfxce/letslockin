/**
 * A deck's stored text is one section per page with text ("--- Page 3 ---"). Pages
 * that are pictures have no section until text recognition reads them (lib/ocr.ts).
 * Pure, so it can be tested without either.
 */

const SECTION = /^-{3} (?:Page|Slide) (\d+) -{3}$/m;

/** What a picture-only page records when nothing could be read from it. */
export const NO_WORDS = "(no text — image or diagram only)";
const READ_FROM_IMAGE = "(words read from the slide's picture)";

function sections(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = text.split(new RegExp(SECTION.source, "gm"));
  // split with a capture group: [before, n1, body1, n2, body2, …]
  for (let i = 1; i < parts.length; i += 2) out.set(Number(parts[i]), parts[i + 1].trim());
  return out;
}

/** Pages with no section of their own yet: pictures nobody has read. */
export function blankPages(text: string, pages: number): number[] {
  const have = sections(text);
  return Array.from({ length: pages }, (_, i) => i + 1).filter((n) => !have.has(n));
}

/**
 * Text recognition reads shapes and icons as stray symbols ("@®"); keep only the
 * words, and lines with enough of them to mean something.
 */
export function cleanOcr(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .split(/\s+/)
        .filter((w) => /[a-z0-9]/i.test(w))
        .join(" "),
    )
    .filter((line) => (line.match(/[a-z0-9]/gi) ?? []).length >= 2)
    .join("\n")
    .trim();
}

/** Puts newly read pages into a deck's text, every page in order. */
export function mergePages(text: string, read: Array<{ page: number; text: string }>): string {
  const all = sections(text);
  for (const r of read) all.set(r.page, r.text ? `${READ_FROM_IMAGE}\n${r.text}` : NO_WORDS);
  return [...all]
    .sort((a, b) => a[0] - b[0])
    .map(([n, body]) => `--- Page ${n} ---\n${body}`)
    .join("\n\n");
}
