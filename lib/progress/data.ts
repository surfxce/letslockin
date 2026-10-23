import { prisma } from "@/lib/db";
import { conceptMastery } from "@/lib/engines/mastery";
import { layoutMap } from "@/lib/progress/layout";
import { relate } from "@/lib/progress/related";
import { lectureRows } from "@/lib/views";

export interface CourseReadiness {
  id: string;
  code: string;
  title: string;
  examDays: number | null;
  /** Share of the final grade the exam is worth, 0–1, if set. */
  weighting: number | null;
  lectures: number;
  drilled: number;
  /** If the exam were today: each lecture's latest drill score, undrilled ones as 0, out of 100. */
  predicted: number | null;
  /** The same, over drilled lectures only. */
  drilledAverage: number | null;
  mcqRight: number;
  mcqAsked: number;
}

export interface ScorePoint {
  at: string;
  score: number;
  lecture: string;
  source: string;
}

export interface HeatRow {
  lectureId: string;
  title: string;
  ordinal: number;
  courseCode: string;
  cells: Array<{ id: string; name: string; mastery: number | null }>;
}

export interface MapNode {
  id: string;
  title: string;
  ordinal: number;
  courseId: string;
  courseCode: string;
  score: number | null;
  x: number;
  y: number;
}

export interface ProgressData {
  stats: { prepared: number; lectures: number; sittings: number; answers: number; reviews: number; exams: number; streak: number };
  courses: CourseReadiness[];
  scores: ScorePoint[];
  heat: HeatRow[];
  map: { nodes: MapNode[]; links: Array<{ a: string; b: string; score: number; shared: string[] }> };
  /** Course ids in a fixed order, for their colours. */
  courseOrder: string[];
}

const DAY = 86_400_000;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Days in a row with any studying, up to today (or yesterday, if today hasn't started). */
export function streak(days: Date[], now = new Date()): number {
  const set = new Set(days.map(dayKey));
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!set.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (set.has(dayKey(cursor))) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

export async function progressData(courseId?: string, now = new Date()): Promise<ProgressData> {
  const lectureWhere = courseId ? { courseId } : {};
  const [allCourses, rows, attempts, answers, reviews, exams, mcqItems, lectures] = await Promise.all([
    prisma.course.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, code: true, title: true, examDate: true, weighting: true } }),
    lectureRows(courseId ? { courseId } : {}),
    prisma.attempt.findMany({
      where: { geometricMean: { not: null }, lecture: lectureWhere },
      orderBy: [{ completedAt: "asc" }, { sittingDate: "asc" }],
      select: { completedAt: true, sittingDate: true, geometricMean: true, source: true, lecture: { select: { title: true } } },
    }),
    prisma.response.count({ where: { mark: { not: null }, attempt: { lecture: lectureWhere } } }),
    prisma.flashcardReview.findMany({
      where: { reviewedAt: { gte: new Date(now.getTime() - 400 * DAY) }, card: { lecture: lectureWhere } },
      select: { reviewedAt: true },
    }),
    prisma.exam.findMany({ where: { submittedAt: { not: null }, ...(courseId ? { courseId } : {}) }, select: { submittedAt: true } }),
    prisma.examItem.findMany({
      where: { kind: "MCQ", exam: { submittedAt: { not: null } }, mcq: { lecture: lectureWhere } },
      select: { choice: true, mcq: { select: { answer: true, lecture: { select: { courseId: true } } } } },
    }),
    prisma.lecture.findMany({
      where: { ...lectureWhere, summaryMd: { not: null } },
      orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        summaryMd: true,
        concepts: { where: { mergedIntoId: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, definition: true } },
      },
    }),
  ]);
  const reviewCount = await prisma.flashcardReview.count({ where: { card: { lecture: lectureWhere } } });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const courses = (courseId ? allCourses.filter((c) => c.id === courseId) : allCourses).map((c): CourseReadiness => {
    const own = rows.filter((r) => r.courseId === c.id && r.hasSummary && r.laqCount > 0);
    const drilled = own.filter((r) => r.lastScore !== null);
    const mcqs = mcqItems.filter((i) => i.mcq?.lecture.courseId === c.id);
    const exam = c.examDate ? new Date(c.examDate.getFullYear(), c.examDate.getMonth(), c.examDate.getDate()).getTime() : null;
    return {
      id: c.id,
      code: c.code,
      title: c.title,
      examDays: exam === null ? null : Math.round((exam - today) / DAY),
      weighting: c.weighting,
      lectures: own.length,
      drilled: drilled.length,
      predicted: own.length ? (own.reduce((s, r) => s + (r.lastScore ?? 0), 0) / own.length) * 10 : null,
      drilledAverage: drilled.length ? (drilled.reduce((s, r) => s + r.lastScore!, 0) / drilled.length) * 10 : null,
      mcqRight: mcqs.filter((i) => i.choice === i.mcq!.answer).length,
      mcqAsked: mcqs.length,
    };
  });

  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const mastery = new Map(
    (await conceptMastery(lectures.flatMap((l) => l.concepts.map((c) => c.id)))).map((m) => [m.conceptId, m.seen ? m.mastery : null]),
  );
  const heat: HeatRow[] = lectures
    .filter((l) => l.concepts.length && rowOf.has(l.id))
    .map((l) => ({
      lectureId: l.id,
      title: rowOf.get(l.id)!.title,
      ordinal: rowOf.get(l.id)!.ordinal,
      courseCode: rowOf.get(l.id)!.courseCode,
      cells: l.concepts.map((c) => ({ id: c.id, name: c.name, mastery: mastery.get(c.id) ?? null })),
    }));

  const docs = lectures
    .filter((l) => rowOf.has(l.id))
    .map((l) => ({ id: l.id, text: [l.summaryMd ?? "", ...l.concepts.map((c) => `${c.name}. ${c.definition}`)].join("\n") }));
  const links = relate(docs, { perLecture: 3, floor: 0.05 });
  const positions = layoutMap(
    docs.map((d) => ({ id: d.id, group: rowOf.get(d.id)!.courseId })),
    links,
  );
  const nodes: MapNode[] = docs.map((d) => {
    const r = rowOf.get(d.id)!;
    const p = positions.get(d.id) ?? { x: 0, y: 0 };
    return { id: d.id, title: r.title, ordinal: r.ordinal, courseId: r.courseId, courseCode: r.courseCode, score: r.lastScore, x: p.x, y: p.y };
  });

  const days = [
    ...attempts.map((a) => a.completedAt ?? a.sittingDate),
    ...reviews.map((r) => r.reviewedAt),
    ...exams.map((e) => e.submittedAt!),
  ];
  return {
    stats: {
      prepared: rows.filter((r) => r.hasSummary).length,
      lectures: rows.length,
      sittings: attempts.length,
      answers,
      reviews: reviewCount,
      exams: exams.length,
      streak: streak(days, now),
    },
    courses,
    scores: attempts.map((a) => ({
      at: (a.completedAt ?? a.sittingDate).toISOString(),
      score: a.geometricMean!,
      lecture: a.lecture.title,
      source: a.source,
    })),
    heat,
    map: { nodes, links },
    courseOrder: allCourses.map((c) => c.id),
  };
}
