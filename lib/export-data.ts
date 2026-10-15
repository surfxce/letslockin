import { prisma } from "@/lib/db";
import { exportTitle, NO_MODULE, type ExportRequest } from "@/lib/export";
import type { SlideImages } from "@/lib/markdown";
import { lectureDecks, pictured } from "@/lib/slides";

export type ExportScope = "course" | "module" | "lectures";

export interface ExportLecture {
  id: string;
  ordinal: number;
  title: string;
  deliveredOn: Date;
  moduleTitle: string | null;
  summaryMd: string;
  /** Undefined when pictures are left out. */
  slides?: SlideImages;
  glossary: Array<{ term: string; explanation: string }>;
}

/** A lecture as the export page offers it for choosing. */
export interface ExportChoice {
  id: string;
  ordinal: number;
  title: string;
  moduleId: string | null;
  moduleTitle: string | null;
  hasSummary: boolean;
}

export interface ExportData {
  courses: Array<{ id: string; code: string; title: string }>;
  course: { id: string; code: string; title: string } | null;
  /** The course's modules, with how many of their lectures have a summary. */
  modules: Array<{ id: string; title: string; summaries: number }>;
  /** How many lectures with a summary have no module. */
  unsorted: number;
  choices: ExportChoice[];
  scope: ExportScope;
  /** The module being exported (NO_MODULE's title is "Other lectures"). */
  module: { id: string; title: string } | null;
  lectures: ExportLecture[];
  /** Lectures in the scope with no summary yet, so not exported. */
  leftOut: number;
  /** The PDF's name, and the page's title. */
  title: string;
}

export const OTHER_LECTURES = "Other lectures";

/** Everything the export page shows and prints, from what its address asks for. */
export async function loadExport(request: ExportRequest): Promise<ExportData> {
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, code: true, title: true },
  });

  // The course: as asked, else the one the lectures or module belong to, else the first.
  let courseId = request.courseId;
  if (!courseId && request.lectureIds?.length) {
    const lecture = await prisma.lecture.findFirst({
      where: { id: { in: request.lectureIds } },
      select: { courseId: true },
    });
    courseId = lecture?.courseId ?? null;
  }
  if (!courseId && request.moduleId && request.moduleId !== NO_MODULE) {
    const mod = await prisma.module.findUnique({ where: { id: request.moduleId }, select: { courseId: true } });
    courseId = mod?.courseId ?? null;
  }
  const course = courses.find((c) => c.id === courseId) ?? courses[0] ?? null;

  const empty: ExportData = {
    courses,
    course,
    modules: [],
    unsorted: 0,
    choices: [],
    scope: "course",
    module: null,
    lectures: [],
    leftOut: 0,
    title: exportTitle({ courseCode: course?.code ?? "Lockin" }),
  };
  if (!course) return empty;

  // Every lecture, in the order L-numbers count them.
  const all = await prisma.lecture.findMany({
    where: { courseId: course.id },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      deliveredOn: true,
      summaryMd: true,
      module: { select: { id: true, title: true } },
    },
  });
  const modules = await prisma.module.findMany({
    where: { courseId: course.id },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { id: true, title: true },
  });
  const choices: ExportChoice[] = all.map((l, i) => ({
    id: l.id,
    ordinal: i + 1,
    title: l.title,
    moduleId: l.module?.id ?? null,
    moduleTitle: l.module?.title ?? null,
    hasSummary: !!l.summaryMd?.trim(),
  }));

  let scope: ExportScope = "course";
  let chosen: ExportData["module"] = null;
  let inScope = choices;
  if (request.lectureIds) {
    const picked = new Set(request.lectureIds);
    scope = "lectures";
    inScope = choices.filter((c) => picked.has(c.id));
  } else if (request.moduleId === NO_MODULE) {
    scope = "module";
    chosen = { id: NO_MODULE, title: OTHER_LECTURES };
    inScope = choices.filter((c) => !c.moduleId);
  } else if (request.moduleId) {
    const mod = modules.find((m) => m.id === request.moduleId);
    if (mod) {
      scope = "module";
      chosen = mod;
      inScope = choices.filter((c) => c.moduleId === mod.id);
    }
  }
  const printable = inScope.filter((c) => c.hasSummary);
  const ids = printable.map((c) => c.id);

  const terms = request.glossary
    ? await prisma.glossaryTerm.findMany({
        where: { lectureId: { in: ids } },
        select: { lectureId: true, term: true, explanation: true },
      })
    : [];
  const byId = new Map(all.map((l) => [l.id, l]));
  const lectures: ExportLecture[] = [];
  for (const c of printable) {
    const slides: SlideImages | undefined = request.pictures
      ? { base: `/api/lectures/${c.id}/slides`, ranges: pictured(await lectureDecks(c.id)), print: true }
      : undefined;
    lectures.push({
      id: c.id,
      ordinal: c.ordinal,
      title: c.title,
      deliveredOn: byId.get(c.id)!.deliveredOn,
      moduleTitle: c.moduleTitle,
      summaryMd: byId.get(c.id)!.summaryMd!,
      slides,
      glossary: terms
        .filter((t) => t.lectureId === c.id)
        .map(({ term, explanation }) => ({ term, explanation }))
        .sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: "base" })),
    });
  }

  const title = exportTitle({
    courseCode: course.code,
    moduleTitle: chosen?.title,
    lecture: scope === "lectures" && lectures.length === 1 ? lectures[0] : null,
    picked: scope === "lectures" ? lectures.length : null,
  });

  return {
    ...empty,
    modules: modules.map((m) => ({ ...m, summaries: choices.filter((c) => c.moduleId === m.id && c.hasSummary).length })),
    unsorted: choices.filter((c) => !c.moduleId && c.hasSummary).length,
    choices,
    scope,
    module: chosen,
    lectures,
    leftOut: inScope.length - printable.length,
    title,
  };
}
