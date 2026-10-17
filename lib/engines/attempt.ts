import { prisma } from "@/lib/db";
import { allocate } from "@/lib/engines/allocation";
import { conceptMastery, questionBudget } from "@/lib/engines/mastery";
import { getSettings } from "@/lib/settings";

/**
 * Chooses what this sitting asks about. Concepts are ranked by how much attention
 * they have earned, then the least-used question covering each is taken — so a
 * second attempt on the same lecture is not the same two questions again.
 */
export async function pickQuestions(lectureId: string): Promise<string[]> {
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: lectureId },
    select: { durationHours: true, concepts: { where: { mergedIntoId: null }, select: { id: true } } },
  });

  const questions = await prisma.question.findMany({
    where: { lectureId },
    select: {
      id: true,
      concepts: { select: { conceptId: true } },
      _count: { select: { responses: true } },
    },
  });
  if (questions.length === 0) return [];

  const budget = questionBudget(lecture.durationHours, (await getSettings()).sittingPerHour);
  const mastery = await conceptMastery(lecture.concepts.map((c) => c.id));
  const ranked = allocate(mastery, budget);

  const leastUsedFirst = [...questions].sort(
    (a, b) => a._count.responses - b._count.responses || a.id.localeCompare(b.id),
  );

  const picked: string[] = [];
  const take = (id: string) => {
    if (!picked.includes(id) && picked.length < budget) picked.push(id);
  };

  for (const { conceptId, count } of ranked) {
    const covering = leastUsedFirst.filter((q) => q.concepts.some((c) => c.conceptId === conceptId));
    for (const q of covering.slice(0, count)) take(q.id);
  }
  // Short on coverage — a concept with no question yet, say. Fill the sitting anyway.
  for (const q of leastUsedFirst) take(q.id);

  return picked;
}
