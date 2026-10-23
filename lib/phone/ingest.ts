import { prisma } from "@/lib/db";
import { reviewCard } from "@/lib/flashcards/service";
import type { Rating } from "@/lib/flashcards/schedule";
import { enqueue } from "@/lib/jobs";
import { MarkingSchema } from "@/lib/llm/schemas";
import { usesAi } from "@/lib/modes";
import type { PhoneExam, PhoneReview, PhoneSitting, PhoneViva } from "@/lib/phone/schema";
import { applyMarking, scoreAttemptIfMarked } from "@/lib/pipeline";
import { getSettings } from "@/lib/settings";

/**
 * What the phone did while it was away: sittings answered (marked on the phone with
 * the API key, or left for this computer to mark) and AK cards reviewed.
 *
 * Everything is keyed by ids the phone made, so sending the same thing twice — a
 * sync that dropped before its reply arrived — changes nothing the second time.
 */

/** Never later than now: a phone's clock running fast can't schedule the future. */
function when(iso: string, now: Date): Date {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t) : now;
}

export interface SittingOutcome {
  id: string;
  /** Answers the phone marked, kept. */
  marked: number;
  /** Answers queued for this computer to mark. */
  queued: number;
  note: string | null;
}

export async function ingestSitting(sitting: PhoneSitting, now = new Date(), source: "APP" | "EXAM" | "VIVA" = "APP"): Promise<SittingOutcome> {
  const outcome: SittingOutcome = { id: sitting.id, marked: 0, queued: 0, note: null };
  if (await prisma.attempt.findUnique({ where: { id: sitting.id }, select: { id: true } })) {
    return { ...outcome, note: "already received" };
  }
  const lecture = await prisma.lecture.findUnique({
    where: { id: sitting.lectureId },
    select: { id: true, questions: { select: { id: true } } },
  });
  if (!lecture) return { ...outcome, note: "this lecture is no longer on the computer" };
  const asked = new Set(lecture.questions.map((q) => q.id));
  const responses = sitting.responses.filter((r) => asked.has(r.questionId));
  if (!responses.length) return { ...outcome, note: "these questions are no longer on the computer" };
  // A response id the computer already has (vanishingly unlikely) would make the sitting fail.
  const taken = await prisma.response.findMany({ where: { id: { in: responses.map((r) => r.id) } }, select: { id: true } });
  if (taken.length) return { ...outcome, note: "this sitting's answers clash with ones already saved" };

  // As submitAttempt: a blank answer scores 0, as it would in the exam.
  await prisma.attempt.create({
    data: {
      id: sitting.id,
      lectureId: lecture.id,
      sittingDate: when(sitting.startedAt, now),
      closedBook: true,
      source,
      responses: {
        create: responses.map((r) => {
          const text = r.answerText.trim();
          return text
            ? { id: r.id, questionId: r.questionId, answerText: text }
            : {
                id: r.id,
                questionId: r.questionId,
                answerText: "",
                mark: 0,
                markedAt: when(sitting.submittedAt, now),
                rawMarkingJson: JSON.stringify({ source: "blank", feedback: [{ kind: "missed", text: "Left blank." }] }),
              };
        }),
      },
    },
  });

  const { mode } = await getSettings();
  for (const r of responses) {
    if (!r.answerText.trim()) continue;
    const marking = r.marking === undefined || r.marking === null ? null : MarkingSchema.safeParse(r.marking);
    if (marking?.success) {
      await applyMarking(r.id, marking.data);
      outcome.marked++;
    } else if (usesAi(mode)) {
      await enqueue("MARK", { responseId: r.id }, lecture.id);
      outcome.queued++;
    }
  }
  await scoreAttemptIfMarked(sitting.id);
  return outcome;
}

/**
 * An exam sat on the phone: its long answers become a sitting of each lecture (marked
 * as any are), and the exam itself is kept with its multiple-choice answers, so it
 * shows with the computer's own exams.
 */
export async function ingestExam(exam: PhoneExam, now = new Date()): Promise<{ id: string; note: string | null }> {
  if (await prisma.exam.findUnique({ where: { id: exam.id }, select: { id: true } })) return { id: exam.id, note: "already received" };
  for (const s of exam.sittings) await ingestSitting(s, now, "EXAM");
  const [mcqs, questions, responses] = await Promise.all([
    prisma.mcq.findMany({ where: { id: { in: exam.items.flatMap((i) => (i.mcqId ? [i.mcqId] : [])) } }, select: { id: true } }),
    prisma.question.findMany({ where: { id: { in: exam.items.flatMap((i) => (i.questionId ? [i.questionId] : [])) } }, select: { id: true } }),
    prisma.response.findMany({ where: { id: { in: exam.items.flatMap((i) => (i.responseId ? [i.responseId] : [])) } }, select: { id: true } }),
  ]);
  const has = (ids: Array<{ id: string }>) => new Set(ids.map((x) => x.id));
  const [mcqIds, questionIds, responseIds] = [has(mcqs), has(questions), has(responses)];
  const lectureIds = [...new Set(exam.sittings.map((s) => s.lectureId))];
  await prisma.exam.create({
    data: {
      id: exam.id,
      title: exam.title.trim() || "Exam on iPhone",
      scope: JSON.stringify({ lectureIds, phone: true }),
      timeLimitMin: exam.timeLimitMin,
      createdAt: when(exam.startedAt, now),
      submittedAt: when(exam.submittedAt, now),
      items: {
        create: exam.items.map((item, position) => ({
          position,
          kind: item.kind,
          mcqId: item.mcqId && mcqIds.has(item.mcqId) ? item.mcqId : null,
          choice: item.kind === "MCQ" ? (item.choice ?? null) : null,
          questionId: item.questionId && questionIds.has(item.questionId) ? item.questionId : null,
          responseId: item.responseId && responseIds.has(item.responseId) ? item.responseId : null,
        })),
      },
    },
  });
  return { id: exam.id, note: null };
}

export interface ReviewOutcome {
  id: string;
  saved: boolean;
  reason: string | null;
}

/** Reviews in the order they were made, each against the card version the phone saw. */
export async function ingestReviews(reviews: PhoneReview[], now = new Date()): Promise<ReviewOutcome[]> {
  const ordered = [...reviews].sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt));
  const out: ReviewOutcome[] = [];
  for (const r of ordered) {
    try {
      const result = await reviewCard(r.cardId, r.version, r.rating as Rating, when(r.reviewedAt, now));
      out.push({ id: r.id, saved: result.saved, reason: result.reason });
    } catch {
      out.push({ id: r.id, saved: false, reason: "This card is no longer on the computer." });
    }
  }
  return out;
}

/**
 * A viva held on the phone: its answers become a sitting of each lecture (source VIVA),
 * marked as any are, and the viva is kept with everything said, so it shows with the
 * computer's own vivas.
 */
export async function ingestViva(viva: PhoneViva, now = new Date()): Promise<{ id: string; note: string | null }> {
  if (await prisma.viva.findUnique({ where: { id: viva.id }, select: { id: true } })) return { id: viva.id, note: "already received" };
  for (const s of viva.sittings) await ingestSitting(s, now, "VIVA");
  const responseIds = viva.plan.flatMap((p) => (p.responseId ? [p.responseId] : []));
  const kept = new Set((await prisma.response.findMany({ where: { id: { in: responseIds } }, select: { id: true } })).map((r) => r.id));
  const plan = viva.plan.map((p) => ({
    questionId: p.questionId,
    lectureId: p.lectureId,
    ...(p.responseId && kept.has(p.responseId) ? { responseId: p.responseId } : {}),
  }));
  await prisma.viva.create({
    data: {
      id: viva.id,
      title: viva.title.trim() || "Viva on iPhone",
      plan: JSON.stringify(plan),
      turns: JSON.stringify(viva.turns),
      current: plan.length,
      waitingOn: "done",
      createdAt: when(viva.startedAt, now),
      finishedAt: when(viva.submittedAt, now),
    },
  });
  return { id: viva.id, note: null };
}
