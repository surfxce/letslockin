/**
 * The Ask panel's bookkeeping, kept pure so it can be tested: which earlier questions
 * to list, where an answer is filed by default, and how long the wait has been.
 * Client-safe (lib/ask.ts is not: it reaches the database).
 */

/** A question already answered about a lecture: a finished ASK job, or one from this visit. */
export interface AskHistoryItem {
  id: string;
  question: string;
  answer: string;
  /** The summary heading the answer was suggested for, if one fitted. */
  section: string | null;
  /** When it was answered, ISO. */
  at: string;
  /** Who answered, for display. */
  model?: string;
}

/** The longest question sent. Must match MAX_ASK in lib/ask.ts, which the server enforces. */
export const ASK_LIMIT = 1500;

/** Where unsent text in the panel is kept, so leaving the page doesn't lose it. */
export const askDraftKey = (lectureId: string) => `lockin.askDraft.${lectureId}`;
export const askPasteKey = (lectureId: string) => `lockin.askPaste.${lectureId}`;

const words = (s: string) => s.trim().replace(/\s+/g, " ");
const sameKey = (x: { question: string; answer: string }) => `${words(x.question)}\n\n${words(x.answer)}`;
const time = (x: AskHistoryItem) => Date.parse(x.at) || 0;

/**
 * Every question answered so far, newest first and each once. One asked on this visit
 * comes back from the server as a finished job after a refresh, under another id, so
 * a repeat is spotted by its words as well as its id. The answer on screen is left out:
 * it is already showing above the list.
 */
export function mergeHistory(
  lists: AskHistoryItem[][],
  showing?: { question: string; answer: string } | null,
): AskHistoryItem[] {
  const ids = new Set<string>();
  const keys = new Set<string>(showing ? [sameKey(showing)] : []);
  const out: AskHistoryItem[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = sameKey(item);
      if (ids.has(item.id) || keys.has(key)) continue;
      ids.add(item.id);
      keys.add(key);
      out.push(item);
    }
  }
  // Stable: items with the same time (or none) keep the order they came in.
  return out
    .map((item, i) => ({ item, i }))
    .sort((a, b) => time(b.item) - time(a.item) || a.i - b.i)
    .map(({ item }) => item);
}

/** The place picker's value for "End of summary": no heading. Headings are never empty. */
export const END_OF_SUMMARY = "";

/**
 * Which heading an answer goes under: the student's pick while that heading still
 * exists, else the one the AI suggested, else the end of the summary.
 */
export function chosenSection(headings: string[], suggested: string | null | undefined, picked?: string | null): string {
  if (picked != null && (picked === END_OF_SUMMARY || headings.includes(picked))) return picked;
  if (!suggested?.trim()) return END_OF_SUMMARY;
  if (headings.includes(suggested)) return suggested;
  const key = words(suggested).toLowerCase();
  return headings.find((h) => words(h).toLowerCase() === key) ?? END_OF_SUMMARY;
}

/** Time spent waiting for an answer: "12s", then "1m 05s". */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
