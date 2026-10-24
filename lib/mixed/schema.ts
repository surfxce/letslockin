import type { ConceptRef } from "@/lib/llm/provider";

/** Two (or more) related lectures, for questions that need them all to answer well. */
export interface MixedInput {
  lectures: Array<{ title: string; summary: string; concepts: ConceptRef[] }>;
  /** Words the lectures share most, as a hint to where they meet. */
  shared: string[];
  count: number;
}

const LETTER = (i: number) => String.fromCharCode(65 + i);

/** The lectures' summaries, each with its share of the room. */
export function mixedLectures(input: MixedInput, room = 40_000): string {
  const each = Math.floor(room / Math.max(1, input.lectures.length));
  return input.lectures.map((l, i) => `### Lecture ${LETTER(i)}: ${l.title}\n\n${l.summary.trim().slice(0, each)}`).join("\n\n");
}

export function mixedVars(input: MixedInput, lectures = mixedLectures(input)): Record<string, string> {
  return {
    count: String(input.count),
    lectures,
    concepts: input.lectures
      .map(
        (l, i) =>
          `Lecture ${LETTER(i)} (${l.title}):\n` +
          (l.concepts.length ? l.concepts.map((c) => `- ${c.id} :: ${c.name} — ${c.definition}`).join("\n") : "(none)"),
      )
      .join("\n\n"),
    shared: input.shared.length ? input.shared.join(", ") : "(nothing obvious — find where they meet yourself)",
  };
}

/** A lecture's own questions: not from a past paper, not linking it to other lectures,
 *  and not a stage of a clinical case. */
export const OWN_QUESTIONS = { paperItemId: null, linkedLectureIds: null, caseId: null } as const;

/** Every lecture a linking question needs, the one it is filed under first. */
export function readLinked(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const ids: unknown = JSON.parse(json);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
