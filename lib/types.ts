// String unions mirroring the "enum" columns in prisma/schema.prisma.
// SQLite has no enum support through Prisma, so these are the constraint.

export const MATERIAL_KINDS = ["TRANSCRIPT", "SLIDES", "FIGURE", "PAST_PAPER"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const QUESTION_TYPES = ["LAQ", "SAQ"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const GAP_TYPES = ["MISSED", "WRONG"] as const;
export type GapType = (typeof GAP_TYPES)[number];

export const JOB_KINDS = [
  "IDENTIFY",
  "SUMMARISE",
  "EXTRACT_CONCEPTS",
  "GENERATE",
  "MARK",
  "PARSE_PAPER",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
