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
      questions: z.array(
        z.object({
          id: Id,
          stem: z.string(),
          type: z.string(),
          modelAnswer: z.string().nullable(),
          criteria: z.array(z.object({ point: z.string(), marks: z.number().nullable() })),
          /** The marking prompt's variables, all but the answer. */
          markVars: z.object({ questionStem: z.string(), rubric: z.string(), concepts: z.string() }),
        }),
      ),
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

export const SyncRequestSchema = z.object({
  device: z.object({ name: z.string().max(120), app: z.string().max(40) }).optional(),
  sittings: z.array(PhoneSittingSchema).max(500).default([]),
  reviews: z.array(PhoneReviewSchema).max(20_000).default([]),
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
