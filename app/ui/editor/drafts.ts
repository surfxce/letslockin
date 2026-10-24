/**
 * Unsaved summary edits, kept in this browser as they are typed so leaving the page (or
 * the app closing) never loses them. The read view looks for the same key to offer
 * "Continue editing". Storage can be full, blocked or missing; then edits just aren't
 * kept, and nothing else breaks.
 */

export interface SummaryDraft {
  markdown: string;
  /** The summary the edits started from: if it has changed since, the draft is stale. */
  base: string;
  /** When it was kept, in ms since the epoch. */
  at: number;
}

const key = (lectureId: string) => `lockin.summaryDraft.${lectureId}`;

export function readDraft(lectureId: string): SummaryDraft | null {
  try {
    const raw = localStorage.getItem(key(lectureId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SummaryDraft>;
    if (typeof d.markdown !== "string" || typeof d.base !== "string" || typeof d.at !== "number") return null;
    return { markdown: d.markdown, base: d.base, at: d.at };
  } catch {
    return null;
  }
}

export function writeDraft(lectureId: string, draft: SummaryDraft): boolean {
  try {
    localStorage.setItem(key(lectureId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(lectureId: string): void {
  try {
    localStorage.removeItem(key(lectureId));
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/** Two versions of a summary that read the same: trailing blank space doesn't count. */
export const sameSummary = (a: string, b: string) => a.replace(/\s+$/, "") === b.replace(/\s+$/, "");
