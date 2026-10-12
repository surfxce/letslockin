// String unions mirroring the "enum" columns in prisma/schema.prisma.
// SQLite has no enum support through Prisma, so these are the constraint.

export const MATERIAL_KINDS = ["TRANSCRIPT", "SLIDES", "FIGURE", "PAST_PAPER"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const QUESTION_TYPES = ["LAQ", "SAQ"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const GAP_TYPES = ["MISSED", "WRONG"] as const;
export type GapType = (typeof GAP_TYPES)[number];

/**
 * PREPARE takes one lecture from files to a summary and a first set of LAQs.
 * GENERATE writes fresh LAQs aimed at weak concepts. MARK marks one answer.
 * DOWNLOAD fetches a local model; it runs alongside the others, not in their queue.
 */
export const JOB_KINDS = ["PREPARE", "GENERATE", "MARK", "DOWNLOAD"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The named steps inside a job, in the order they run. Shown to the user. */
export const STAGES = {
  digest: "Reading & summarising",
  questions: "Writing LAQs",
  marking: "Marking",
  download: "Downloading model",
} as const;
export type Stage = keyof typeof STAGES;

export const ATTEMPT_SOURCES = ["APP", "PASTED"] as const;
export type AttemptSource = (typeof ATTEMPT_SOURCES)[number];
