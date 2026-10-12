import { prisma } from "@/lib/db";
import { nextReview } from "@/lib/engines/schedule";
import type { LectureRow, LectureStatus } from "@/lib/status";
import { STAGES, type Stage } from "@/lib/types";

export type { LectureRow, LectureStatus } from "@/lib/status";

export async function lectureRows(where: { courseId?: string; ids?: string[] } = {}): Promise<LectureRow[]> {
  const lectures = await prisma.lecture.findMany({
    where: {
      ...(where.courseId ? { courseId: where.courseId } : {}),
      ...(where.ids ? { id: { in: where.ids } } : {}),
    },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      courseId: true,
      deliveredOn: true,
      durationHours: true,
      createdAt: true,
      summaryMd: true,
      course: { select: { code: true, examDate: true } },
      module: { select: { title: true } },
      _count: { select: { questions: true, materials: true } },
      attempts: {
        where: { geometricMean: { not: null } },
        select: { sittingDate: true, completedAt: true, geometricMean: true },
        orderBy: { sittingDate: "asc" },
      },
      questions: { select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
      jobs: {
        where: { kind: { in: ["PREPARE", "GENERATE"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, stage: true, error: true },
      },
    },
  });

  const pending = await prisma.job.findMany({
    where: { status: "PENDING" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  const position = new Map(pending.map((j, i) => [j.id, i + 1]));

  // L-numbers count within a course, so they need the whole course even when filtered.
  const ordinals = new Map<string, number>();
  const courseIds = [...new Set(lectures.map((l) => l.courseId))];
  const siblings = await prisma.lecture.findMany({
    where: { courseId: { in: courseIds } },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: { id: true, courseId: true },
  });
  const counters = new Map<string, number>();
  for (const s of siblings) {
    const n = (counters.get(s.courseId) ?? 0) + 1;
    counters.set(s.courseId, n);
    ordinals.set(s.id, n);
  }

  return lectures.map((l) => {
    const scores = l.attempts.map((a) => a.geometricMean as number);
    const sittings = l.attempts.map((a) => ({ at: a.completedAt ?? a.sittingDate, score: a.geometricMean as number }));
    const review = nextReview({
      sittings,
      readySince: l.questions[0]?.createdAt ?? null,
      examDate: l.course.examDate,
    });
    const job = l.jobs[0];

    let status: LectureStatus;
    if (job?.status === "RUNNING") status = "working";
    else if (job?.status === "PENDING") status = "queued";
    else if (scores.length > 0) status = "practised";
    else if (l._count.questions > 0) status = "ready";
    else if (job?.status === "FAILED") status = "failed";
    else if (l.summaryMd) status = "summary";
    else if (l._count.materials === 0) status = "empty";
    else status = "todo";

    return {
      id: l.id,
      title: l.title,
      ordinal: ordinals.get(l.id) ?? 0,
      courseId: l.courseId,
      courseCode: l.course.code,
      moduleTitle: l.module?.title ?? null,
      deliveredOn: l.deliveredOn.toISOString(),
      durationHours: l.durationHours,
      hasSummary: !!l.summaryMd,
      laqCount: l._count.questions,
      fileCount: l._count.materials,
      sittings: scores.length,
      lastScore: scores.at(-1) ?? null,
      prevScore: scores.at(-2) ?? null,
      bestScore: scores.length ? Math.max(...scores) : null,
      lastSatOn: sittings.at(-1)?.at.toISOString() ?? null,
      // Nothing is due while there is nothing to sit.
      dueAt: l._count.questions > 0 ? (review.dueAt?.toISOString() ?? null) : null,
      status,
      stageLabel: status === "working" && job?.stage ? (STAGES[job.stage as Stage] ?? job.stage) : null,
      queuePosition: status === "queued" && job ? (position.get(job.id) ?? null) : null,
      error: status === "failed" ? (job?.error ?? null) : null,
    };
  });
}

/** Lectures whose LAQs are due today or overdue, most overdue first. */
export async function dueLectures(now = new Date()): Promise<LectureRow[]> {
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return (await lectureRows())
    .filter((r) => r.dueAt && new Date(r.dueAt) < endOfToday)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
}

/**
 * Stable "LAQ n" numbers within a lecture, by creation order. Pasted scores and the
 * marking prompt both refer to questions by these numbers.
 */
export async function questionNumbers(lectureId: string): Promise<Map<string, number>> {
  const questions = await prisma.question.findMany({
    where: { lectureId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return new Map(questions.map((q, i) => [q.id, i + 1]));
}
