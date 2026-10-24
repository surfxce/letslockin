import { z } from "zod";

import type { ConceptRef } from "@/lib/llm/provider";
import { RubricSchema } from "@/lib/llm/schemas";

/** What a stage of a case asks about, in the order an OSCE station runs. */
export const STAGE_KINDS = ["history", "examination", "investigations", "diagnosis", "management", "mechanism"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_LABEL: Record<StageKind, string> = {
  history: "History",
  examination: "Examination",
  investigations: "Investigations",
  diagnosis: "Diagnosis",
  management: "Management",
  mechanism: "Mechanism",
};

/** A clinical case as the model writes it. */
export const CaseSchema = z.object({
  title: z.string().trim().min(3).max(120),
  presentation: z.string().trim().min(20).max(1500),
  stages: z
    .array(
      z.object({
        kind: z.enum(STAGE_KINDS),
        ask: z.string().trim().min(5).max(600),
        reveal: z.string().trim().min(1).max(2000),
        conceptIds: z.array(z.string()).max(8),
        rubric: RubricSchema,
      }),
    )
    .min(3)
    .max(6),
});
export type CaseDraft = z.infer<typeof CaseSchema>;

export interface CaseInput {
  lectures: Array<{ title: string; summary: string; concepts: ConceptRef[] }>;
  /** Cases already written from these lectures, so the next is a different patient. */
  avoid: string[];
}

export function caseVars(input: CaseInput, room = 40_000): Record<string, string> {
  const each = Math.floor(room / Math.max(1, input.lectures.length));
  return {
    lectures: input.lectures.map((l) => `### ${l.title}\n\n${l.summary.trim().slice(0, each)}`).join("\n\n"),
    concepts: input.lectures
      .map((l) => `${l.title}:\n` + (l.concepts.length ? l.concepts.map((c) => `- ${c.id} :: ${c.name} — ${c.definition}`).join("\n") : "(none)"))
      .join("\n\n"),
    avoid: input.avoid.length ? input.avoid.map((t) => `- ${t}`).join("\n") : "(none yet)",
  };
}

/** One stage of a saved case. Its question holds the rubric and the stem marked. */
export interface CaseStage {
  questionId: string;
  kind: StageKind;
  ask: string;
  reveal: string;
}

export function readStages(json: string | null | undefined): CaseStage[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (s): s is CaseStage =>
            !!s && typeof s.questionId === "string" && typeof s.ask === "string" && typeof s.reveal === "string" && STAGE_KINDS.includes(s.kind),
        )
      : [];
  } catch {
    return [];
  }
}

export function readLectureIds(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A stage as one self-contained question — the case so far, then what it asks — so it
 * is marked, and followed up in the viva, like any LAQ.
 */
export function stageStem(presentation: string, before: Array<{ kind: StageKind; reveal: string }>, stage: { kind: StageKind; ask: string }, n: number, of: number): string {
  const story = [`**Clinical case.** ${presentation}`, ...before.map((b) => `**${STAGE_LABEL[b.kind]}:** ${b.reveal}`)];
  return `${story.join("\n\n")}\n\n**Stage ${n} of ${of} — ${STAGE_LABEL[stage.kind]}.** ${stage.ask}`;
}
