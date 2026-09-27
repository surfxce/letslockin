import { prisma } from "@/lib/db";
import { geometricMean } from "@/lib/engines/geomean";
import type { ConceptMastery } from "@/lib/engines/allocation";

/**
 * A concept's mastery is the geometric mean of every mark it has ever earned —
 * the same function that scores an attempt, applied down the other axis. Score a
 * lecture and you learn you are 6.3/10 at "Lecture 7"; score a concept and you
 * learn what to revise.
 */
export async function conceptMastery(conceptIds: string[]): Promise<ConceptMastery[]> {
  if (conceptIds.length === 0) return [];

  const links = await prisma.questionConcept.findMany({
    where: { conceptId: { in: conceptIds } },
    select: {
      conceptId: true,
      question: {
        select: { responses: { where: { mark: { not: null } }, select: { mark: true } } },
      },
    },
  });

  const marks = new Map<string, number[]>();
  for (const link of links) {
    const list = marks.get(link.conceptId) ?? [];
    for (const r of link.question.responses) if (r.mark !== null) list.push(r.mark);
    marks.set(link.conceptId, list);
  }

  return conceptIds.map((conceptId) => {
    const list = marks.get(conceptId) ?? [];
    return {
      conceptId,
      // Never asked is not the same as answered badly, but both deserve the question.
      mastery: list.length === 0 ? 0 : geometricMean(list),
      // Flat until past papers land; yield is what phase 6 fills in.
      yield: 0.5,
    };
  });
}

/** Two questions per lecture hour — the rule the whole system is sized around. */
export function questionBudget(durationHours: number): number {
  return Math.max(1, Math.round(durationHours * 2));
}
