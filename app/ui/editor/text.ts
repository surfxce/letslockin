import type { LineKind } from "@/lib/summary-edit";
import { shortDate } from "@/lib/format";

/**
 * The Markdown view's own small tools: which line style the cursor is on, and bold or
 * italic around a selection. Plain string work, like lib/summary-edit.ts, which does the
 * line styles themselves.
 */

const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s|$)/;
const indentOf = (s: string) => s.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/** How deep the list item on row `i` is, counting the items it sits under. */
function listLevel(rows: string[], i: number): number {
  let indent = indentOf(rows[i]);
  let level = 1;
  for (let j = i - 1; j >= 0 && indent > 0; j--) {
    const row = rows[j];
    if (!row.trim()) continue;
    if (ITEM.test(row)) {
      const own = indentOf(row);
      if (own < indent) {
        level++;
        indent = own;
      }
    } else if (indentOf(row) === 0) {
      break; // a paragraph or heading: the list started below it
    }
  }
  return level;
}

/** The style of the line `pos` is on, as the toolbar names them; null for any other kind. */
export function lineKindAt(text: string, pos: number): LineKind | null {
  const rows = text.split("\n");
  const i = text.slice(0, pos).split("\n").length - 1;
  const row = rows[i] ?? "";
  const h = row.match(HEADING);
  if (h) return h[1].length === 2 ? "h2" : h[1].length === 3 ? "h3" : null;
  const item = row.match(ITEM);
  if (!item) return "text";
  if (/\d/.test(item[2])) return null;
  const level = listLevel(rows, i);
  return level <= 3 ? (`bullet${level}` as LineKind) : null;
}

const starsBefore = (text: string, at: number) => {
  let n = 0;
  while (at - n - 1 >= 0 && text[at - n - 1] === "*") n++;
  return n;
};
const starsAfter = (text: string, at: number) => {
  let n = 0;
  while (at + n < text.length && text[at + n] === "*") n++;
  return n;
};
/** Whether `stars` asterisks on each side mean bold (2), italic (1), or both (3). */
const has = (stars: number, marker: string) => (marker === "**" ? stars === 2 || stars === 3 : stars === 1 || stars === 3);

/**
 * Bold (`**`) or italic (`*`) on and off around a selection, the way the formatted view
 * does it. Spaces at the edges of the selection stay outside the marks — `**word **` is
 * not bold in Markdown. Returns the new text and the selection, still round the words.
 */
export function toggleMark(
  text: string,
  start: number,
  end: number,
  marker: "**" | "*",
): { text: string; start: number; end: number } {
  const m = marker.length;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;

  if (start === end) {
    return { text: text.slice(0, start) + marker + marker + text.slice(end), start: start + m, end: start + m };
  }

  // Marks just outside the selection: `**[word]**`.
  const outside = Math.min(starsBefore(text, start), starsAfter(text, end));
  if (has(outside, marker)) {
    return {
      text: text.slice(0, start - m) + text.slice(start, end) + text.slice(end + m),
      start: start - m,
      end: end - m,
    };
  }
  // Marks just inside it: `[**word**]`.
  const inner = text.slice(start, end);
  const inside = Math.min(starsAfter(inner, 0), starsBefore(inner, inner.length));
  if (inner.length > 2 * inside && has(inside, marker)) {
    const words = inner.slice(m, inner.length - m);
    return { text: text.slice(0, start) + words + text.slice(end), start, end: start + words.length };
  }
  return {
    text: text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end),
    start: start + m,
    end: end + m,
  };
}

const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

/**
 * Enter on a dot point starts the next one at the same level, as in the formatted view.
 * On an empty point it steps out a level instead, or ends the list. Null when Enter
 * should just be Enter.
 */
export function continueList(text: string, start: number, end: number): { text: string; start: number; end: number } | null {
  if (start !== end) return null;
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const m = text.slice(from, to).match(LIST_LINE);
  if (!m) return null;
  const [, indent, marker, gap, words] = m;
  const contentAt = from + indent.length + marker.length + gap.length;
  if (start < contentAt) return null;
  if (!words.trim()) {
    // An empty point: out a level, or out of the list.
    const line = indent.length >= 2 ? indent.slice(2) + marker + gap : "";
    const next = text.slice(0, from) + line + text.slice(to);
    const at = from + line.length;
    return { text: next, start: at, end: at };
  }
  const n = marker.match(/^(\d+)([.)])$/);
  const nextMarker = n ? `${Number(n[1]) + 1}${n[2]}` : marker;
  const insert = `\n${indent}${nextMarker} `;
  const at = start + insert.length;
  return { text: text.slice(0, start) + insert + text.slice(start).replace(/^[ \t]+/, ""), start: at, end: at };
}

/** Whether pasted plain text is Markdown worth turning into formatting (an AI chat's reply, say). */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^ {0,3}(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s?|\|.*\|\s*$)/m.test(text) ||
    /\*\*[^*\n]+\*\*|!\[[^\]\n]*\]\([^)\n]+\)|\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  );
}

/** "5 minutes ago", for when a draft was kept. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 45) return "a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate(new Date(at), new Date(now));
}
