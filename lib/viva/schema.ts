import { z } from "zod";

/** Follow-ups the examiner may ask on one question before moving on. */
export const MAX_PROBES = 2;

export interface VivaPlanItem {
  questionId: string;
  lectureId: string;
  /** The answer it became when the viva ended. */
  responseId?: string;
}

export interface VivaTurn {
  role: "examiner" | "student";
  text: string;
  questionId: string;
  at: string;
}

function readJsonArray<T>(json: string | null | undefined, ok: (v: Record<string, unknown>) => boolean): T[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? (parsed.filter((v) => v && typeof v === "object" && ok(v)) as T[]) : [];
  } catch {
    return [];
  }
}

export const readPlan = (json: string | null | undefined) =>
  readJsonArray<VivaPlanItem>(json, (v) => typeof v.questionId === "string" && typeof v.lectureId === "string");

export const readTurns = (json: string | null | undefined) =>
  readJsonArray<VivaTurn>(json, (v) => (v.role === "examiner" || v.role === "student") && typeof v.text === "string");

/** What the examiner does after an answer: ask a follow-up, or move on. */
export const VivaMoveSchema = z.object({
  move: z.enum(["probe", "next"]),
  say: z.string().trim().min(1).max(600),
});
export type VivaMove = z.infer<typeof VivaMoveSchema>;

export interface VivaTurnInput {
  lectureTitle: string;
  question: string;
  modelAnswer: string;
  criteria: Array<{ point: string; marks: number }>;
  /** This question's exchange so far, the question itself first. */
  exchange: Array<{ role: "examiner" | "student"; text: string }>;
  /** Follow-ups still allowed; at 0 the examiner moves on. */
  probesLeft: number;
}

export function vivaVars(input: VivaTurnInput): Record<string, string> {
  return {
    lectureTitle: input.lectureTitle,
    question: input.question,
    modelAnswer: input.modelAnswer,
    criteria: input.criteria.map((c) => `- (${c.marks}) ${c.point}`).join("\n") || "(none)",
    exchange: input.exchange.map((t) => `${t.role === "examiner" ? "Examiner" : "Student"}: ${t.text}`).join("\n\n"),
    probesLeft: String(input.probesLeft),
  };
}

/**
 * One question's exchange as the answer that is marked: everything the student said,
 * with the examiner's follow-ups between, so credit can come from any of it.
 */
export function vivaAnswerText(exchange: Array<{ role: "examiner" | "student"; text: string }>): string {
  const said = exchange.filter((t) => t.role === "student" && t.text.trim());
  if (!said.length) return "";
  // The question itself is the stem being marked against, and the examiner's closing
  // line isn't the student's: only what lies between the first answer and the last.
  let last = exchange.length - 1;
  while (exchange[last].role !== "student") last--;
  const after = exchange.slice(exchange.findIndex((t) => t.role === "student"), last + 1);
  return [
    "(Answered out loud in a viva. The examiner's follow-up questions are shown between the student's answers; credit what the student said in any of them.)",
    ...after.map((t) => `${t.role === "examiner" ? "Examiner" : "Student"}: ${t.text.trim()}`),
  ].join("\n\n");
}
