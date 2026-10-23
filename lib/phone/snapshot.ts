import { prisma } from "@/lib/db";
import { pickQuestions } from "@/lib/engines/attempt";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { markVars } from "@/lib/llm/prompts";
import { renderMarkdown, type SlideImages } from "@/lib/markdown";
import { CLOUD_ENGINE_LABEL } from "@/lib/modes";
import { phoneMarkingTemplate } from "@/lib/phone/marking";
import { computerName } from "@/lib/phone/pairing";
import type { PhoneSnapshot } from "@/lib/phone/schema";
import { getSettings } from "@/lib/settings";
import { lectureDecks, pictured } from "@/lib/slides";
import { lectureRows } from "@/lib/views";

/** Pictures in the phone's copy point here; the app serves them from its own cache. */
export const SLIDE_SCHEME = "lockin-slide";

/** Sittings sent per lecture, newest first. */
const SITTINGS_PER_LECTURE = 12;

/** "<n>" and "<n>?crop=…" for every picture in some rendered HTML of one lecture. */
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

/** Everything the phone shows, rendered the way the computer renders it. */
export async function buildSnapshot(): Promise<PhoneSnapshot> {
  const settings = await getSettings();
  const [courses, lectures, attempts, cards, markJobs, marking, rows] = await Promise.all([
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
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            stem: true,
            type: true,
            rubric: true,
            concepts: { select: { concept: { select: { id: true, name: true, definition: true } } } },
          },
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
    prisma.flashcard.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    prisma.job.findMany({ where: { kind: "MARK", status: { in: ["PENDING", "RUNNING"] } }, select: { payload: true } }),
    phoneMarkingTemplate(),
    lectureRows(),
  ]);
  const rowOf = new Map(rows.map((r) => [r.id, r]));

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
      const frontHtml = renderMarkdown(c.front, slides);
      const backHtml = renderMarkdown(c.back, slides);
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
        nextSitting = l.questions.map((q) => q.id);
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
      questions: l.questions.map((q) => {
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
        };
      }),
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
    courses: courses.map((c) => ({ ...c, examDate: iso(c.examDate) })),
    lectures: phoneLectures,
    sittings,
    cards: phoneCards,
  };
}
