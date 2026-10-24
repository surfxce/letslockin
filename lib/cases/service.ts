import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { throwIfCancelled } from "@/lib/llm/cancel";
import type { LlmProvider } from "@/lib/llm/provider";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";
import { readLectureIds, readStages, stageStem, type CaseStage } from "@/lib/cases/schema";
import { readPlan, type VivaPlanItem, type VivaTurn } from "@/lib/viva/schema";

/** Lectures one case is written from, at most: one patient can't cover a module. */
export const MAX_CASE_LECTURES = 4;

/** Queues a case written from these lectures (one course's, prepared). Returns the job. */
export async function requestCase(lectureIds: string[]): Promise<string> {
  if (!usesAi((await getSettings()).mode)) throw new Error("Writing a case needs an AI — choose one in Settings.");
  const lectures = await prisma.lecture.findMany({
    where: { id: { in: [...new Set(lectureIds)] }, summaryMd: { not: null } },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: { id: true, courseId: true },
  });
  if (!lectures.length) throw new Error("Choose a lecture that's been prepared.");
  if (new Set(lectures.map((l) => l.courseId)).size > 1) throw new Error("Choose lectures from one course: a case is one patient.");
  if (lectures.length > MAX_CASE_LECTURES) throw new Error(`Choose up to ${MAX_CASE_LECTURES} lectures for one case.`);
  const ids = lectures.map((l) => l.id);
  const waiting = await prisma.job.findFirst({
    where: { kind: "CASE", status: { in: ["PENDING", "RUNNING"] }, payload: JSON.stringify({ lectureIds: ids }) },
    select: { id: true },
  });
  if (waiting) return waiting.id;
  return (await enqueue("CASE", { lectureIds: ids }, ids[0])).id;
}

/** Run by the worker: the AI writes the case; each stage is saved as a question of its own. */
export async function writeCase(lectureIds: string[], provider: LlmProvider) {
  const lectures = await prisma.lecture.findMany({
    where: { id: { in: lectureIds }, summaryMd: { not: null } },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      courseId: true,
      title: true,
      summaryMd: true,
      concepts: { where: { mergedIntoId: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, definition: true } },
    },
  });
  if (!lectures.length) throw new Error("Those lectures are gone, or not prepared.");
  const before = await prisma.clinicalCase.findMany({ where: { courseId: lectures[0].courseId }, select: { title: true, lectureIds: true } });
  const ids = new Set(lectures.map((l) => l.id));
  const draft = await provider.writeCase({
    lectures: lectures.map((l) => ({ title: l.title, summary: l.summaryMd ?? "", concepts: l.concepts })),
    avoid: before.filter((c) => readLectureIds(c.lectureIds).some((id) => ids.has(id))).map((c) => c.title),
  });
  throwIfCancelled();

  const owner = new Map(lectures.flatMap((l) => l.concepts.map((c) => [c.id, l.id] as const)));
  const concepts = lectures.flatMap((l) => l.concepts);
  const created = await prisma.clinicalCase.create({
    data: {
      courseId: lectures[0].courseId,
      title: draft.title,
      presentation: draft.presentation,
      stages: "[]",
      lectureIds: JSON.stringify(lectures.map((l) => l.id)),
      promptVersion: provider.lastPromptVersion,
      model: provider.lastModel,
    },
  });
  try {
    const stages: CaseStage[] = [];
    for (const [i, s] of draft.stages.entries()) {
      // Concepts it tests, from these lectures: cited, or else named in it.
      let conceptIds = [...new Set(s.conceptIds)].filter((id) => owner.has(id));
      if (!conceptIds.length) {
        const words = `${s.ask} ${s.reveal} ${s.rubric.modelAnswer}`.toLowerCase();
        conceptIds = concepts.filter((c) => words.includes(c.name.toLowerCase())).map((c) => c.id).slice(0, 4);
      }
      const question = await prisma.question.create({
        data: {
          // Filed under the lecture of what it tests, so its mark counts there.
          lectureId: owner.get(conceptIds[0]) ?? lectures[0].id,
          stem: stageStem(draft.presentation, draft.stages.slice(0, i), s, i + 1, draft.stages.length),
          type: "LAQ",
          rubric: JSON.stringify(s.rubric),
          promptVersion: provider.lastPromptVersion,
          model: provider.lastModel,
          caseId: created.id,
          concepts: { create: conceptIds.map((conceptId) => ({ conceptId })) },
        },
      });
      stages.push({ questionId: question.id, kind: s.kind, ask: s.ask, reveal: s.reveal });
    }
    await prisma.clinicalCase.update({ where: { id: created.id }, data: { stages: JSON.stringify(stages) } });
  } catch (err) {
    await prisma.clinicalCase.delete({ where: { id: created.id } }).catch(() => undefined);
    throw err;
  }
  return { caseId: created.id, stages: draft.stages.length };
}

/** Runs a case as a viva: the presentation and first stage's question are put at once. */
export async function startCase(caseId: string): Promise<string> {
  if (!usesAi((await getSettings()).mode)) throw new Error("A case needs an AI to be the examiner — choose one in Settings.");
  const found = await prisma.clinicalCase.findUnique({ where: { id: caseId }, include: { questions: { select: { id: true, lectureId: true } } } });
  if (!found) throw new Error("That case isn't here any more.");
  const lectureOf = new Map(found.questions.map((q) => [q.id, q.lectureId]));
  const stages = readStages(found.stages).filter((s) => lectureOf.has(s.questionId));
  if (!stages.length) throw new Error("That case has no stages left to ask.");
  const plan: VivaPlanItem[] = stages.map((s) => ({ questionId: s.questionId, lectureId: lectureOf.get(s.questionId)! }));
  const first: VivaTurn = { role: "examiner", text: `${found.presentation}\n\n${stages[0].ask}`, questionId: stages[0].questionId, at: new Date().toISOString() };
  const viva = await prisma.viva.create({
    data: { courseId: found.courseId, title: found.title, plan: JSON.stringify(plan), turns: JSON.stringify([first]), caseId: found.id },
  });
  return viva.id;
}

/** A case's stages, for running it: what each asks and what it reveals. */
export async function caseStages(caseId: string): Promise<CaseStage[]> {
  const found = await prisma.clinicalCase.findUnique({ where: { id: caseId }, select: { stages: true } });
  return readStages(found?.stages);
}

export async function deleteCase(caseId: string) {
  await prisma.clinicalCase.deleteMany({ where: { id: caseId } });
}

export interface CaseRow {
  id: string;
  title: string;
  courseCode: string;
  lectures: string[];
  stages: string[];
  createdAt: Date;
  /** The latest time it was run, if ever: its viva, and its mean mark once marked. */
  last: { vivaId: string; done: boolean; mean: number | null; marking: boolean } | null;
}

/** Every case, newest first, with how it last went. */
export async function caseRows(): Promise<CaseRow[]> {
  const cases = await prisma.clinicalCase.findMany({ orderBy: { createdAt: "desc" }, include: { course: { select: { code: true } } } });
  const allLectureIds = [...new Set(cases.flatMap((c) => readLectureIds(c.lectureIds)))];
  const [lectures, vivas] = await Promise.all([
    prisma.lecture.findMany({ where: { id: { in: allLectureIds } }, select: { id: true, title: true } }),
    prisma.viva.findMany({ where: { caseId: { in: cases.map((c) => c.id) } }, orderBy: { createdAt: "desc" } }),
  ]);
  const title = new Map(lectures.map((l) => [l.id, l.title]));
  const latest = new Map<string, (typeof vivas)[number]>();
  for (const v of vivas) if (v.caseId && !latest.has(v.caseId)) latest.set(v.caseId, v);
  const responseIds = [...latest.values()].flatMap((v) => readPlan(v.plan).flatMap((p) => (p.responseId ? [p.responseId] : [])));
  const marks = new Map(
    (await prisma.response.findMany({ where: { id: { in: responseIds } }, select: { id: true, mark: true } })).map((r) => [r.id, r.mark]),
  );
  return cases.map((c) => {
    const v = latest.get(c.id);
    const got = v ? readPlan(v.plan).flatMap((p) => (p.responseId ? [marks.get(p.responseId) ?? null] : [])) : [];
    const marked = got.filter((m): m is number => m !== null);
    return {
      id: c.id,
      title: c.title,
      courseCode: c.course.code,
      lectures: readLectureIds(c.lectureIds).flatMap((id) => (title.has(id) ? [title.get(id)!] : [])),
      stages: readStages(c.stages).map((s) => s.kind),
      createdAt: c.createdAt,
      last: v
        ? {
            vivaId: v.id,
            done: v.waitingOn === "done",
            mean: got.length && marked.length === got.length ? marked.reduce((a, b) => a + b, 0) / marked.length : null,
            marking: marked.length < got.length,
          }
        : null,
    };
  });
}
