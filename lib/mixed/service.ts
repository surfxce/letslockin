import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { throwIfCancelled } from "@/lib/llm/cancel";
import type { LlmProvider } from "@/lib/llm/provider";
import { readLinked } from "@/lib/mixed/schema";
import { relate } from "@/lib/progress/related";

/** Pairs written for in one go, and questions for each. */
const PAIRS_PER_RUN = 6;
const PER_PAIR = 2;
/** A pair with this many already is left alone. */
const ENOUGH = 4;

const pairKey = (ids: string[]) => [...ids].sort().join("|");

interface Pair {
  /** Delivered first, then later. */
  lectures: [string, string];
  score: number;
  shared: string[];
  existing: number;
}

/** The course's prepared lectures paired with those they share most with, fewest questions first. */
async function pairsOf(courseId: string): Promise<{ pairs: Pair[]; lectures: Map<string, LectureForMixed> }> {
  const [lectures, linked] = await Promise.all([
    prisma.lecture.findMany({
      where: { courseId, summaryMd: { not: null } },
      orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        summaryMd: true,
        concepts: { where: { mergedIntoId: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, definition: true } },
      },
    }),
    prisma.question.findMany({ where: { linkedLectureIds: { not: null }, lecture: { courseId } }, select: { linkedLectureIds: true } }),
  ]);
  const usable = lectures.filter((l) => l.summaryMd?.trim() && l.concepts.length);
  const order = new Map(usable.map((l, i) => [l.id, i]));
  const counts = new Map<string, number>();
  for (const q of linked) {
    const key = pairKey(readLinked(q.linkedLectureIds));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const docs = usable.map((l) => ({ id: l.id, text: [l.summaryMd ?? "", ...l.concepts.map((c) => `${c.name}. ${c.definition}`)].join("\n") }));
  const pairs = relate(docs, { perLecture: 2, floor: 0.06 })
    .map((r): Pair => {
      const [first, second] = order.get(r.a)! <= order.get(r.b)! ? [r.a, r.b] : [r.b, r.a];
      return { lectures: [first, second], score: r.score, shared: r.shared, existing: counts.get(pairKey([r.a, r.b])) ?? 0 };
    })
    .filter((p) => p.existing < ENOUGH)
    .sort((a, b) => a.existing - b.existing || b.score - a.score);
  return { pairs, lectures: new Map(usable.map((l) => [l.id, l])) };
}

type LectureForMixed = { id: string; title: string; summaryMd: string | null; concepts: Array<{ id: string; name: string; definition: string }> };

/**
 * Writes questions that join up a course's related lectures, a couple for each of the
 * closest pairs. Each is filed under the later lecture of its pair, where its answers
 * count, and is asked only in exams that include both.
 */
export async function writeMixedQuestions(courseId: string, provider: LlmProvider) {
  const { pairs, lectures } = await pairsOf(courseId);
  if (!pairs.length) return { pairs: 0, questions: 0, note: "no related lectures without linking questions" };
  let questions = 0;
  let done = 0;
  for (const pair of pairs.slice(0, PAIRS_PER_RUN)) {
    const [first, second] = pair.lectures.map((id) => lectures.get(id)!);
    const { questions: written } = await provider.writeMixedQuestions({
      lectures: [first, second].map((l) => ({ title: l.title, summary: l.summaryMd ?? "", concepts: l.concepts })),
      shared: pair.shared,
      count: PER_PAIR,
    });
    throwIfCancelled();
    const known = new Set([...first.concepts, ...second.concepts].map((c) => c.id));
    for (const q of written) {
      const conceptIds = [...new Set(q.conceptIds)].filter((id) => known.has(id));
      if (!conceptIds.length) continue;
      await prisma.question.create({
        data: {
          lectureId: second.id,
          stem: q.stem,
          type: "LAQ",
          rubric: JSON.stringify(q.rubric),
          promptVersion: provider.lastPromptVersion,
          model: provider.lastModel,
          linkedLectureIds: JSON.stringify([second.id, first.id]),
          concepts: { create: conceptIds.map((conceptId) => ({ conceptId })) },
        },
      });
      questions++;
    }
    done++;
  }
  return { pairs: done, questions };
}

/** Queues linking questions for a course, unless they are already being written. */
export async function enqueueMixed(courseId: string) {
  const waiting = await prisma.job.findFirst({
    where: { kind: "MIXED", status: { in: ["PENDING", "RUNNING"] }, payload: { contains: courseId } },
    select: { id: true },
  });
  if (waiting) return waiting.id;
  return (await enqueue("MIXED", { courseId }, null)).id;
}

export interface MixedCourse {
  id: string;
  code: string;
  questions: number;
  /** Related pairs that could still take more. */
  open: number;
  job: { status: string; error: string | null } | null;
}

/** Per course: linking questions so far, pairs still open, and the latest job. */
export async function mixedCourses(): Promise<MixedCourse[]> {
  const courses = await prisma.course.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, code: true } });
  const jobs = await prisma.job.findMany({
    where: { kind: "MIXED" },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { payload: true, status: true, error: true },
  });
  const out: MixedCourse[] = [];
  for (const c of courses) {
    const [questions, { pairs }] = await Promise.all([
      prisma.question.count({ where: { linkedLectureIds: { not: null }, lecture: { courseId: c.id } } }),
      pairsOf(c.id),
    ]);
    if (!questions && !pairs.length) continue;
    const job = jobs.find((j) => j.payload.includes(c.id));
    out.push({ id: c.id, code: c.code, questions, open: pairs.length, job: job ? { status: job.status, error: job.error } : null });
  }
  return out;
}
