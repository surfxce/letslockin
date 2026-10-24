import { z } from "zod";

/** A mini-lesson as the model writes it. */
export const LessonSchema = z.object({
  explanation: z.string().trim().min(40).max(6000),
  checks: z.array(z.object({ question: z.string().trim().min(5).max(600), answer: z.string().trim().min(1).max(1200) })).min(2).max(5),
});
export type LessonDraft = z.infer<typeof LessonSchema>;

export interface LessonInput {
  conceptName: string;
  conceptDefinition: string;
  lectureTitle: string;
  /** The lecture's summary, which the lesson is written from. */
  summary: string;
  /** What the marker said was missed or wrong about it, most recent first. */
  gaps: Array<{ type: "MISSED" | "WRONG"; text: string }>;
}

export function lessonVars(input: LessonInput, summary = input.summary): Record<string, string> {
  return {
    conceptName: input.conceptName,
    conceptDefinition: input.conceptDefinition,
    lectureTitle: input.lectureTitle,
    summary: summary.slice(0, 30_000),
    gaps: input.gaps.map((g) => `- ${g.type === "WRONG" ? "Got wrong" : "Missed"}: ${g.text}`).join("\n"),
  };
}

export interface LessonCheck {
  question: string;
  answer: string;
}

export function readChecks(json: string | null | undefined): LessonCheck[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((c): c is LessonCheck => !!c && typeof c.question === "string" && typeof c.answer === "string")
      : [];
  } catch {
    return [];
  }
}
