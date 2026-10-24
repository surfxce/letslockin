import { prisma } from "@/lib/db";
import { readLinked } from "@/lib/mixed/schema";
import { pickQuestions } from "@/lib/engines/attempt";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { markVars } from "@/lib/llm/prompts";
import { renderMarkdown, type SlideImages } from "@/lib/markdown";
import { CLOUD_ENGINE_LABEL } from "@/lib/modes";
import { phoneHandwritingTemplate, phoneMarkingTemplate, phoneVivaTemplate } from "@/lib/phone/marking";
import { computerName } from "@/lib/phone/pairing";
import type { PhoneSnapshot } from "@/lib/phone/schema";
import { getSettings } from "@/lib/settings";
import { lectureDecks, pictured } from "@/lib/slides";
import { lectureRows } from "@/lib/views";
import { readOptions } from "@/lib/mcq/service";
import { readStages } from "@/lib/cases/schema";

/** Pictures in the phone's copy point here; the app serves them from its own cache. */
export const SLIDE_SCHEME = "lockin-slide";

/** Sittings sent per lecture, newest first. */
const SITTINGS_PER_LECTURE = 12;

/** Card pictures added by hand are fetched like slides, as "card/<name>". */
export function phoneCardImages(html: string, lectureId: string): string {
  return html.replace(/(<img src=")\/api\/ak\/images\/([a-f0-9]{24}\.(?:png|jpg|webp|gif))"/g, `$1${SLIDE_SCHEME}://${lectureId}/card/$2"`);
}

/** "<n>", "<n>?crop=…" and "card/<name>" for every picture in some rendered HTML of one lecture. */
export function imageRefs(html: string, lectureId: string): string[] {
  const prefix = `${SLIDE_SCHEME}://${lectureId}/`;
  const refs: string[] = [];
  for (const m of html.matchAll(/<img src="([^"]+)"/g)) {
    if (m[1].startsWith(prefix)) refs.push(m[1].slice(prefix.length).replace(/&amp;/g, "&"));
  }
  return refs;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

type QuestionRow = {
  id: string;
  stem: string;
  type: string;
  rubric: string;
  paperItemId: string | null;
  linkedLectureIds: string | null;
  concepts: Array<{ concept: { id: string; name: string; definition: string } }>;
};

const QUESTION_SELECT = {
  id: true,
  stem: true,
  type: true,
  rubric: true,
  paperItemId: true,
  linkedLectureIds: true,
  concepts: { select: { concept: { select: { id: true, name: true, definition: true } } } },
} as const;

/** A question as the phone asks it, with what it needs to mark it the computer's way. */
function phoneQuestion(q: QuestionRow) {
  const rubric = readRubric(q.rubric);
  let rubricValue: unknown = {};
  try {
    rubricValue = JSON.parse(q.rubric);
  } catch {
    // Shown without one; marking on the computer reports the problem.
  }
  const vars = markVars({
    questionStem: q.stem,
    rubric: rubricValue as Parameters<typeof markVars>[0]["rubric"],
    answerText: "",
    concepts: q.concepts.map((qc) => qc.concept),
  });
  return {
    id: q.id,
    stem: q.stem,
    type: q.type,
    modelAnswer: rubric.modelAnswer,
    criteria: rubric.criteria,
    markVars: { questionStem: vars.questionStem, rubric: vars.rubric, concepts: vars.concepts },
    fromPaper: q.paperItemId !== null,
    ...(q.linkedLectureIds ? { linkedLectureIds: readLinked(q.linkedLectureIds) } : {}),
  };
}

/** Everything the phone shows, rendered the way the computer renders it. */
export async function buildSnapshot(): Promise<PhoneSnapshot> {
  const settings = await getSettings();
  const [courses, lectures, attempts, cards, markJobs, marking, rows, mcqs] = await Promise.all([
    prisma.course.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, code: true, title: true, examDate: true } }),
    prisma.lecture.findMany({
      orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        courseId: true,
        title: true,
        deliveredOn: true,
        summaryMd: true,
        summaryModel: true,
        module: { select: { title: true } },
        questions: {
          // A clinical case's stages come with the case, never as the lecture's questions.
          where: { caseId: null },
          orderBy: { createdAt: "asc" },
          select: QUESTION_SELECT,
        },
      },
    }),
    prisma.attempt.findMany({
      orderBy: { sittingDate: "desc" },
      select: {
        id: true,
        lectureId: true,
        sittingDate: true,
        completedAt: true,
        geometricMean: true,
        responses: {
          select: {
            id: true,
            questionId: true,
            answerText: true,
            mark: true,
            rawMarkingJson: true,
            gaps: { select: { type: true, text: true, concept: { select: { name: true } } } },
          },
        },
      },
    }),
    // Suspended cards stay off the phone, as they stay out of reviews here.
    prisma.flashcard.findMany({ where: { suspended: false }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.job.findMany({ where: { kind: "MARK", status: { in: ["PENDING", "RUNNING"] } }, select: { payload: true } }),
    phoneMarkingTemplate(),
    lectureRows(),
    prisma.mcq.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, lectureId: true, stem: true, options: true, answer: true, explanation: true } }),
  ]);
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const viva = await phoneVivaTemplate();
  const handwriting = await phoneHandwritingTemplate();
  const cases = await prisma.clinicalCase.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { questions: { select: { ...QUESTION_SELECT, lectureId: true } } },
  });

  const waiting = new Set<string>();
  for (const job of markJobs) {
    try {
      const id = JSON.parse(job.payload)?.responseId;
      if (typeof id === "string") waiting.add(id);
    } catch {
      // A job whose payload can't be read marks nothing.
    }
  }

  const ordinal = new Map<string, number>();
  const counted = new Map<string, number>();
  for (const l of lectures) {
    const n = (counted.get(l.courseId) ?? 0) + 1;
    counted.set(l.courseId, n);
    ordinal.set(l.id, n);
  }

  const cardsByLecture = new Map<string, typeof cards>();
  for (const c of cards) cardsByLecture.set(c.lectureId, [...(cardsByLecture.get(c.lectureId) ?? []), c]);

  const phoneLectures: PhoneSnapshot["lectures"] = [];
  const phoneCards: PhoneSnapshot["cards"] = [];
  for (const l of lectures) {
    const deckCards = cardsByLecture.get(l.id) ?? [];
    let slides: SlideImages | undefined;
    if (l.summaryMd?.trim() || deckCards.length) {
      slides = { base: `${SLIDE_SCHEME}://${l.id}`, ranges: pictured(await lectureDecks(l.id)), print: true };
    }
    const summaryHtml = l.summaryMd?.trim() ? renderMarkdown(l.summaryMd, slides) : null;
    const images = summaryHtml ? imageRefs(summaryHtml, l.id) : [];
    for (const c of deckCards) {
      const frontHtml = phoneCardImages(renderMarkdown(c.front, slides), l.id);
      const backHtml = phoneCardImages(renderMarkdown(c.back, slides), l.id);
      images.push(...imageRefs(frontHtml, l.id), ...imageRefs(backHtml, l.id));
      phoneCards.push({
        id: c.id,
        lectureId: c.lectureId,
        frontHtml,
        backHtml,
        state: c.state,
        dueAt: c.dueAt.toISOString(),
        intervalDays: c.intervalDays,
        ease: c.ease,
        repetitions: c.repetitions,
        lapses: c.lapses,
        version: c.version,
        createdAt: c.createdAt.toISOString(),
      });
    }

    let nextSitting: string[] = [];
    if (l.questions.length) {
      try {
        nextSitting = await pickQuestions(l.id);
      } catch {
        nextSitting = l.questions.filter((q) => !q.paperItemId && !q.linkedLectureIds).map((q) => q.id);
      }
    }

    phoneLectures.push({
      id: l.id,
      courseId: l.courseId,
      ordinal: ordinal.get(l.id) ?? 0,
      title: l.title,
      module: l.module?.title ?? null,
      deliveredOn: l.deliveredOn.toISOString(),
      summaryHtml,
      summaryModel: l.summaryModel,
      images: [...new Set(images)],
      questions: l.questions.map(phoneQuestion),
      nextSitting,
      drillScore: rowOf.get(l.id)?.lastScore ?? null,
      sittingCount: rowOf.get(l.id)?.sittings ?? 0,
      dueAt: rowOf.get(l.id)?.dueAt ?? null,
    });
  }

  const perLecture = new Map<string, number>();
  const sittings: PhoneSnapshot["sittings"] = [];
  for (const a of attempts) {
    // A sitting started and never submitted isn't one yet.
    if (!a.responses.some((r) => r.answerText.trim() || r.mark !== null)) continue;
    const n = perLecture.get(a.lectureId) ?? 0;
    if (n >= SITTINGS_PER_LECTURE) continue;
    perLecture.set(a.lectureId, n + 1);
    sittings.push({
      id: a.id,
      lectureId: a.lectureId,
      sittingDate: a.sittingDate.toISOString(),
      completedAt: iso(a.completedAt),
      score: a.geometricMean,
      responses: a.responses.map((r) => ({
        id: r.id,
        questionId: r.questionId,
        answerText: r.answerText,
        mark: r.mark,
        pending: r.mark === null && waiting.has(r.id),
        feedback: r.mark === null ? [] : feedbackFor(r).items,
      })),
    });
  }

  const computerMarker =
    settings.mode === "manual" ? null : settings.mode === "local" ? "the offline model" : CLOUD_ENGINE_LABEL[settings.cloudEngine];

  return {
    v: 1,
    computer: computerName(),
    generatedAt: new Date().toISOString(),
    marking,
    computerMarker,
    viva,
    handwriting,
    courses: courses.map((c) => ({ ...c, examDate: iso(c.examDate) })),
    lectures: phoneLectures,
    sittings,
    mcqs: mcqs.flatMap((m) => {
      const options = readOptions(m.options);
      return options.length > m.answer ? [{ ...m, options }] : [];
    }),
    cards: phoneCards,
    cases: cases.flatMap((c) => {
      const byId = new Map(c.questions.map((q) => [q.id, q]));
      const stages = readStages(c.stages).flatMap((s) => {
        const q = byId.get(s.questionId);
        return q ? [{ lectureId: q.lectureId, kind: s.kind, ask: s.ask, reveal: s.reveal, question: phoneQuestion(q) }] : [];
      });
      return stages.length ? [{ id: c.id, courseId: c.courseId, title: c.title, presentation: c.presentation, stages }] : [];
    }),
  };
}
