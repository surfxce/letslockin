/**
 * The "Left out" list on a lecture page: parts that are not lecture content (aims,
 * objectives, housekeeping), each of which the student can read and put back. What a
 * part says and what clicking it does follow from what is known about it. Client-safe.
 */

export interface LeftOutPart {
  what: string;
  where: string;
  about?: string;
  added?: boolean;
}

/** What a click on a part means right now. */
export type LeftOutAction =
  /** Its words are known: put them into the summary. */
  | "add"
  /** Already put back: nothing to do but say so. */
  | "added"
  /** Not read yet: ask the AI what it said. */
  | "ask"
  /** Adding or asking already: a second click does nothing. */
  | "busy"
  /** Not read, and nothing can read it (copy & paste mode, or the AI couldn't find it). */
  | "none";

export function leftOutAction(
  part: { about?: string | null; added?: boolean },
  ctx: { canAsk: boolean; busy: boolean; notFound: boolean },
): LeftOutAction {
  if (ctx.busy) return "busy";
  if (part.added) return "added";
  if (part.about?.trim()) return "add";
  if (ctx.notFound || !ctx.canAsk) return "none";
  return "ask";
}

/** The faint line under a part's paragraph, saying what a click will do. */
export function leftOutHint(action: LeftOutAction, ctx: { canAsk: boolean; notFound: boolean }): string | null {
  switch (action) {
    case "add":
      return "Click to add it to your summary";
    case "added":
      return "✓ In your summary";
    case "ask":
      return "Click to find out what it said";
    case "none":
      // A part the AI looked for and couldn't find has its own note instead.
      return ctx.notFound || ctx.canAsk ? null : "Prepare this lecture again with AI to see what it said.";
    case "busy":
      return null;
  }
}

/** On a touch screen the first tap only opens the card; this button does the rest. */
export function leftOutButton(action: LeftOutAction): string | null {
  return action === "add" ? "Add to summary" : action === "ask" ? "Find out what it said" : null;
}

/** "Module aims · slide 2", or just the label when where it was isn't known. */
export function partLabel(part: { what: string; where: string }): string {
  const where = part.where.trim();
  return where ? `${part.what} · ${where}` : part.what;
}

export function partsLabel(n: number): string {
  return `${n} part${n === 1 ? "" : "s"}`;
}

/** A stable key for each part. Two parts can share a label, so repeats are counted. */
export function partKeys(parts: Array<{ what: string; where: string }>): string[] {
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const base = `${p.what}\u0000${p.where}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}\u0000${n}` : base;
  });
}

/** "8s", "1m 05s" — how long the AI has been reading. */
export function waited(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where a card of `size` goes for a part's chip (viewport pixels): below it, lined up
 * with its left edge — above it when there is room there and not below — and always
 * inside the window, `margin` from its edges.
 */
export function placeCard(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 6, margin = 8 }: { gap?: number; margin?: number } = {},
): { top: number; left: number; side: "below" | "above" } {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const side = size.height <= below || above <= below ? "below" : "above";
  const ideal = side === "below" ? anchor.bottom + gap : anchor.top - gap - size.height;
  return {
    top: Math.round(clamp(ideal, margin, viewport.height - margin - size.height)),
    left: Math.round(clamp(anchor.left, margin, viewport.width - margin - size.width)),
    side,
  };
}

/** `value` kept between `low` and `high`; `low` wins when there is no room for both. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
