/**
 * Client-safe types for the lecture database. Kept apart from lib/views.ts, which
 * queries the database and must never end up in a browser bundle.
 */

/** Where a lecture is up to: empty → todo → queued → working → (summary) → ready → practised, or failed. */
export type LectureStatus = "empty" | "todo" | "queued" | "working" | "failed" | "summary" | "ready" | "practised";

export const STATUS_LABEL: Record<LectureStatus, string> = {
  empty: "No material",
  todo: "Not prepared",
  queued: "Queued",
  working: "Preparing",
  failed: "Failed",
  summary: "Needs LAQs",
  ready: "Ready",
  practised: "Practised",
};

/** Order for sorting and grouping by status: what needs attention first. */
export const STATUS_ORDER: LectureStatus[] = ["failed", "working", "queued", "todo", "summary", "ready", "practised", "empty"];

/** A lecture as the database table shows it. Plain data: it crosses to the client. */
export interface LectureRow {
  id: string;
  title: string;
  /** Position in its course by date — "L4". */
  ordinal: number;
  courseId: string;
  courseCode: string;
  moduleId: string | null;
  moduleTitle: string | null;
  deliveredOn: string;
  durationHours: number;
  hasSummary: boolean;
  laqCount: number;
  fileCount: number;
  sittings: number;
  /** Completed sittings after the first; shown as a superscript on the drill score. */
  drillCount: number;
  lastScore: number | null;
  prevScore: number | null;
  bestScore: number | null;
  lastSatOn: string | null;
  dueAt: string | null;
  status: LectureStatus;
  stageLabel: string | null;
  queuePosition: number | null;
  error: string | null;
}
