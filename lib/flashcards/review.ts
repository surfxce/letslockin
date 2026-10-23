import type { Prisma } from "@/lib/generated/prisma";
import { prisma } from "@/lib/db";
import { intervalLabel, LEECH_LAPSES, RATINGS, scheduleCard } from "@/lib/flashcards/schedule";
import { tagList } from "@/lib/flashcards/tags";
import { renderMarkdown } from "@/lib/markdown";
import { lectureDecks, pictured } from "@/lib/slides";

export { LEECH_LAPSES };

/** What a review session covers: one deck, a course, everything; optionally one tag or only hard cards. */
export interface ReviewScope {
  lectureId?: string;
  courseId?: string;
  tag?: string;
  /** Cards you keep getting wrong, whether or not they're due. */
  hard?: boolean;
}

/** Cards that have been forgotten more than once, or keep being marked hard. */
export const HARD_CARDS: Prisma.FlashcardWhereInput = { state: { not: "new" }, OR: [{ lapses: { gte: 2 } }, { ease: { lte: 2.1 } }] };

export function scopeWhere(scope: ReviewScope): Prisma.FlashcardWhereInput {
  return {
    suspended: false,
    ...(scope.lectureId ? { lectureId: scope.lectureId } : {}),
    ...(scope.courseId && !scope.lectureId ? { lecture: { courseId: scope.courseId } } : {}),
    ...(scope.tag ? { tags: { contains: ` ${scope.tag} ` } } : {}),
    ...(scope.hard ? HARD_CARDS : {}),
  };
}

/**
 * The next card to review in a scope: already-seen due cards first, then new ones in
 * the order they were made. A hard-cards session takes cards whether or not they're
 * due, each once (`seen`), unless one comes due again.
 */
export async function nextCard(scope: ReviewScope, seen: string[] = []) {
  const now = new Date();
  const base = scopeWhere(scope);
  const where: Prisma.FlashcardWhereInput = scope.hard
    ? { AND: [base, { OR: [{ id: { notIn: seen } }, { dueAt: { lte: now } }] }] }
    : { ...base, dueAt: { lte: now } };
  const card =
    (await prisma.flashcard.findFirst({ where: { AND: [where, { state: { not: "new" } }] }, orderBy: [{ dueAt: "asc" }, { id: "asc" }] })) ??
    (await prisma.flashcard.findFirst({ where: { AND: [where, { state: "new" }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
  const [remaining, upcoming] = await Promise.all([
    prisma.flashcard.count({ where }),
    scope.hard
      ? null
      : prisma.flashcard.findFirst({ where: { ...base, dueAt: { gt: now } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);
  if (!card) return { card: null, remaining, nextDue: upcoming?.dueAt.toISOString() ?? null };
  const [decks, lecture] = await Promise.all([
    lectureDecks(card.lectureId),
    prisma.lecture.findUnique({ where: { id: card.lectureId }, select: { title: true, course: { select: { code: true } } } }),
  ]);
  const slides = { base: `/api/lectures/${encodeURIComponent(card.lectureId)}/slides`, ranges: pictured(decks) };
  return {
    card: {
      id: card.id,
      lectureId: card.lectureId,
      lecture: lecture ? `${lecture.course.code} · ${lecture.title}` : "",
      version: card.version,
      state: card.state,
      due: card.dueAt <= now,
      problem: card.lapses >= LEECH_LAPSES,
      lapses: card.lapses,
      tags: tagList(card.tags),
      front: renderMarkdown(card.front, slides),
      back: renderMarkdown(card.back, slides),
      intervals: RATINGS.map((r) => intervalLabel(scheduleCard(card, r, now).intervalDays)),
    },
    remaining,
    nextDue: upcoming?.dueAt.toISOString() ?? null,
  };
}

/** How many cards are ready in a scope, and how many of them are hard. */
export async function scopeCounts(scope: ReviewScope) {
  const now = new Date();
  const base = scopeWhere({ ...scope, hard: false });
  const [due, hard, problems] = await Promise.all([
    prisma.flashcard.count({ where: { ...base, dueAt: { lte: now } } }),
    prisma.flashcard.count({ where: { AND: [base, HARD_CARDS] } }),
    prisma.flashcard.count({ where: { ...base, lapses: { gte: LEECH_LAPSES } } }),
  ]);
  return { due, hard, problems };
}

/** Every tag in use, with how many cards (not suspended) carry it. */
export async function tagCounts(where: Prisma.FlashcardWhereInput = {}): Promise<Array<{ tag: string; count: number }>> {
  const rows = await prisma.flashcard.findMany({ where: { ...where, suspended: false, tags: { not: "" } }, select: { tags: true } });
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of tagList(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
