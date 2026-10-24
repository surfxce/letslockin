import { z } from "zod";

/**
 * What the computer and the iPhone app say to each other, version 1. The phone's
 * models (ios/LockinKit/Sources/LockinKit/Snapshot.swift) mirror these; the fixture in
 * ios/LockinKit/Tests/LockinKitTests/Fixtures/snapshot.json is checked against both.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);
const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "a date");

// ---------------------------------------------------------------------------
// Computer → phone

/** A question as the phone asks and marks it. */
const PhoneQuestionSchema = z.object({
  id: Id,
  stem: z.string(),
  type: z.string(),
  modelAnswer: z.string().nullable(),
  criteria: z.array(z.object({ point: z.string(), marks: z.number().nullable() })),
  /** The marking prompt's variables, all but the answer. */
  markVars: z.object({ questionStem: z.string(), rubric: z.string(), concepts: z.string() }),
  /** From a past paper: asked only when the paper is sat, so never in the phone's exams. */
  fromPaper: z.boolean(),
  /** Links lectures: every lecture it needs, this one first. Asked only in exams that
   *  include them all, never in this lecture's sittings. */
  linkedLectureIds: z.array(z.string()).optional(),
});

const FeedbackItem = z.object({ kind: z.string(), text: z.string() });

export const PhoneSnapshotSchema = z.object({
  v: z.literal(1),
  computer: z.string(),
  generatedAt: When,
  /** How the phone may mark answers itself; null when the computer marks them. */
  marking: z
    .object({
      kind: z.enum(["anthropic", "openai"]),
      label: z.string(),
      promptVersion: z.string(),
      prompt: z.string(),
      request: z.object({ url: z.string(), headers: z.record(z.string(), z.string()), body: z.unknown() }),
    })
    .nullable(),
  /** Who marks when the phone doesn't: for the phone to say so. */
  computerMarker: z.string().nullable(),
  /** How the phone may ask the viva examiner's next line itself, as `marking`; null to
   *  ask the computer (the "viva" request) or, away from it, to ask with no follow-ups. */
  viva: z
    .object({
      kind: z.enum(["anthropic", "openai"]),
      label: z.string(),
      promptVersion: z.string(),
      prompt: z.string(),
      request: z.object({ url: z.string(), headers: z.record(z.string(), z.string()), body: z.unknown() }),
    })
    .nullable()
    .optional(),
  /** How the phone may have a handwritten answer typed out itself, as `marking`, by a
   *  model that sees pictures; null to ask the computer (the "handwriting" request). */
  handwriting: z
    .object({
      kind: z.enum(["anthropic", "openai"]),
      label: z.string(),
      promptVersion: z.string(),
      prompt: z.string(),
      request: z.object({ url: z.string(), headers: z.record(z.string(), z.string()), body: z.unknown() }),
    })
    .nullable()
    .optional(),
  courses: z.array(z.object({ id: Id, code: z.string(), title: z.string(), examDate: When.nullable() })),
  lectures: z.array(
    z.object({
      id: Id,
      courseId: Id,
      /** L-number within the course, counted by delivery date. */
      ordinal: z.number().int(),
      title: z.string(),
      module: z.string().nullable(),
      deliveredOn: When,
      /** Rendered as on the computer; pictures are lockin-slide://<lecture>/<n>[?crop=…]. */
      summaryHtml: z.string().nullable(),
      summaryModel: z.string().nullable(),
      /** Every picture the summary and cards show: "<n>" or "<n>?crop=x,y,w,h". */
      images: z.array(z.string()),
      questions: z.array(PhoneQuestionSchema),
      /** The questions a sitting would ask now, as the computer picks them. */
      nextSitting: z.array(Id),
      /** As the lecture table shows them: the drill score, sittings done, next one due. */
      drillScore: z.number().nullable(),
      sittingCount: z.number().int(),
      dueAt: When.nullable(),
    }),
  ),
  sittings: z.array(
    z.object({
      id: Id,
      lectureId: Id,
      sittingDate: When,
      completedAt: When.nullable(),
      score: z.number().nullable(),
      responses: z.array(
        z.object({
          id: Id,
          questionId: Id,
          answerText: z.string(),
          mark: z.number().nullable(),
          /** Waiting in the computer's queue to be marked. */
          pending: z.boolean(),
          feedback: z.array(FeedbackItem),
        }),
      ),
    }),
  ),
  /** Multiple choice for exam mode, answers included: the phone marks them itself. Shown nowhere else. */
  mcqs: z.array(
    z.object({
      id: Id,
      lectureId: Id,
      stem: z.string(),
      options: z.array(z.string()),
      answer: z.number().int(),
      explanation: z.string(),
    }),
  ),
  cards: z.array(
    z.object({
      id: Id,
      lectureId: Id,
      frontHtml: z.string(),
      backHtml: z.string(),
      state: z.string(),
      dueAt: When,
      intervalDays: z.number(),
      ease: z.number(),
      repetitions: z.number().int(),
      lapses: z.number().int(),
      version: z.number().int(),
      createdAt: When,
    }),
  ),
  /** Clinical cases, to run as a viva: each stage's question rides with it, not in its
   *  lecture's questions, so a phone that doesn't know cases never asks one. */
  cases: z
    .array(
      z.object({
        id: Id,
        courseId: Id,
        title: z.string(),
        presentation: z.string(),
        stages: z.array(z.object({ lectureId: Id, kind: z.string(), ask: z.string(), reveal: z.string(), question: PhoneQuestionSchema })),
      }),
    )
    .optional(),
});
export type PhoneSnapshot = z.infer<typeof PhoneSnapshotSchema>;

// ---------------------------------------------------------------------------
// Phone → computer

export const PhoneSittingSchema = z.object({
  id: Id,
  lectureId: Id,
  startedAt: When,
  submittedAt: When,
  responses: z
    .array(
      z.object({
        id: Id,
        questionId: Id,
        answerText: z.string().max(50_000),
        /** A marking the phone made with the API key; checked again before it is saved. */
        marking: z.unknown().optional(),
      }),
    )
    .max(60),
});
export type PhoneSitting = z.infer<typeof PhoneSittingSchema>;

export const PhoneReviewSchema = z.object({
  id: Id,
  cardId: Id,
  /** The card's version the phone reviewed, so a card reviewed on both is counted once. */
  version: z.number().int().min(0),
  rating: z.number().int().min(1).max(4),
  reviewedAt: When,
});
export type PhoneReview = z.infer<typeof PhoneReviewSchema>;

/**
 * An exam sat on the phone: its multiple choice (marked there) and its long answers,
 * sent as a sitting of each lecture they came from, as the computer's own exams do.
 */
export const PhoneExamSchema = z.object({
  id: Id,
  title: z.string().max(200),
  startedAt: When,
  submittedAt: When,
  timeLimitMin: z.number().int().min(1).max(600).nullable(),
  items: z
    .array(
      z.object({
        id: Id,
        kind: z.enum(["MCQ", "LAQ"]),
        mcqId: Id.nullable().optional(),
        choice: z.number().int().min(0).max(4).nullable().optional(),
        questionId: Id.nullable().optional(),
        responseId: Id.nullable().optional(),
      }),
    )
    .max(200),
  sittings: z.array(PhoneSittingSchema).max(60),
});
export type PhoneExam = z.infer<typeof PhoneExamSchema>;

/**
 * A viva held on the phone: everything said, and each question's answers as a sitting
 * of its lecture (source VIVA), as the computer's own vivas end.
 */
export const PhoneVivaSchema = z.object({
  id: Id,
  title: z.string().max(200),
  startedAt: When,
  submittedAt: When,
  plan: z.array(z.object({ questionId: Id, lectureId: Id, responseId: Id.nullable().optional() })).max(40),
  turns: z
    .array(z.object({ role: z.enum(["examiner", "student"]), text: z.string().max(20_000), questionId: z.string().max(64), at: When }))
    .max(400),
  sittings: z.array(PhoneSittingSchema).max(40),
  /** Set when it ran a clinical case: its answers are a case's, not a viva's. */
  caseId: Id.nullable().optional(),
});
export type PhoneViva = z.infer<typeof PhoneVivaSchema>;

export const SyncRequestSchema = z.object({
  device: z.object({ name: z.string().max(120), app: z.string().max(40) }).optional(),
  sittings: z.array(PhoneSittingSchema).max(500).default([]),
  reviews: z.array(PhoneReviewSchema).max(20_000).default([]),
  exams: z.array(PhoneExamSchema).max(200).default([]),
  vivas: z.array(PhoneVivaSchema).max(200).default([]),
});

/** Photos of a handwritten answer (base64 JPEGs, in page order), for this computer's AI to type out. */
export const HandwritingRequestSchema = z.object({
  questionId: Id,
  photos: z.array(z.string().min(100).max(12_000_000)).min(1).max(8),
});

/** The viva examiner's next line, asked of this computer by a phone holding a viva. */
export const VivaTurnRequestSchema = z.object({
  questionId: Id,
  exchange: z.array(z.object({ role: z.enum(["examiner", "student"]), text: z.string().max(20_000) })).min(1).max(20),
  probesLeft: z.number().int().min(0).max(5),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const HelloRequestSchema = z.object({
  device: z.object({ name: z.string().max(120), app: z.string().max(40) }),
});

export const SlideRequestSchema = z.object({
  lectureId: Id,
  /** "<n>" or "<n>?crop=x,y,w,h", as listed in the snapshot. */
  ref: z.string().max(80),
});
