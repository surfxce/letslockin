import { prisma } from "@/lib/db";
import { conceptMastery } from "@/lib/engines/mastery";
import { MISTAKE_ORIGIN } from "@/lib/flashcards/mistakes";
import { enqueue } from "@/lib/jobs";
import { throwIfCancelled } from "@/lib/llm/cancel";
import type { LlmProvider } from "@/lib/llm/provider";
import { readChecks } from "@/lib/lessons/schema";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

/** Marked answers with a gap on a concept before it earns a lesson. */
export const LESSON_AFTER = 2;
/** Lessons waiting at once; past this, the next waits for one to be done. */
const MAX_OPEN = 5;
/** Gaps older than this no longer count. */
const WINDOW_DAYS = 120;
/** A concept marked this well since is learnt: no lesson. */
const RECOVERED = 7;

export interface WeakSpot {
  conceptId: string;
  name: string;
  lectureId: string | null;
  lectureTitle: string | null;
  courseId: string | null;
  /** Different marked answers with a gap on it. */
  answers: number;
  latest: Date;
  /** What the marker said, most recent first. */
  gaps: Array<{ type: "MISSED" | "WRONG"; text: string }>;
}

/** Concepts that keep coming up missed or wrong, and haven't been put right since. */
export async function weakSpots(now = new Date()): Promise<WeakSpot[]> {
  const gaps = await prisma.gap.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - WINDOW_DAYS * 86_400_000) }, concept: { mergedIntoId: null } },
    orderBy: { createdAt: "desc" },
    select: {
      conceptId: true,
      responseId: true,
      type: true,
      text: true,
      createdAt: true,
      concept: { select: { name: true, lectureId: true, lecture: { select: { title: true, courseId: true } } } },
    },
  });
  const spots = new Map<string, WeakSpot & { responses: Set<string> }>();
  for (const g of gaps) {
    const spot =
      spots.get(g.conceptId) ??
      ({
        conceptId: g.conceptId,
        name: g.concept.name,
        lectureId: g.concept.lectureId,
        lectureTitle: g.concept.lecture?.title ?? null,
        courseId: g.concept.lecture?.courseId ?? null,
        answers: 0,
        latest: g.createdAt,
        gaps: [],
        responses: new Set<string>(),
      } satisfies WeakSpot & { responses: Set<string> });
    spot.responses.add(g.responseId);
    if (spot.gaps.length < 8) spot.gaps.push({ type: g.type === "WRONG" ? "WRONG" : "MISSED", text: g.text });
    spots.set(g.conceptId, spot);
  }
  const candidates = [...spots.values()].filter((s) => s.responses.size >= LESSON_AFTER);
  const mastery = new Map((await conceptMastery(candidates.map((c) => c.conceptId))).map((m) => [m.conceptId, m]));
  return candidates
    .filter((s) => {
      const m = mastery.get(s.conceptId);
      return !(m?.seen && m.mastery >= RECOVERED);
    })
    .map(({ responses, ...s }) => ({ ...s, answers: responses.size }))
    .sort((a, b) => b.answers - a.answers || b.latest.getTime() - a.latest.getTime());
}

/**
 * Queues a lesson for each weak spot without one — or whose last lesson came before it
 * was missed again — up to a few waiting at once. Runs after answers are marked.
 */
export async function queueLessons(): Promise<number> {
  if (!usesAi((await getSettings()).mode)) return 0;
  const spots = await weakSpots();
  if (!spots.length) return 0;
  const [lessons, open, queued] = await Promise.all([
    prisma.lesson.findMany({
      where: { conceptId: { in: spots.map((s) => s.conceptId) } },
      orderBy: { createdAt: "desc" },
      select: { conceptId: true, gapCount: true, doneAt: true },
    }),
    prisma.lesson.count({ where: { doneAt: null } }),
    lessonsBeingWritten(),
  ]);
  const latest = new Map<string, (typeof lessons)[number]>();
  for (const l of lessons) if (!latest.has(l.conceptId)) latest.set(l.conceptId, l);
  let waiting = open + queued.size;
  let added = 0;
  for (const spot of spots) {
    if (waiting >= MAX_OPEN) break;
    const last = latest.get(spot.conceptId);
    if (queued.has(spot.conceptId) || (last && (!last.doneAt || last.gapCount >= spot.answers))) continue;
    await enqueue("LESSON", { conceptId: spot.conceptId }, spot.lectureId);
    waiting++;
    added++;
  }
  return added;
}

/** Writes the lesson for one weak spot, from its lecture's summary and what was missed. */
export async function writeLesson(conceptId: string, provider: LlmProvider) {
  const spot = (await weakSpots()).find((s) => s.conceptId === conceptId);
  if (!spot) return { written: false, note: "no longer a weak spot" };
  const concept = await prisma.concept.findUniqueOrThrow({
    where: { id: conceptId },
    select: { name: true, definition: true, lecture: { select: { id: true, title: true, summaryMd: true } } },
  });
  const draft = await provider.writeLesson({
    conceptName: concept.name,
    conceptDefinition: concept.definition,
    lectureTitle: concept.lecture?.title ?? "",
    summary: concept.lecture?.summaryMd ?? concept.definition,
    gaps: spot.gaps,
  });
  throwIfCancelled();
  const lesson = await prisma.lesson.create({
    data: {
      conceptId,
      lectureId: concept.lecture?.id ?? null,
      explanation: draft.explanation,
      checks: JSON.stringify(draft.checks),
      gapCount: spot.answers,
      promptVersion: provider.lastPromptVersion,
      model: provider.lastModel,
    },
  });
  return { written: true, lessonId: lesson.id };
}

export async function finishLesson(lessonId: string) {
  await prisma.lesson.updateMany({ where: { id: lessonId, doneAt: null }, data: { doneAt: new Date() } });
}

/** The lesson's check questions as AK cards in its lecture's deck, once each. */
export async function lessonCards(lessonId: string): Promise<number> {
  const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
  if (!lesson?.lectureId) return 0;
  const checks = readChecks(lesson.checks);
  const keys = checks.map((_, i) => `lesson:${lesson.id}:${i}`);
  const have = new Set(
    (await prisma.flashcard.findMany({ where: { lectureId: lesson.lectureId, sourceKey: { in: keys } }, select: { sourceKey: true } })).map((c) => c.sourceKey),
  );
  const start = Date.now();
  const fresh = checks
    .map((c, i) => ({ lectureId: lesson.lectureId!, origin: MISTAKE_ORIGIN, sourceKey: keys[i], front: c.question, back: c.answer, createdAt: new Date(start + i) }))
    .filter((c) => !have.has(c.sourceKey));
  if (fresh.length) await prisma.flashcard.createMany({ data: fresh });
  return fresh.length;
}

/** Asks for a lesson on one concept now, whatever else is waiting. */
export async function requestLesson(conceptId: string) {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { lectureId: true } });
  const jobs = await prisma.job.findMany({ where: { kind: "LESSON", status: { in: ["PENDING", "RUNNING"] } }, select: { payload: true } });
  if (jobs.some((j) => JSON.parse(j.payload).conceptId === conceptId)) return false;
  await enqueue("LESSON", { conceptId }, concept.lectureId);
  return true;
}

/** Concepts with a lesson being written right now or waiting to be. */
export async function lessonsBeingWritten(): Promise<Set<string>> {
  const jobs = await prisma.job.findMany({ where: { kind: "LESSON", status: { in: ["PENDING", "RUNNING"] } }, select: { payload: true } });
  return new Set(jobs.map((j) => String(JSON.parse(j.payload).conceptId)));
}
