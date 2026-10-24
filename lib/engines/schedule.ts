/**
 * When to sit a lecture's LAQs again. An expanding ladder: score well and the gap
 * grows, slip and it comes back tomorrow. Simple enough to explain in one line on
 * the onboarding screen, which matters more than squeezing out a better curve.
 */

/** Days until the next sitting, by rung. */
export const LADDER_DAYS = [1, 3, 7, 14, 30] as const;

/** At or above this, climb a rung. */
export const CLIMB_AT = 7;
/** Below this, drop back to the bottom. In between, hold the rung. */
export const RESET_BELOW = 5;

export interface Sitting {
  at: Date;
  /** Geometric mean of the sitting, 0-10. */
  score: number;
}

export interface Review {
  /** Start of the day it is due, or null when there is nothing to sit yet. */
  dueAt: Date | null;
  /** Rung on the ladder after the last sitting, 0-based. */
  rung: number;
  intervalDays: number | null;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export function rungAfter(rung: number, score: number): number {
  if (score >= CLIMB_AT) return Math.min(rung + 1, LADDER_DAYS.length - 1);
  if (score < RESET_BELOW) return 0;
  return rung;
}

/**
 * @param readySince when the lecture first had LAQs to sit; the first sitting is due
 *   the day after, so the summary is read on a different day from the test.
 * @param examDate pulls a late review forward so it lands before the exam.
 */
export function nextReview(opts: {
  sittings: Sitting[];
  readySince: Date | null;
  examDate?: Date | null;
}): Review {
  const sittings = [...opts.sittings].sort((a, b) => a.at.getTime() - b.at.getTime());

  if (sittings.length === 0) {
    if (!opts.readySince) return { dueAt: null, rung: 0, intervalDays: null };
    return { dueAt: addDays(startOfDay(opts.readySince), 1), rung: 0, intervalDays: 1 };
  }

  let rung = 0;
  for (const s of sittings) rung = rungAfter(rung, s.score);

  const last = sittings[sittings.length - 1];
  const interval = LADDER_DAYS[rung];
  let dueAt = addDays(startOfDay(last.at), interval);

  if (opts.examDate) {
    const eve = addDays(startOfDay(opts.examDate), -1);
    if (eve > startOfDay(last.at) && dueAt > eve) dueAt = eve;
  }
  return { dueAt, rung, intervalDays: interval };
}

export type DueState = "overdue" | "today" | "soon" | "later" | "none";

/** For display: how a due date sits relative to today. "soon" is within three days. */
export function dueState(dueAt: Date | null, now = new Date()): { state: DueState; days: number | null } {
  if (!dueAt) return { state: "none", days: null };
  const days = Math.round((startOfDay(dueAt).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (days < 0) return { state: "overdue", days };
  if (days === 0) return { state: "today", days };
  if (days <= 3) return { state: "soon", days };
  return { state: "later", days };
}
