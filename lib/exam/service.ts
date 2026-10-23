import { prisma } from "@/lib/db";
import { OWN_QUESTIONS, readLinked } from "@/lib/mixed/schema";
import { geometricMean } from "@/lib/engines/geomean";
import { pickExamItems, shuffle, type ExamCandidate, type ExamFocus } from "@/lib/exam/pick";
import { enqueue } from "@/lib/jobs";
import { readOptions } from "@/lib/mcq/service";
import { usesAi } from "@/lib/modes";
import { scoreAttemptIfMarked } from "@/lib/pipeline";
import { getSettings } from "@/lib/settings";
import { lectureRows } from "@/lib/views";

export const MAX_EXAM_MCQS = 60;
export const MAX_EXAM_LAQS = 20;
/** Linking questions take turns in an exam as if they were one more lecture. */
const LINKING = "linking";

export interface ExamOptions {
  lectureIds: string[];
  mcqs: number;
  laqs: number;
  timeLimitMin: number | null;
  focus: ExamFocus;
  /** Also ask questions that link lectures, where every lecture they need is chosen. */
  linking?: boolean;
}

/** One lecture as the exam setup lists it. */
export interface ExamLecture {
  id: string;
  title: string;
  laqs: number;
  mcqs: number;
  prepared: boolean;
}

export interface ExamCourse {
  id: string;
  code: string;
  title: string;
  modules: Array<{ id: string | null; title: string; lectures: ExamLecture[] }>;
  /** The lectures each of its linking questions needs. */
  linking: string[][];
}

/** Every course, its modules and their lectures, with what each could put in an exam. */
export async function examTree(): Promise<ExamCourse[]> {
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      code: true,
      title: true,
      modules: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, title: true } },
      lectures: {
        orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          moduleId: true,
          summaryMd: true,
          _count: { select: { questions: { where: OWN_QUESTIONS }, mcqs: true } },
          questions: { where: { linkedLectureIds: { not: null } }, select: { linkedLectureIds: true } },
        },
      },
    },
  });
  return courses
    .filter((c) => c.lectures.length)
    .map((c) => {
      const lecture = (l: (typeof c.lectures)[number]): ExamLecture => ({
        id: l.id,
        title: l.title,
        laqs: l._count.questions,
        mcqs: l._count.mcqs,
        prepared: !!l.summaryMd?.trim(),
      });
      const modules = c.modules
        .map((m) => ({ id: m.id as string | null, title: m.title, lectures: c.lectures.filter((l) => l.moduleId === m.id).map(lecture) }))
        .filter((m) => m.lectures.length);
      const loose = c.lectures.filter((l) => !l.moduleId || !c.modules.some((m) => m.id === l.moduleId));
      if (loose.length) modules.push({ id: null, title: modules.length ? "Not in a module" : "Lectures", lectures: loose.map(lecture) });
      const linking = c.lectures.flatMap((l) => l.questions.map((q) => readLinked(q.linkedLectureIds)));
      return { id: c.id, code: c.code, title: c.title, modules, linking };
    });
}

/** Starts an exam: picks its questions and saves it, ready to sit. */
export async function createExam(opts: ExamOptions): Promise<string> {
  const lectureIds = [...new Set(opts.lectureIds)];
  const lectures = await prisma.lecture.findMany({
    where: { id: { in: lectureIds } },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: { id: true, courseId: true, course: { select: { code: true } } },
  });
  if (!lectures.length) throw new Error("Choose at least one lecture.");
  const ids = lectures.map((l) => l.id);
  const mcqCount = clamp(opts.mcqs, 0, MAX_EXAM_MCQS);
  const laqCount = clamp(opts.laqs, 0, MAX_EXAM_LAQS);
  if (mcqCount + laqCount === 0) throw new Error("Ask for at least one question.");

  const [mcqs, questions, rows] = await Promise.all([
    mcqCount
      ? prisma.mcq.findMany({
          where: { lectureId: { in: ids } },
          select: {
            id: true,
            lectureId: true,
            answer: true,
            options: true,
            examItems: {
              // Asked and left unanswered counts as wrong.
              where: { exam: { submittedAt: { not: null } } },
              orderBy: { exam: { createdAt: "desc" } },
              select: { choice: true },
            },
          },
        })
      : [],
    laqCount
      ? prisma.question.findMany({
          where: { lectureId: { in: ids }, paperItemId: null },
          select: {
            id: true,
            lectureId: true,
            linkedLectureIds: true,
            // Answered (or handed in blank) before, marked yet or not.
            responses: {
              where: { OR: [{ mark: { not: null } }, { answerText: { not: "" } }] },
              orderBy: { markedAt: "desc" },
              select: { mark: true },
            },
          },
        })
      : [],
    lectureRows({ ids }),
  ]);

  const mcqCandidates: ExamCandidate[] = mcqs
    .filter((m) => readOptions(m.options).length > m.answer)
    .map((m) => ({
      id: m.id,
      lectureId: m.lectureId,
      seen: m.examItems.length,
      lastMark: m.examItems.length ? (m.examItems[0].choice === m.answer ? 10 : 0) : null,
    }));
  const chosen = new Set(ids);
  const laqCandidates: ExamCandidate[] = questions
    .filter((q) => {
      const linked = readLinked(q.linkedLectureIds);
      return !linked.length || (opts.linking !== false && linked.every((id) => chosen.has(id)));
    })
    .map((q) => ({
      id: q.id,
      // Linking questions take turns as if they were a lecture of their own.
      lectureId: q.linkedLectureIds ? LINKING : q.lectureId,
      seen: q.responses.length,
      lastMark: q.responses.find((r) => r.mark !== null)?.mark ?? null,
    }));
  if (!mcqCandidates.length && !laqCandidates.length) {
    throw new Error("The lectures you chose have no LAQs or MCQs yet. Prepare them first.");
  }

  const lectureScore = new Map(rows.map((r) => [r.id, r.lastScore]));
  const pickOpts = { focus: opts.focus, lectureScore };
  // Multiple choice in a random order; long answers in lecture order, as a paper would
  // be, with the ones linking lectures last.
  const pickedMcqs = shuffle(pickExamItems(mcqCandidates, mcqCount, pickOpts));
  const order = new Map(ids.map((id, i) => [id, i]));
  const lectureOf = new Map(laqCandidates.map((c) => [c.id, c.lectureId]));
  const pickedLaqs = pickExamItems(laqCandidates, laqCount, pickOpts).sort(
    (a, b) => (order.get(lectureOf.get(a)!) ?? ids.length) - (order.get(lectureOf.get(b)!) ?? ids.length),
  );
  if (!pickedMcqs.length && !pickedLaqs.length) throw new Error("There was nothing to put in this exam.");

  const codes = [...new Set(lectures.map((l) => l.course.code))];
  const courseIds = [...new Set(lectures.map((l) => l.courseId))];
  const exam = await prisma.exam.create({
    data: {
      courseId: courseIds.length === 1 ? courseIds[0] : null,
      title: codes.length <= 3 ? `${codes.join(", ")} exam` : `Exam across ${codes.length} courses`,
      scope: JSON.stringify({ lectureIds: ids, focus: opts.focus }),
      timeLimitMin: opts.timeLimitMin && opts.timeLimitMin > 0 ? Math.min(Math.round(opts.timeLimitMin), 600) : null,
      items: {
        create: [
          ...pickedMcqs.map((mcqId, i) => ({ position: i, kind: "MCQ", mcqId })),
          ...pickedLaqs.map((questionId, i) => ({ position: pickedMcqs.length + i, kind: "LAQ", questionId })),
        ],
      },
    },
  });
  return exam.id;
}

/** Saves one answer as it is chosen or typed, while the exam is open. */
export async function saveExamAnswer(itemId: string, answer: { choice: number | null } | { text: string }): Promise<boolean> {
  const data = "text" in answer ? { draftText: answer.text.slice(0, 50_000) } : { choice: answer.choice };
  const { count } = await prisma.examItem.updateMany({ where: { id: itemId, exam: { submittedAt: null } }, data });
  return count > 0;
}

/**
 * Hands the exam in. Its long answers become a sitting of each lecture they came from,
 * so they are marked like any other answer and count towards that lecture's drill
 * score. A blank long answer scores 0, as it would in the exam.
 */
export async function submitExam(
  examId: string,
  answers: { choices: Map<string, number | null>; texts: Map<string, string> },
): Promise<{ ok: boolean; message: string }> {
  const now = new Date();
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { items: { include: { question: { select: { id: true, lectureId: true } } } } },
  });
  if (!exam) return { ok: false, message: "This exam isn't here any more." };
  if (exam.submittedAt) return { ok: true, message: "Already handed in." };

  const toMark: Array<{ responseId: string; lectureId: string }> = [];
  const attempts: string[] = [];
  const handedIn = await prisma.$transaction(async (tx) => {
    // Claimed first, so a second click can't hand it in twice.
    const { count } = await tx.exam.updateMany({ where: { id: examId, submittedAt: null }, data: { submittedAt: now } });
    if (!count) return false;
    const byLecture = new Map<string, typeof exam.items>();
    for (const item of exam.items) {
      if (item.kind === "MCQ") {
        const choice = answers.choices.has(item.id) ? answers.choices.get(item.id)! : item.choice;
        if (choice !== item.choice) await tx.examItem.update({ where: { id: item.id }, data: { choice } });
      } else if (item.question) {
        byLecture.set(item.question.lectureId, [...(byLecture.get(item.question.lectureId) ?? []), item]);
      }
    }
    for (const [lectureId, items] of byLecture) {
      const attempt = await tx.attempt.create({ data: { lectureId, source: "EXAM", sittingDate: exam.createdAt } });
      attempts.push(attempt.id);
      for (const item of items) {
        const text = (answers.texts.get(item.id) ?? item.draftText ?? "").trim();
        const response = await tx.response.create({
          data: text
            ? { attemptId: attempt.id, questionId: item.question!.id, answerText: text }
            : {
                attemptId: attempt.id,
                questionId: item.question!.id,
                answerText: "",
                mark: 0,
                markedAt: now,
                rawMarkingJson: JSON.stringify({ source: "blank", feedback: [{ kind: "missed", text: "Left blank." }] }),
              },
        });
        await tx.examItem.update({ where: { id: item.id }, data: { responseId: response.id, draftText: text || null } });
        if (text) toMark.push({ responseId: response.id, lectureId });
      }
    }
    return true;
  });
  if (!handedIn) return { ok: true, message: "Already handed in." };

  const { mode } = await getSettings();
  if (usesAi(mode)) {
    for (const { responseId, lectureId } of toMark) await enqueue("MARK", { responseId }, lectureId);
  }
  for (const id of attempts) await scoreAttemptIfMarked(id);
  return { ok: true, message: "Handed in." };
}

/** Deletes an exam. The sittings its long answers made stay with their lectures. */
export async function deleteExam(examId: string) {
  await prisma.exam.deleteMany({ where: { id: examId } });
}

export interface ExamSummary {
  mcqTotal: number;
  mcqCorrect: number;
  laqTotal: number;
  laqMarks: number[];
  /** Geometric mean of the long answers, once every one is marked. */
  laqScore: number | null;
  pending: number;
}

/** How an exam went, from its items. */
export function summarise(
  items: Array<{ kind: string; choice: number | null; mcq: { answer: number } | null; response: { mark: number | null } | null; questionId: string | null }>,
): ExamSummary {
  const mcqs = items.filter((i) => i.kind === "MCQ" && i.mcq);
  const laqs = items.filter((i) => i.kind === "LAQ" && i.response);
  const marks = laqs.map((i) => i.response!.mark).filter((m): m is number => m !== null);
  const pending = laqs.length - marks.length;
  return {
    mcqTotal: mcqs.length,
    mcqCorrect: mcqs.filter((i) => i.choice === i.mcq!.answer).length,
    laqTotal: laqs.length,
    laqMarks: marks,
    laqScore: laqs.length && !pending ? geometricMean(marks) : null,
    pending,
  };
}

function clamp(n: number, min: number, max: number) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}
