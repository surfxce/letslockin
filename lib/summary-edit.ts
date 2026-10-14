/**
 * Small, careful edits to a lecture summary's Markdown: filing an answer under the
 * right heading, a break-down under the line it explains, and turning lines into
 * headings or dot points at a chosen level. Plain string work, client-safe, so the
 * editor and the server make exactly the same change.
 */

/** Inline Markdown reduced to its words: what a reader sees, for matching. */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

interface Line {
  text: string;
  /** Inside a fenced code block, where a "#" is not a heading. */
  code: boolean;
}

function lines(md: string): Line[] {
  let inFence = false;
  return md.split("\n").map((text) => {
    if (FENCE.test(text)) {
      inFence = !inFence;
      return { text, code: true };
    }
    return { text, code: inFence };
  });
}

function headingOf(line: Line): { level: number; text: string } | null {
  if (line.code) return null;
  const m = line.text.match(HEADING);
  return m ? { level: m[1].length, text: plainInline(m[2]) } : null;
}

/** The summary's headings, as a reader sees them, in order and without repeats. */
export function summaryHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of lines(md)) {
    const h = headingOf(line);
    if (h && h.text && !out.includes(h.text)) out.push(h.text);
  }
  return out;
}

/** A heading as given back by a model: the exact text, or a near miss in case or spacing. */
export function matchHeading(md: string, wanted: string | null | undefined): string | null {
  if (!wanted) return null;
  const key = plainInline(wanted).toLowerCase();
  return summaryHeadings(md).find((h) => h.toLowerCase() === key) ?? null;
}

function join(before: string, block: string, after: string): string {
  const head = before.replace(/\s+$/, "");
  const tail = after.replace(/^\s*\n/, "");
  return [head, block.trim(), tail].filter((part) => part.length > 0).join("\n\n").replace(/\n*$/, "\n");
}

/**
 * Adds a block at the end of the section under `section` — before the next heading of
 * the same or a higher level — or at the end of the summary when there is no such
 * section.
 */
export function insertIntoSection(md: string, section: string | null | undefined, block: string): string {
  const all = lines(md);
  const key = section ? plainInline(section).toLowerCase() : null;
  const start = key ? all.findIndex((l) => headingOf(l)?.text.toLowerCase() === key) : -1;
  if (start === -1) return join(md, block, "");
  const level = headingOf(all[start])!.level;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    const h = headingOf(all[i]);
    if (h && h.level <= level) {
      end = i;
      break;
    }
  }
  const text = all.map((l) => l.text);
  return join(text.slice(0, end).join("\n"), block, text.slice(end).join("\n"));
}

/** Adds a block at the top of the summary, after a leading title heading if it has one. */
export function insertAtStart(md: string, block: string): string {
  const all = lines(md);
  const first = all.findIndex((l) => l.text.trim());
  const h = first === -1 ? null : headingOf(all[first]);
  const text = all.map((l) => l.text);
  if (h && h.level === 1) return join(text.slice(0, first + 1).join("\n"), block, text.slice(first + 1).join("\n"));
  return join("", block, md);
}

const indentOf = (s: string) => s.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/**
 * Markdown as dot points one level under an item indented by `indent`: a list keeps
 * its own nesting, and each paragraph of anything else becomes one dot point.
 */
export function asChildPoints(block: string, indent: number): string {
  const pad = " ".repeat(indent);
  const rows = block.trim().split("\n");
  if (rows.every((r) => !r.trim() || LIST_ITEM.test(r) || /^\s{2,}\S/.test(r))) {
    const base = Math.min(...rows.filter((r) => r.trim()).map(indentOf));
    return rows
      .filter((r) => r.trim())
      .map((r) => pad + r.slice(Math.min(base, indentOf(r))))
      .join("\n");
  }
  return block
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/^[-*+]\s+/, ""))
    .map((p) => `${pad}- ${p}`)
    .join("\n");
}

function findLine(all: Line[], needle: string): number {
  const norm = (s: string) => plainInline(s).toLowerCase();
  const tries: string[] = [];
  const whole = norm(needle);
  if (whole) tries.push(whole);
  const firstLine = norm(needle.split("\n").find((l) => l.trim()) ?? "");
  if (firstLine && firstLine !== whole) tries.push(firstLine);
  const sentence = firstLine.split(/(?<=[.!?;:])\s/)[0];
  if (sentence && sentence !== firstLine) tries.push(sentence);
  const words = firstLine.split(" ");
  if (words.length > 6) tries.push(words.slice(0, 6).join(" "));
  for (const t of tries) {
    const i = all.findIndex((l) => !l.code && norm(l.text).includes(t));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Adds a block right under the line that contains `needle` (text the student selected
 * in the rendered summary): as dot points nested under it when that line is a dot
 * point, else as a paragraph after its paragraph. At the end when the text can't be
 * found — the selection may have crossed a slide caption or a table.
 */
export function insertUnder(md: string, needle: string, block: string): string {
  const all = lines(md);
  const at = findLine(all, needle);
  const text = all.map((l) => l.text);
  if (at === -1) return join(md, block, "");

  const item = text[at].match(LIST_ITEM);
  if (item) {
    const indent = indentOf(item[1]);
    const childIndent = indent + item[2].length + item[3].length;
    // The item's own lines and its nested points end where something sits at its level or above.
    let end = at + 1;
    while (end < text.length) {
      const row = text[end];
      if (row.trim() && indentOf(row) <= indent) break;
      if (!row.trim()) {
        const next = text.slice(end + 1).find((r) => r.trim());
        if (next === undefined || indentOf(next) <= indent) break;
      }
      end++;
    }
    const children = asChildPoints(block, childIndent);
    return [...text.slice(0, end), children, ...text.slice(end)].join("\n");
  }

  let end = at + 1;
  while (end < text.length && text[end].trim() && !HEADING.test(text[end]) && !LIST_ITEM.test(text[end])) end++;
  // A heading or a slide picture is followed by its section; a paragraph by its own text.
  if (HEADING.test(text[at])) end = at + 1;
  return join(text.slice(0, end).join("\n"), block, text.slice(end).join("\n"));
}

/** How a question and its answer read once filed in the summary. */
export function formatAnswer(question: string, answer: string): string {
  const q = question.trim().replace(/\s+/g, " ");
  return `**${q.replace(/\*\*/g, "")}**\n\n${answer.trim()}`;
}

/** A left-out part put back: aims and objectives at the top, anything else at the end. */
export function addLeftOut(md: string, what: string, about: string): string {
  const { block, atStart } = leftOutInsert(what, about);
  return atStart ? insertAtStart(md, block) : insertIntoSection(md, null, block);
}

/** A left-out part as it goes back into a summary, and whether it goes at the top. */
export function leftOutInsert(what: string, about: string): { block: string; atStart: boolean } {
  return {
    block: `## ${what.trim()}\n\n${about.trim()}`,
    atStart: /\b(aims?|objectives?|outcomes?|goals?)\b/i.test(what),
  };
}

// ---------------------------------------------------------------------------
// The Markdown editor's line tools.

export type LineKind = "text" | "h2" | "h3" | "bullet1" | "bullet2" | "bullet3";

const PREFIX: Record<LineKind, string> = {
  text: "",
  h2: "## ",
  h3: "### ",
  bullet1: "- ",
  bullet2: "  - ",
  bullet3: "    - ",
};

/** The lines a selection touches, as [first, last] line indexes. */
function touched(text: string, start: number, end: number): [number, number] {
  const first = text.slice(0, start).split("\n").length - 1;
  const last = text.slice(0, Math.max(start, end > start && text[end - 1] === "\n" ? end - 1 : end)).split("\n").length - 1;
  return [first, last];
}

function lineStart(rows: string[], i: number): number {
  return rows.slice(0, i).reduce((n, r) => n + r.length + 1, 0);
}

/** Strips a line's heading or list marker, keeping its words. */
function bare(row: string): string {
  const h = row.match(HEADING);
  if (h) return h[2];
  const li = row.match(LIST_ITEM);
  if (li) return li[4];
  return row.replace(/^\s+/, "");
}

/**
 * Turns every line a selection touches into one kind: plain text, a heading, or a dot
 * point at level 1, 2 or 3. Blank lines stay blank. Returns the new text and a
 * selection covering the changed lines.
 */
export function setLineKind(
  text: string,
  start: number,
  end: number,
  kind: LineKind,
): { text: string; start: number; end: number } {
  const rows = text.split("\n");
  const [first, last] = touched(text, start, end);
  for (let i = first; i <= last; i++) {
    if (!rows[i].trim()) continue;
    rows[i] = PREFIX[kind] + bare(rows[i]);
  }
  const out = rows.join("\n");
  const from = lineStart(rows, first);
  return { text: out, start: from, end: lineStart(rows, last) + rows[last].length };
}

/**
 * Tab and Shift+Tab: moves the dot points a selection touches one level in or out
 * (two spaces). Lines that are not dot points are left alone.
 */
export function shiftLines(
  text: string,
  start: number,
  end: number,
  direction: 1 | -1,
): { text: string; start: number; end: number } {
  const rows = text.split("\n");
  const [first, last] = touched(text, start, end);
  let delta0 = 0;
  let delta = 0;
  for (let i = first; i <= last; i++) {
    if (!LIST_ITEM.test(rows[i])) continue;
    const before = rows[i].length;
    rows[i] = direction === 1 ? `  ${rows[i]}` : rows[i].replace(/^ {1,2}/, "");
    const change = rows[i].length - before;
    if (i === first) delta0 = change;
    delta += change;
  }
  const lineFrom = lineStart(rows, first);
  return {
    text: rows.join("\n"),
    start: Math.max(lineFrom, start + delta0),
    end: Math.max(lineFrom, end + delta),
  };
}
