import { ASK_LIMIT } from "@/lib/ask-history";
import { findTermRanges } from "@/lib/glossary";

/**
 * The bookkeeping behind selecting a passage of a summary to have it broken down and
 * underlining glossary terms in it: where a floating card goes, which pieces of which
 * text nodes a term covers, and a few small text chores. Pure, so it is tested
 * without a page; app/ui/SelectionTools.tsx and app/ui/Glossary.tsx do the DOM work.
 */

/**
 * The longest passage that can be broken down. Must match MAX_ASK in lib/ask.ts, which
 * the server enforces but which can't be imported here: it reads the database.
 */
export const SELECTION_LIMIT = ASK_LIMIT;

// ---------------------------------------------------------------------------
// Placing a floating card next to what it is about

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "above" | "below";

/**
 * Where a card of `size` goes beside `anchor` (both in viewport pixels): on the side
 * asked for when it fits, else on the other side when that fits, else on whichever
 * has more room — then kept inside the viewport, `margin` from its edges, and
 * centred on the anchor as far as the edges allow.
 */
export function placeNear(
  anchor: Rect,
  size: Size,
  viewport: Size,
  { prefer, gap = 8, margin = 8 }: { prefer: Side; gap?: number; margin?: number },
): { top: number; left: number; side: Side } {
  const room: Record<Side, number> = {
    above: anchor.top - gap - margin,
    below: viewport.height - anchor.bottom - gap - margin,
  };
  const other: Side = prefer === "above" ? "below" : "above";
  const side: Side =
    size.height <= room[prefer] ? prefer : size.height <= room[other] ? other : room[prefer] >= room[other] ? prefer : other;

  const ideal = side === "above" ? anchor.top - gap - size.height : anchor.bottom + gap;
  const top = clamp(ideal, margin, viewport.height - margin - size.height);
  const centre = (anchor.left + anchor.right) / 2;
  const left = clamp(centre - size.width / 2, margin, viewport.width - margin - size.width);
  return { top: Math.round(top), left: Math.round(left), side };
}

/** `value` kept between `low` and `high`; `low` wins when there is no room for both. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

// ---------------------------------------------------------------------------
// Terms across text nodes

/** One text node's share of a range over several nodes' joined text. */
export interface Piece {
  /** Index of the text node. */
  node: number;
  /** Offsets within that node. */
  start: number;
  end: number;
  /** Index of the range this piece belongs to. */
  range: number;
}

/**
 * Splits ranges over the joined text of consecutive nodes (whose lengths are given)
 * into a piece per node they touch. "**insulin** secretion" is two text nodes, so
 * the term "insulin secretion" is two pieces with one range number. Ranges must be in
 * order and not overlap, as findTermRanges gives them; empty pieces are left out.
 */
export function splitRanges(lengths: number[], ranges: Array<{ start: number; end: number }>): Piece[] {
  const pieces: Piece[] = [];
  let node = 0;
  let nodeStart = 0;
  ranges.forEach((r, range) => {
    // Nodes wholly before this range are done with; ranges come in order, so never revisit them.
    while (node < lengths.length && nodeStart + lengths[node] <= r.start) {
      nodeStart += lengths[node];
      node++;
    }
    let n = node;
    let at = nodeStart;
    while (n < lengths.length && at < r.end) {
      const start = Math.max(r.start, at) - at;
      const end = Math.min(r.end, at + lengths[n]) - at;
      if (end > start) pieces.push({ node: n, start, end, range });
      at += lengths[n];
      n++;
    }
  });
  return pieces;
}

export interface TermPiece extends Piece {
  /** Index into the terms given. */
  term: number;
}

/**
 * Where glossary terms appear in a summary's text nodes, piece by piece. `texts` are
 * the nodes' contents in document order and `blocks` which block each sits in (a
 * paragraph, a list item, a heading…): a term never runs on from one block into the
 * next, so "insulin" ending one dot point and "resistance" starting the next is not
 * "insulin resistance". Range numbers count matches across the whole summary.
 */
export function termPieces(texts: string[], blocks: number[], terms: string[]): TermPiece[] {
  const out: TermPiece[] = [];
  let matches = 0;
  let from = 0;
  while (from < texts.length) {
    let to = from + 1;
    while (to < texts.length && blocks[to] === blocks[from]) to++;
    const run = texts.slice(from, to);
    const ranges = findTermRanges(run.join(""), terms);
    for (const p of splitRanges(
      run.map((t) => t.length),
      ranges,
    )) {
      out.push({ ...p, node: from + p.node, range: matches + p.range, term: ranges[p.range].index });
    }
    matches += ranges.length;
    from = to;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small text chores

/** Whitespace, line breaks included, as single spaces: a selection as one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A long passage cut to `max` characters in the middle, so both its ends still show. */
export function shorten(text: string, max: number): string {
  const t = oneLine(text);
  if (t.length <= max) return t;
  const head = Math.ceil((max - 1) * 0.7);
  const tail = max - 1 - head;
  return `${t.slice(0, head).trimEnd()}…${tail > 0 ? t.slice(t.length - tail).trimStart() : ""}`;
}

/** "8s", "1m 05s": how long an answer has been coming. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * A pasted explanation kept for the passage it explains, newest first, so a paste
 * survives leaving the page and coming back to the same selection; only the last
 * `keep` passages are remembered. An empty text forgets the passage.
 */
export function rememberPaste(
  saved: Array<[string, string]>,
  passage: string,
  text: string,
  keep = 12,
): Array<[string, string]> {
  const rest = saved.filter(([p]) => p !== passage);
  return (text ? [[passage, text] as [string, string], ...rest] : rest).slice(0, keep);
}

/** Reads what rememberPaste kept, from storage that may hold anything. */
export function readPastes(raw: string | null): Array<[string, string]> {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The glossary as shown, a step ahead of the server

/**
 * The page's glossary with terms just added or removed in this window, which the
 * server's copy catches up with a moment later. The server's entry wins once it has
 * one; a term added twice (in any case) shows once.
 */
export function mergeGlossary<T extends { id: string; term: string }>(
  server: T[],
  added: T[],
  removed: ReadonlySet<string>,
): T[] {
  const shown = server.filter((e) => !removed.has(e.id));
  const ids = new Set(shown.map((e) => e.id));
  const words = new Set(shown.map((e) => e.term.toLowerCase()));
  for (const e of added) {
    if (removed.has(e.id) || ids.has(e.id) || words.has(e.term.toLowerCase())) continue;
    shown.push(e);
    ids.add(e.id);
    words.add(e.term.toLowerCase());
  }
  return shown;
}
