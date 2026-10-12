import { prisma } from "@/lib/db";
import { allocate } from "@/lib/engines/allocation";
import { geometricMean } from "@/lib/engines/geomean";
import { conceptMastery, questionBudget } from "@/lib/engines/mastery";
import { getProvider } from "@/lib/llm";
import { mergeSkipped } from "@/lib/parse/aims";
import { lectureSources } from "@/lib/sources";

/**
 * The steps the worker runs. Each reads what it needs fresh from the database and
 * writes its result before returning, so a job that fails half-way leaves every
 * finished step in place and a retry picks up from the first unfinished one.
 */

/** Title, set-aside sections, summary and concepts for one lecture, in one model call. */
export async function digestLecture(lectureId: string, opts: { keepSummary: boolean }) {
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: lectureId },
    include: { materials: true },
  });
  const sources = lectureSources(lecture.materials);

  // The whole course's concepts go in, so the model reuses an id rather than
  // minting a synonym. Merged-away concepts are excluded — they are dead ids.
  const existing = await prisma.concept.findMany({
    where: { courseId: lecture.courseId, mergedIntoId: null },
    select: { id: true, name: true, definition: true },
  });

  const digest = await getProvider().digest({
    currentTitle: lecture.title,
    titleIsPlaceholder: lecture.autoTitle,
    durationHours: lecture.durationHours,
    transcript: sources.transcript,
    slidesText: sources.slidesText,
    alreadySkipped: sources.skipped,
    existingConcepts: existing,
  });

  const knownIds = new Set(existing.map((c) => c.id));
  let reused = 0;
  let minted = 0;
  for (const c of digest.concepts) {
    if (c.existingId && knownIds.has(c.existingId)) {
      // Reuse means "this lecture also covers it" — never overwrite the original
      // wording, or the id stops meaning one stable thing.
      reused++;
      continue;
    }
    await prisma.concept.create({
      data: {
        courseId: lecture.courseId,
        lectureId,
        name: c.name,
        definition: c.definition,
        sourceRef: c.sourceRef,
      },
    });
    minted++;
  }

  const keep = opts.keepSummary && !!lecture.summaryMd;
  await prisma.lecture.update({
    where: { id: lectureId },
    data: {
      // A title the student typed is theirs; only a filename placeholder is replaced.
      ...(lecture.autoTitle ? { title: digest.title.trim(), autoTitle: false } : {}),
      summaryMd: keep ? lecture.summaryMd : digest.summaryMd,
      skipped: JSON.stringify(mergeSkipped([...sources.skipped, ...digest.skipped])),
    },
  });
  return { title: digest.title, reused, minted, skipped: digest.skipped.length + sources.skipped.length };
}

/**
 * Writes LAQs for a lecture. The allocation is adaptive: concepts you have never
 * been asked about, or keep scoring badly on, get the questions.
 */
export async function writeQuestions(lectureId: string) {
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: lectureId },
    include: { materials: true, concepts: { where: { mergedIntoId: null } } },
  });
  if (lecture.concepts.length === 0) {
    throw new Error("this lecture has no concepts yet — prepare it first");
  }
  const sources = lectureSources(lecture.materials);

  const mastery = await conceptMastery(lecture.concepts.map((c) => c.id));
  const budget = questionBudget(lecture.durationHours);
  const allocation = allocate(mastery, budget);
  if (allocation.length === 0) {
    return { generated: 0, budget, note: "every concept in this lecture is already at 10/10" };
  }

  const provider = getProvider();
  const { questions } = await provider.generateQuestions({
    lectureTitle: lecture.title,
    transcript: sources.transcript,
    slidesText: sources.slidesText,
    concepts: lecture.concepts.map((c) => ({ id: c.id, name: c.name, definition: c.definition })),
    allocation,
    type: "LAQ",
  });

  const known = new Set(lecture.concepts.map((c) => c.id));
  let generated = 0;
  for (const q of questions) {
    const conceptIds = q.conceptIds.filter((id) => known.has(id));
    if (conceptIds.length === 0) continue; // a question about nothing cannot be scored
    await prisma.question.create({
      data: {
        lectureId,
        stem: q.stem,
        type: q.type,
        rubric: JSON.stringify(q.rubric),
        promptVersion: provider.lastPromptVersion,
        concepts: { create: conceptIds.map((conceptId) => ({ conceptId })) },
      },
    });
    generated++;
  }
  return { generated, budget, targeted: allocation.length };
}

export async function markResponse(responseId: string) {
  const response = await prisma.response.findUniqueOrThrow({
    where: { id: responseId },
    include: { question: { include: { concepts: { include: { concept: true } } } } },
  });
  if (!response.answerText.trim()) throw new Error("nothing was written for this question");

  const concepts = response.question.concepts.map((qc) => ({
    id: qc.concept.id,
    name: qc.concept.name,
    definition: qc.concept.definition,
  }));

  const marking = await getProvider().mark({
    questionStem: response.question.stem,
    // The rubric was frozen when the question was written. Marking applies it.
    rubric: JSON.parse(response.question.rubric),
    answerText: response.answerText,
    concepts,
  });

  const allowed = new Set(concepts.map((c) => c.id));
  await prisma.$transaction([
    prisma.response.update({
      where: { id: responseId },
      data: {
        mark: marking.mark,
        rubricVersion: response.question.promptVersion,
        rawMarkingJson: JSON.stringify(marking),
        markedAt: new Date(),
      },
    }),
    prisma.gap.deleteMany({ where: { responseId } }),
    ...marking.gaps
      // A gap must cite a concept this question covers, or recurrence counting breaks.
      .filter((g) => allowed.has(g.conceptId))
      .map((g) =>
        prisma.gap.create({ data: { responseId, conceptId: g.conceptId, type: g.type, text: g.text } }),
      ),
  ]);

  await scoreAttemptIfMarked(response.attemptId);
  return { mark: marking.mark, gaps: marking.gaps.length };
}

/** An attempt is scored only once every answered question in it has a mark. */
export async function scoreAttemptIfMarked(attemptId: string) {
  const responses = await prisma.response.findMany({
    where: { attemptId },
    select: { mark: true, answerText: true },
  });
  if (responses.length === 0 || responses.some((r) => r.mark === null)) return null;
  const score = geometricMean(responses.map((r) => r.mark as number));
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { geometricMean: score, completedAt: new Date() },
  });
  return score;
}
