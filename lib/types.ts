// String unions mirroring the "enum" columns in prisma/schema.prisma.
// SQLite has no enum support through Prisma, so these are the constraint.

/** RECORDING is a lecture's audio or video; it is transcribed into a TRANSCRIPT. */
export const MATERIAL_KINDS = ["TRANSCRIPT", "SLIDES", "FIGURE", "PAST_PAPER", "RECORDING"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const QUESTION_TYPES = ["LAQ", "SAQ"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const GAP_TYPES = ["MISSED", "WRONG"] as const;
export type GapType = (typeof GAP_TYPES)[number];

/**
 * PREPARE takes one lecture from files to a summary and a first set of LAQs.
 * GENERATE writes fresh LAQs aimed at weak concepts. MARK marks one answer.
 * DOWNLOAD fetches a local model, and SORT groups a folder's files into lectures while
 * someone waits on the import screen. ASK answers a question about a lecture, breaks a
 * passage down, or says what a left-out part contained, while someone waits on the
 * lecture page. These run alongside the main queue. FLASHCARDS writes independent
 * AK decks in a cloud side lane, or between main jobs when running locally. MCQS writes
 * a lecture's multiple-choice questions for exam mode when it was prepared without them.
 * PAPER splits a past paper into questions. MIXED writes questions that join up a
 * course's related lectures, for exams. TRANSCRIBE turns a lecture's recording into a
 * transcript on its own (PREPARE does it first when it needs to), in a lane of its own
 * that runs with no AI too. VIVA is the examiner's next line in a viva, in the quick lane
 * beside ASK: someone is waiting to hear it.
 */
export const JOB_KINDS = ["PREPARE", "GENERATE", "MARK", "DOWNLOAD", "SORT", "ASK", "FLASHCARDS", "MCQS", "PAPER", "MIXED", "TRANSCRIBE", "VIVA"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The named steps inside a job, in the order they run. Shown to the user. */
export const STAGES = {
  transcribe: "Transcribing the recording",
  slides: "Reading slide pictures",
  vision: "Looking at the slides",
  digest: "Reading & summarising",
  questions: "Writing LAQs",
  marking: "Marking",
  flashcards: "Writing flashcards",
  mcqs: "Writing exam MCQs",
  paper: "Reading a past paper",
  mixed: "Writing questions that link lectures",
  download: "Downloading model",
} as const;
export type Stage = keyof typeof STAGES;

export const ATTEMPT_SOURCES = ["APP", "PASTED", "EXAM", "VIVA"] as const;
export type AttemptSource = (typeof ATTEMPT_SOURCES)[number];
