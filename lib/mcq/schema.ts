import { z } from "zod";

/**
 * Multiple-choice questions for exam mode: single best answer among four or five.
 * Written alongside a lecture's LAQs and never shown before an exam.
 */
export const McqSetSchema = z.object({
  questions: z
    .array(
      z
        .object({
          stem: z.string().trim().min(1).max(3000),
          options: z.array(z.string().trim().min(1).max(600)).min(4).max(5),
          answer: z.number().int().min(0).max(4),
          explanation: z.string().trim().min(1).max(2000),
          conceptId: z.string().nullable().default(null),
        })
        .refine((q) => q.answer < q.options.length, "the answer must be one of the options"),
    )
    .min(1)
    .max(12),
});
export type McqSet = z.infer<typeof McqSetSchema>;

export interface McqInput {
  lectureTitle: string;
  /** The lecture's summary, or its source text when there is none. */
  summary: string;
  concepts: Array<{ id: string; name: string; definition: string }>;
  count: number;
}

/** MCQs written per lecture. */
export const MCQS_PER_LECTURE = 5;

export function mcqVars(input: McqInput): Record<string, string> {
  return {
    lectureTitle: input.lectureTitle,
    summary: input.summary,
    count: String(input.count),
    concepts: input.concepts.length
      ? input.concepts.map((c) => `- ${c.id} :: ${c.name} — ${c.definition}`).join("\n")
      : "(none)",
  };
}

/**
 * The options in a new order, with the answer's index following it: models tend to
 * put the right answer in the same place, which a student learns to spot.
 */
export function shuffleOptions(options: string[], answer: number, random: () => number = Math.random) {
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { options: order.map((i) => options[i]), answer: order.indexOf(answer) };
}
