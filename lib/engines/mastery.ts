import { prisma } from "@/lib/db";
import { geometricMean } from "@/lib/engines/geomean";
import type { ConceptMastery } from "@/lib/engines/allocation";

/**
 * The latest completed sitting for each concept controls its next allocation. A weak
 * concept keeps getting questions until its newer answers demonstrate recovery;
 * its first zero cannot trap it forever.
 */
export async function conceptMastery(conceptIds: string[]): Promise<ConceptMastery[]> {
  if (conceptIds.length === 0) return [];

  const links = await prisma.questionConcept.findMany({
    where: { conceptId: { in: conceptIds } },
    select: {
      conceptId: true,
      question: {
        select: {
          responses: {
            where: { mark: { not: null }, attempt: { geometricMean: { not: null } } },
            select: {
              mark: true,
              attemptId: true,
              attempt: { select: { completedAt: true, sittingDate: true } },
            },
          },
        },
      },
    },
  });

  const bySitting = new Map<string, { conceptId: string; marks: number[]; at: number }>();
  for (const link of links) {
    for (const r of link.question.responses) {
      if (r.mark === null) continue;
      const key = `${link.conceptId}:${r.attemptId}`;
      const current = bySitting.get(key) ?? {
        conceptId: link.conceptId,
        marks: [],
        at: (r.attempt.completedAt ?? r.attempt.sittingDate).getTime(),
      };
      current.marks.push(r.mark);
      bySitting.set(key, current);
    }
  }

  const latest = new Map<string, { mark: number; at: number }>();
  for (const sitting of bySitting.values()) {
    const previous = latest.get(sitting.conceptId);
    if (!previous || sitting.at >= previous.at) {
      latest.set(sitting.conceptId, { mark: geometricMean(sitting.marks), at: sitting.at });
    }
  }

  return conceptIds.map((conceptId) => {
    const mark = latest.get(conceptId);
    return {
      conceptId,
      // Never asked is not the same as answered badly, but both deserve the question.
      mastery: mark?.mark ?? 0,
      seen: !!mark,
      // Flat until past papers land; yield is what phase 6 fills in.
      yield: 0.5,
    };
  });
}

/** Questions per lecture hour — two unless Settings says otherwise — is the rule the
 *  whole system is sized around. */
export function questionBudget(durationHours: number, perHour = 2): number {
  return Math.max(1, Math.round(durationHours * perHour));
}
