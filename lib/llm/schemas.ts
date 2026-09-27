import { z } from "zod";
import { GAP_TYPES, QUESTION_TYPES } from "@/lib/types";

/** Every model response is validated against one of these before it touches the database. */

export const SummarySchema = z.object({
  summaryMd: z.string().min(1),
  figures: z
    .array(
      z.object({
        description: z.string(),
        sourceRef: z.string().describe("slide number or transcript timestamp"),
        why: z.string().describe("what text cannot convey about it"),
      }),
    )
    .default([]),
});
export type Summary = z.infer<typeof SummarySchema>;

export const ConceptListSchema = z.object({
  concepts: z.array(
    z.object({
      /** Set when reusing a concept already on the course list; null when minting a new one. */
      existingId: z.string().nullable().default(null),
      name: z.string().min(1),
      definition: z.string().min(1),
      sourceRef: z.string().nullable().default(null),
    }),
  ),
});
export type ConceptList = z.infer<typeof ConceptListSchema>;

const RubricCriterionSchema = z.object({
  point: z.string().describe("one thing a complete answer states"),
  marks: z.number().min(0).max(10),
});

export const RubricSchema = z.object({
  modelAnswer: z.string().min(1),
  criteria: z.array(RubricCriterionSchema).min(1),
  totalMarks: z.literal(10),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const QuestionSetSchema = z.object({
  questions: z.array(
    z.object({
      stem: z.string().min(1),
      type: z.enum(QUESTION_TYPES),
      conceptIds: z.array(z.string()).min(1),
      rubric: RubricSchema,
    }),
  ),
});
export type QuestionSet = z.infer<typeof QuestionSetSchema>;

export const MarkingSchema = z.object({
  mark: z.number().min(0).max(10),
  criteria: z.array(
    z.object({
      point: z.string(),
      awarded: z.number().min(0),
      outOf: z.number().min(0),
      note: z.string().nullable().default(null),
    }),
  ),
  gaps: z.array(
    z.object({
      /** Must be an id from the concept list supplied in the prompt. This is what
       *  makes recurrence a GROUP BY instead of a fuzzy string match. */
      conceptId: z.string(),
      type: z.enum(GAP_TYPES),
      text: z.string().min(1),
    }),
  ),
});
export type Marking = z.infer<typeof MarkingSchema>;

export const PaperItemsSchema = z.object({
  items: z.array(
    z.object({
      questionNumber: z.string().nullable().default(null),
      stem: z.string().min(1),
      marksAllocated: z.number().nullable().default(null),
      conceptIds: z.array(z.string()).default([]),
    }),
  ),
});
export type PaperItems = z.infer<typeof PaperItemsSchema>;

export const LectureIdentificationSchema = z.object({
  lectures: z.array(
    z.object({
      title: z.string().min(1),
      existingModuleId: z.string().nullable().default(null),
      newModuleTitle: z.string().nullable().default(null),
      deliveredOn: z.string().nullable().default(null),
      durationHours: z.number().positive().default(1),
      fileIndexes: z.array(z.number().int().min(0)).min(1),
      confidence: z.enum(["high", "low"]).default("high"),
      note: z.string().nullable().default(null),
    }),
  ),
  pastPapers: z
    .array(
      z.object({
        fileIndexes: z.array(z.number().int().min(0)).min(1),
        year: z.number().int().nullable().default(null),
        label: z.string().nullable().default(null),
      }),
    )
    .default([]),
  ignored: z
    .array(z.object({ fileIndex: z.number().int().min(0), why: z.string() }))
    .default([]),
});
export type LectureIdentification = z.infer<typeof LectureIdentificationSchema>;
