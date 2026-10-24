import { z } from "zod";

export const PaperGuidesSchema = z.object({
  guides: z
    .array(
      z.object({
        key: z.string().min(1).max(20),
        modelAnswer: z.string().trim().min(1).max(8000),
        criteria: z.array(z.object({ point: z.string().trim().min(1).max(1000), marks: z.number().min(0).max(10) })).min(1).max(12),
      }),
    )
    .min(1)
    .max(40),
});
export type PaperGuides = z.infer<typeof PaperGuidesSchema>;

export interface PaperGuideInput {
  lectureTitle: string;
  summary: string;
  concepts: Array<{ id: string; name: string; definition: string }>;
  questions: Array<{ key: string; stem: string; marks: number | null }>;
}

export function paperGuideVars(input: PaperGuideInput): Record<string, string> {
  return {
    lectureTitle: input.lectureTitle,
    summary: input.summary.slice(0, 40_000),
    concepts: input.concepts.length ? input.concepts.map((c) => `- ${c.name} — ${c.definition}`).join("\n") : "(none)",
    questions: input.questions.map((q) => `- ${q.key}${q.marks ? ` (${q.marks} marks)` : ""}: ${q.stem.replace(/\s+/g, " ")}`).join("\n"),
  };
}

/** Criteria scaled to add up to 10, in half marks, as every LAQ's are. */
export function toTen(criteria: Array<{ point: string; marks: number }>): Array<{ point: string; marks: number }> {
  const total = criteria.reduce((n, c) => n + c.marks, 0);
  if (total <= 0) return criteria.map((c) => ({ ...c, marks: Math.round((10 / criteria.length) * 2) / 2 }));
  const scaled = criteria.map((c) => ({ ...c, marks: Math.round(((c.marks * 10) / total) * 2) / 2 }));
  // Rounding can leave it a half off; the biggest point takes the difference.
  const diff = 10 - scaled.reduce((n, c) => n + c.marks, 0);
  if (diff) {
    const i = scaled.reduce((best, c, k) => (c.marks > scaled[best].marks ? k : best), 0);
    scaled[i] = { ...scaled[i], marks: Math.max(0, scaled[i].marks + diff) };
  }
  return scaled;
}
