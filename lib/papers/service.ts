import { prisma } from "@/lib/db";
import { throwIfCancelled } from "@/lib/llm/cancel";
import type { LlmProvider } from "@/lib/llm/provider";
import { ingestFile } from "@/lib/materials";
import { toTen } from "@/lib/papers/schema";
import { closest } from "@/lib/progress/related";

/** A past paper is read, split into questions and given marking guides in the background. */
export async function addPaper(courseId: string, file: File, year?: number) {
  await prisma.course.findUniqueOrThrow({ where: { id: courseId }, select: { id: true } });
  const { materialId } = await ingestFile({ file, courseId, kind: "PAST_PAPER" });
  const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId }, select: { extractedText: true } });
  if (!material.extractedText?.trim()) {
    await prisma.material.delete({ where: { id: materialId } });
    throw new Error("No text could be read from that file. If it's a scan, save it as a PDF with selectable text first.");
  }
  const name = file.name.replace(/\.[a-z0-9]+$/i, "");
  const paper = await prisma.pastPaper.create({
    data: { courseId, materialId, year: year ?? Number(/(?:19|20)\d\d/.exec(name)?.[0] ?? new Date().getFullYear()), label: name.slice(0, 120) },
  });
  await prisma.job.create({ data: { kind: "PAPER", payload: JSON.stringify({ paperId: paper.id }), lectureId: null } });
  return paper.id;
}

/**
 * The worker's half: splits the paper into questions, files each under the lecture
 * it tests (by the concepts it's tagged with, else by the words it shares), and has
 * each lecture's questions given marking guides — so they're marked like any LAQ.
 */
export async function splitPaper(paperId: string, provider: LlmProvider) {
  const paper = await prisma.pastPaper.findUniqueOrThrow({
    where: { id: paperId },
    include: { material: { select: { extractedText: true } }, items: { select: { id: true } } },
  });
  const text = paper.material?.extractedText?.trim();
  if (!text) throw new Error("This paper has no readable text.");
  const [concepts, lectures] = await Promise.all([
    prisma.concept.findMany({ where: { courseId: paper.courseId, mergedIntoId: null }, select: { id: true, name: true, definition: true, lectureId: true } }),
    prisma.lecture.findMany({
      where: { courseId: paper.courseId, summaryMd: { not: null } },
      select: { id: true, title: true, summaryMd: true, concepts: { where: { mergedIntoId: null }, select: { id: true, name: true, definition: true } } },
    }),
  ]);
  if (!lectures.length) throw new Error("Prepare this course's lectures first: a paper's questions are marked against them.");

  const { items } = await provider.parsePastPaper({
    paperText: text.slice(0, 60_000),
    concepts: concepts.map(({ id, name, definition }) => ({ id, name, definition })),
  });
  throwIfCancelled();
  const parseVersion = provider.lastPromptVersion;
  if (!items.length) throw new Error("No questions were found in that paper.");

  // A retry starts over: the last attempt's items and questions go.
  if (paper.items.length) {
    const old = paper.items.map((i) => i.id);
    await prisma.question.deleteMany({ where: { paperItemId: { in: old }, responses: { none: {} } } });
    await prisma.paperItem.deleteMany({ where: { id: { in: old } } });
  }

  const known = new Map(concepts.map((c) => [c.id, c]));
  const docs = lectures.map((l) => ({ id: l.id, text: [l.summaryMd ?? "", ...l.concepts.map((c) => `${c.name}. ${c.definition}`)].join("\n") }));
  const placed: Array<{ itemId: string; lectureId: string; stem: string; marks: number | null; conceptIds: string[]; number: string | null }> = [];
  let unplaced = 0;
  for (const item of items) {
    const conceptIds = [...new Set(item.conceptIds)].filter((id) => known.has(id));
    const saved = await prisma.paperItem.create({
      data: {
        paperId,
        stem: item.stem,
        marksAllocated: item.marksAllocated,
        questionNumber: item.questionNumber,
        concepts: { create: conceptIds.map((conceptId) => ({ conceptId })) },
      },
    });
    // The lecture most of its concepts come from; failing that, the one it shares most words with.
    const tally = new Map<string, number>();
    for (const id of conceptIds) {
      const lectureId = known.get(id)!.lectureId;
      if (lectureId && lectures.some((l) => l.id === lectureId)) tally.set(lectureId, (tally.get(lectureId) ?? 0) + 1);
    }
    const lectureId = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? closest(item.stem, docs)?.id;
    if (!lectureId) {
      unplaced++;
      continue;
    }
    placed.push({ itemId: saved.id, lectureId, stem: item.stem, marks: item.marksAllocated, conceptIds, number: item.questionNumber });
  }

  let questions = 0;
  const byLecture = new Map<string, typeof placed>();
  for (const p of placed) byLecture.set(p.lectureId, [...(byLecture.get(p.lectureId) ?? []), p]);
  for (const [lectureId, group] of byLecture) {
    const lecture = lectures.find((l) => l.id === lectureId)!;
    // Guides in batches, so a long paper's answer from the model stays a sensible size.
    for (let i = 0; i < group.length; i += 8) {
      const batch = group.slice(i, i + 8);
      const keys = new Map(batch.map((p, k) => [`q${k + 1}`, p]));
      const { guides } = await provider.writePaperGuides({
        lectureTitle: lecture.title,
        summary: lecture.summaryMd ?? "",
        concepts: lecture.concepts,
        questions: [...keys].map(([key, p]) => ({ key, stem: p.stem, marks: p.marks })),
      });
      throwIfCancelled();
      for (const g of guides) {
        const p = keys.get(g.key);
        if (!p) continue;
        keys.delete(g.key);
        await prisma.question.create({
          data: {
            lectureId,
            stem: p.stem,
            type: "LAQ",
            rubric: JSON.stringify({ modelAnswer: g.modelAnswer, criteria: toTen(g.criteria), totalMarks: 10 }),
            promptVersion: `${parseVersion} + ${provider.lastPromptVersion}`,
            model: provider.lastModel,
            paperItemId: p.itemId,
            // A question about no concept still marks; it just doesn't move concept scores.
            concepts: { create: p.conceptIds.map((conceptId) => ({ conceptId })) },
          },
        });
        questions++;
      }
    }
  }
  return { items: items.length, questions, unplaced };
}

export interface PaperRow {
  id: string;
  courseId: string;
  courseCode: string;
  label: string;
  year: number;
  questions: number;
  marks: number | null;
  job: { status: string; error: string | null } | null;
  sat: number;
}

/** Past papers, with how far along each is and how many times it's been sat. */
export async function paperRows(): Promise<PaperRow[]> {
  const papers = await prisma.pastPaper.findMany({
    orderBy: [{ year: "desc" }, { createdAt: "desc" }],
    include: { course: { select: { code: true } }, items: { select: { id: true, marksAllocated: true } } },
  });
  if (!papers.length) return [];
  const [jobs, questions, exams] = await Promise.all([
    prisma.job.findMany({ where: { kind: "PAPER" }, orderBy: { createdAt: "desc" }, select: { payload: true, status: true, error: true } }),
    prisma.question.groupBy({ by: ["paperItemId"], where: { paperItemId: { in: papers.flatMap((p) => p.items.map((i) => i.id)) } }, _count: true }),
    prisma.exam.findMany({ where: { scope: { contains: '"paperId"' }, submittedAt: { not: null } }, select: { scope: true } }),
  ]);
  const withQuestion = new Set(questions.map((q) => q.paperItemId));
  return papers.map((p) => {
    const job = jobs.find((j) => j.payload.includes(p.id));
    const marks = p.items.reduce((n, i) => n + (i.marksAllocated ?? 0), 0);
    return {
      id: p.id,
      courseId: p.courseId,
      courseCode: p.course.code,
      label: p.label ?? String(p.year),
      year: p.year,
      questions: p.items.filter((i) => withQuestion.has(i.id)).length,
      marks: marks || null,
      job: job ? { status: job.status, error: job.error } : null,
      sat: exams.filter((e) => e.scope.includes(p.id)).length,
    };
  });
}

/** Sitting a past paper: its questions in order, as an exam. */
export async function createPaperExam(paperId: string, timeLimitMin: number | null): Promise<string> {
  const paper = await prisma.pastPaper.findUniqueOrThrow({
    where: { id: paperId },
    include: { course: { select: { id: true, code: true } }, items: { orderBy: { id: "asc" }, select: { id: true, questionNumber: true } } },
  });
  const questions = await prisma.question.findMany({
    where: { paperItemId: { in: paper.items.map((i) => i.id) } },
    select: { id: true, paperItemId: true, createdAt: true },
  });
  if (!questions.length) throw new Error("This paper's questions aren't ready yet.");
  const order = new Map(paper.items.map((i, k) => [i.id, k]));
  questions.sort((a, b) => (order.get(a.paperItemId!) ?? 0) - (order.get(b.paperItemId!) ?? 0));
  const exam = await prisma.exam.create({
    data: {
      courseId: paper.course.id,
      title: `${paper.course.code} past paper: ${paper.label ?? paper.year}`,
      scope: JSON.stringify({ paperId }),
      timeLimitMin: timeLimitMin && timeLimitMin > 0 ? Math.min(600, Math.round(timeLimitMin)) : null,
      items: { create: questions.map((q, i) => ({ position: i, kind: "LAQ", questionId: q.id })) },
    },
  });
  return exam.id;
}

/** Deletes a paper; questions already answered stay, so their marks and sittings keep making sense. */
export async function deletePaper(paperId: string) {
  const items = await prisma.paperItem.findMany({ where: { paperId }, select: { id: true } });
  await prisma.question.deleteMany({ where: { paperItemId: { in: items.map((i) => i.id) }, responses: { none: {} } } });
  const paper = await prisma.pastPaper.findUnique({ where: { id: paperId }, select: { materialId: true } });
  await prisma.pastPaper.deleteMany({ where: { id: paperId } });
  if (paper?.materialId) await prisma.material.deleteMany({ where: { id: paper.materialId } });
}
