import { prisma } from "@/lib/db";
import { pickExamItems, type ExamCandidate, type ExamFocus } from "@/lib/exam/pick";
import { readRubric } from "@/lib/feedback";
import { enqueue } from "@/lib/jobs";
import type { LlmProvider } from "@/lib/llm/provider";
import { OWN_QUESTIONS } from "@/lib/mixed/schema";
import { usesAi } from "@/lib/modes";
import { scoreAttemptIfMarked } from "@/lib/pipeline";
import { getSettings } from "@/lib/settings";
import { lectureRows } from "@/lib/views";
import {
  MAX_PROBES,
  readPlan,
  readTurns,
  vivaAnswerText,
  VivaMoveSchema,
  type VivaMove,
  type VivaPlanItem,
  type VivaTurn,
  type VivaTurnInput,
} from "@/lib/viva/schema";

export const VIVA_SIZES = [3, 5, 8] as const;

const now = () => new Date().toISOString();

/**
 * Starts a viva: a few LAQs from the chosen lectures, spread across them like an exam
 * (or aimed at weak spots), asked one at a time. The first is put at once; the AI
 * examiner speaks after each answer.
 */
export async function startViva(opts: { lectureIds: string[]; questions: number; focus: ExamFocus }): Promise<string> {
  if (!usesAi((await getSettings()).mode)) throw new Error("A viva needs an AI to be the examiner — choose one in Settings.");
  const lectures = await prisma.lecture.findMany({
    where: { id: { in: [...new Set(opts.lectureIds)] } },
    select: { id: true, courseId: true, course: { select: { code: true } } },
  });
  if (!lectures.length) throw new Error("Choose at least one lecture.");
  const ids = lectures.map((l) => l.id);
  const [questions, rows] = await Promise.all([
    prisma.question.findMany({
      where: { lectureId: { in: ids }, ...OWN_QUESTIONS },
      select: {
        id: true,
        lectureId: true,
        stem: true,
        responses: { where: { OR: [{ mark: { not: null } }, { answerText: { not: "" } }] }, orderBy: { markedAt: "desc" }, select: { mark: true } },
      },
    }),
    lectureRows({ ids }),
  ]);
  if (!questions.length) throw new Error("The lectures you chose have no LAQs yet. Prepare them first.");
  const candidates: ExamCandidate[] = questions.map((q) => ({
    id: q.id,
    lectureId: q.lectureId,
    seen: q.responses.length,
    lastMark: q.responses.find((r) => r.mark !== null)?.mark ?? null,
  }));
  const picked = pickExamItems(candidates, Math.max(1, Math.min(12, Math.round(opts.questions))), {
    focus: opts.focus,
    lectureScore: new Map(rows.map((r) => [r.id, r.lastScore])),
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const plan: VivaPlanItem[] = picked.map((id) => ({ questionId: id, lectureId: byId.get(id)!.lectureId }));
  const first = byId.get(plan[0].questionId)!;
  const codes = [...new Set(lectures.map((l) => l.course.code))];
  const courseIds = [...new Set(lectures.map((l) => l.courseId))];
  const viva = await prisma.viva.create({
    data: {
      courseId: courseIds.length === 1 ? courseIds[0] : null,
      title: codes.length <= 3 ? `${codes.join(", ")} viva` : `Viva across ${codes.length} courses`,
      plan: JSON.stringify(plan),
      turns: JSON.stringify([
        { role: "examiner", text: `Let's begin. ${first.stem}`, questionId: first.id, at: now() } satisfies VivaTurn,
      ]),
    },
  });
  return viva.id;
}

type VivaRow = NonNullable<Awaited<ReturnType<typeof prisma.viva.findUnique>>>;

/** The turns and position after closing the current question with `closing`: the next
 *  question put, or the viva over. */
async function advance(viva: VivaRow, turns: VivaTurn[], closing: string) {
  const plan = readPlan(viva.plan);
  const current = plan[viva.current];
  if (closing.trim()) turns.push({ role: "examiner", text: closing.trim(), questionId: current?.questionId ?? "", at: now() });
  const next = plan[viva.current + 1];
  if (!next) {
    turns.push({ role: "examiner", text: "That's the end of the viva. Thank you — your answers are being marked.", questionId: "", at: now() });
    await prisma.viva.update({
      where: { id: viva.id },
      data: { turns: JSON.stringify(turns), current: plan.length, probes: 0, waitingOn: "done", finishedAt: new Date() },
    });
    await handIn(viva.id);
    return;
  }
  const question = await prisma.question.findUnique({ where: { id: next.questionId }, select: { stem: true } });
  turns.push({ role: "examiner", text: `Next question. ${question?.stem ?? "(This question was deleted — say anything to move on.)"}`, questionId: next.questionId, at: now() });
  await prisma.viva.update({
    where: { id: viva.id },
    data: { turns: JSON.stringify(turns), current: viva.current + 1, probes: 0, waitingOn: "student" },
  });
}

/** The student's answer, spoken (and transcribed) or typed. The examiner replies next. */
export async function answerViva(vivaId: string, text: string): Promise<{ ok: boolean; message: string }> {
  const said = text.trim().slice(0, 8000);
  if (!said) return { ok: false, message: "Say or type an answer first — or skip the question." };
  const viva = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (!viva || viva.waitingOn !== "student") return { ok: false, message: "It isn't your turn to answer." };
  const plan = readPlan(viva.plan);
  const item = plan[viva.current];
  if (!item) return { ok: false, message: "This viva is over." };
  const turns = readTurns(viva.turns);
  turns.push({ role: "student", text: said, questionId: item.questionId, at: now() });
  // Claimed only if nothing changed since it was read, so a double click answers once.
  const { count } = await prisma.viva.updateMany({
    where: { id: vivaId, waitingOn: "student", turns: viva.turns },
    data: { turns: JSON.stringify(turns), waitingOn: viva.probes >= MAX_PROBES ? "student" : "examiner" },
  });
  if (!count) return { ok: false, message: "That answer was already sent." };
  // Out of follow-ups: no need to ask the examiner what to say.
  if (viva.probes >= MAX_PROBES) await advance({ ...viva, turns: JSON.stringify(turns) }, turns, "Okay, thank you.");
  else await enqueue("VIVA", { vivaId }, item.lectureId);
  return { ok: true, message: "" };
}

/** Moves on without an answer (or without more of one): "I don't know" is a fair answer in a viva. */
export async function skipVivaQuestion(vivaId: string) {
  const viva = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (!viva || viva.waitingOn !== "student") return;
  const { count } = await prisma.viva.updateMany({ where: { id: vivaId, waitingOn: "student", turns: viva.turns }, data: { waitingOn: "examiner" } });
  if (count) await advance(viva, readTurns(viva.turns), "Alright, let's move on.");
}

/** Ends it early: what was asked is marked; what wasn't is left out. */
export async function endViva(vivaId: string) {
  const viva = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (!viva || viva.waitingOn === "done") return;
  const plan = readPlan(viva.plan).slice(0, viva.current + 1);
  const turns = readTurns(viva.turns);
  turns.push({ role: "examiner", text: "We'll stop there. Thank you — your answers are being marked.", questionId: "", at: now() });
  const { count } = await prisma.viva.updateMany({
    where: { id: vivaId, waitingOn: { not: "done" } },
    data: { plan: JSON.stringify(plan), turns: JSON.stringify(turns), current: plan.length, waitingOn: "done", finishedAt: new Date() },
  });
  if (count) await handIn(vivaId);
}

/** The examiner's turn, run by the worker: a follow-up, or the next question. */
export async function runVivaTurn(vivaId: string, provider: LlmProvider): Promise<{ move: string }> {
  const viva = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (!viva || viva.waitingOn !== "examiner") return { move: "none" };
  const item = readPlan(viva.plan)[viva.current];
  const turns = readTurns(viva.turns);
  const question = item
    ? await prisma.question.findUnique({ where: { id: item.questionId }, select: { stem: true, rubric: true, lecture: { select: { title: true } } } })
    : null;
  if (!item || !question) {
    await advance(viva, turns, "Let's move on.");
    return { move: "next" };
  }
  const rubric = readRubric(question.rubric);
  const move = await provider.vivaTurn({
    lectureTitle: question.lecture.title,
    question: question.stem,
    modelAnswer: rubric.modelAnswer ?? "(none written)",
    criteria: rubric.criteria.map((c) => ({ point: c.point, marks: c.marks ?? 0 })),
    exchange: turns.filter((t) => t.questionId === item.questionId).map((t) => ({ role: t.role, text: t.text })),
    probesLeft: MAX_PROBES - viva.probes,
  });
  // The student may have ended it while the examiner was thinking.
  const still = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (!still || still.waitingOn !== "examiner" || still.turns !== viva.turns) return { move: "none" };
  if (move.move === "probe" && viva.probes < MAX_PROBES) {
    turns.push({ role: "examiner", text: move.say, questionId: item.questionId, at: now() });
    await prisma.viva.update({ where: { id: vivaId }, data: { turns: JSON.stringify(turns), probes: viva.probes + 1, waitingOn: "student" } });
    return { move: "probe" };
  }
  await advance(viva, turns, move.say);
  return { move: "next" };
}

/** When the examiner can't answer (the AI failed), the viva moves on rather than hang. */
export async function recoverViva(vivaId: string) {
  const viva = await prisma.viva.findUnique({ where: { id: vivaId } });
  if (viva?.waitingOn === "examiner") await advance(viva, readTurns(viva.turns), "Let's move on.");
}

/**
 * Hands the viva in: each question's exchange becomes an answer in a sitting of its
 * lecture, marked like any other. A question asked but never answered scores 0.
 */
async function handIn(vivaId: string) {
  const viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
  const plan = readPlan(viva.plan);
  const turns = readTurns(viva.turns);
  const at = new Date();
  const toMark: Array<{ responseId: string; lectureId: string }> = [];
  const attempts: string[] = [];
  const alive = new Set(
    (await prisma.question.findMany({ where: { id: { in: plan.map((p) => p.questionId) } }, select: { id: true } })).map((q) => q.id),
  );
  const byLecture = new Map<string, VivaPlanItem[]>();
  for (const item of plan) if (alive.has(item.questionId)) byLecture.set(item.lectureId, [...(byLecture.get(item.lectureId) ?? []), item]);
  for (const [lectureId, items] of byLecture) {
    const attempt = await prisma.attempt.create({ data: { lectureId, source: "VIVA", sittingDate: viva.createdAt } });
    attempts.push(attempt.id);
    for (const item of items) {
      const text = vivaAnswerText(turns.filter((t) => t.questionId === item.questionId));
      const response = await prisma.response.create({
        data: text
          ? { attemptId: attempt.id, questionId: item.questionId, answerText: text }
          : {
              attemptId: attempt.id,
              questionId: item.questionId,
              answerText: "",
              mark: 0,
              markedAt: at,
              rawMarkingJson: JSON.stringify({ source: "blank", feedback: [{ kind: "missed", text: "Not answered." }] }),
            },
      });
      item.responseId = response.id;
      if (text) toMark.push({ responseId: response.id, lectureId });
    }
  }
  await prisma.viva.update({ where: { id: vivaId }, data: { plan: JSON.stringify(plan) } });
  if (usesAi((await getSettings()).mode)) for (const { responseId, lectureId } of toMark) await enqueue("MARK", { responseId }, lectureId);
  for (const id of attempts) await scoreAttemptIfMarked(id);
}

export async function deleteViva(vivaId: string) {
  await prisma.viva.deleteMany({ where: { id: vivaId } });
}

/**
 * The examiner's next line for a viva held on the phone, by this computer's AI: queued
 * in the quick lane like this computer's own viva turns, and waited for.
 */
export async function relayVivaTurn(
  request: { questionId: string; exchange: VivaTurnInput["exchange"]; probesLeft: number },
  waitMs = 90_000,
): Promise<VivaMove> {
  if (!usesAi((await getSettings()).mode)) throw new Error("The computer has no AI set up to be the examiner.");
  const question = await prisma.question.findUnique({
    where: { id: request.questionId },
    select: { stem: true, rubric: true, lectureId: true, lecture: { select: { title: true } } },
  });
  if (!question) throw new Error("That question is no longer on the computer.");
  const rubric = readRubric(question.rubric);
  const relay: VivaTurnInput = {
    lectureTitle: question.lecture.title,
    question: question.stem,
    modelAnswer: rubric.modelAnswer ?? "(none written)",
    criteria: rubric.criteria.map((c) => ({ point: c.point, marks: c.marks ?? 0 })),
    exchange: request.exchange,
    probesLeft: Math.min(MAX_PROBES, request.probesLeft),
  };
  const job = await enqueue("VIVA", { relay }, question.lectureId);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true, result: true, error: true } });
    if (!now) break;
    if (now.status === "DONE") return VivaMoveSchema.parse(JSON.parse(now.result ?? "{}"));
    if (now.status === "FAILED") throw new Error(now.error ?? "The examiner couldn't answer.");
  }
  await prisma.job.updateMany({ where: { id: job.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: "The phone stopped waiting" } });
  throw new Error("The computer's examiner took too long to answer.");
}
