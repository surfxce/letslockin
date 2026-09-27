export interface ConceptMastery {
  conceptId: string;
  /** Geometric mean of every mark this concept has ever earned, 0-10. 0 = untested. */
  mastery: number;
  /** Exam likelihood, 0-1. Without past papers everything sits at the 0.5 default. */
  yield: number;
}

export interface Allocation {
  conceptId: string;
  count: number;
}

/**
 * How much attention a concept has earned. This is the "ten minus your score" rule,
 * weighted by how likely the thing is to be examined: something you have never been
 * asked about scores a full 10, something you have twice nailed drops out, and a
 * low-yield weakness still clears the 0.5 floor and gets asked once.
 */
export function priority(c: ConceptMastery): number {
  return (10 - c.mastery) * (0.5 + c.yield);
}

/**
 * Turns priorities into an actual question list. The raw formula would ask ten
 * questions about every untouched concept on the first sitting, so the lecture's own
 * budget — two questions per hour — caps it: the highest-priority concepts get a
 * question each, and only once every concept has one does anything get a second.
 */
export function allocate(concepts: ConceptMastery[], budget: number): Allocation[] {
  if (budget <= 0 || concepts.length === 0) return [];

  const ranked = [...concepts]
    .map((c) => ({ conceptId: c.conceptId, weight: priority(c) }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.conceptId.localeCompare(b.conceptId));
  if (ranked.length === 0) return [];

  const counts = new Map<string, number>();
  for (let i = 0; i < budget; i++) {
    const c = ranked[i % ranked.length];
    counts.set(c.conceptId, (counts.get(c.conceptId) ?? 0) + 1);
  }
  return [...counts].map(([conceptId, count]) => ({ conceptId, count }));
}
