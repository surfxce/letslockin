import { geometricMean } from "@/lib/engines/geomean";

export interface DrillSitting {
  responses: Array<{
    questionId: string;
    mark: number | null;
    question: { concepts: Array<{ conceptId: string }> };
  }>;
}

/**
 * The lecture's drill score uses the newest marked answer for each concept.
 * A re-drilled weakness replaces its old mark, so an early zero can recover.
 * Questions with no concept links still count under their question ID.
 */
export function drillScores(sittings: DrillSitting[]): number[] {
  const latest = new Map<string, number>();
  const scores: number[] = [];
  for (const sitting of sittings) {
    const current = new Map<string, number[]>();
    for (const response of sitting.responses) {
      if (response.mark === null) continue;
      const concepts = response.question.concepts;
      const keys = concepts.length ? concepts.map((c) => `concept:${c.conceptId}`) : [`question:${response.questionId}`];
      for (const key of keys) {
        const marks = current.get(key) ?? [];
        marks.push(response.mark);
        current.set(key, marks);
      }
    }
    for (const [key, marks] of current) latest.set(key, geometricMean(marks));
    if (latest.size) scores.push(geometricMean([...latest.values()]));
  }
  return scores;
}
