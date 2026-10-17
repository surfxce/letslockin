/**
 * Exporting summaries as a PDF. What to export lives in the export page's address, so
 * the preview, the browser's print and the desktop app's hidden print window all
 * render exactly the same thing from it:
 *
 *   /export?course=<id>                 every lecture in a course
 *   /export?course=<id>&module=<id>     one module ("none": lectures with no module)
 *   /export?lectures=<id>,<id>          particular lectures
 *
 * plus what to include. Only lectures with a summary are exported.
 */

export type Paper = "a4" | "letter";

export interface ExportRequest {
  courseId: string | null;
  /** A module's id, or NO_MODULE for the lectures that have none. */
  moduleId: string | null;
  /** Particular lectures — possibly none yet, while choosing; null for the whole course or module. */
  lectureIds: string[] | null;
  pictures: boolean;
  glossary: boolean;
  contents: boolean;
  paper: Paper;
}

export const NO_MODULE = "none";

export const EXPORT_DEFAULTS: ExportRequest = {
  courseId: null,
  moduleId: null,
  lectureIds: null,
  pictures: true,
  glossary: true,
  contents: true,
  paper: "a4",
};

/** CSS page sizes, and Electron's names for them. */
export const PAPER: Record<Paper, { label: string; css: string }> = {
  a4: { label: "A4", css: "A4" },
  letter: { label: "Letter", css: "letter" },
};

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Database ids are cuids; anything else in the address is ignored, not queried. */
const ID = /^[a-z0-9_-]{1,64}$/i;
const id = (v: string | undefined) => (v && ID.test(v) ? v : null);
const flag = (v: string | undefined, fallback: boolean) => (v === "0" ? false : v === "1" ? true : fallback);

export function parseExportParams(params: Params): ExportRequest {
  const lectures = [params.lectures, params.lecture]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => ID.test(v));
  const choosing = params.lectures !== undefined || params.lecture !== undefined;
  const moduleParam = first(params.module);
  return {
    courseId: id(first(params.course)),
    moduleId: moduleParam === NO_MODULE ? NO_MODULE : id(moduleParam),
    lectureIds: choosing ? [...new Set(lectures)] : null,
    pictures: flag(first(params.pictures), EXPORT_DEFAULTS.pictures),
    glossary: flag(first(params.glossary), EXPORT_DEFAULTS.glossary),
    contents: flag(first(params.contents), EXPORT_DEFAULTS.contents),
    paper: first(params.paper) === "letter" ? "letter" : "a4",
  };
}

/** The export page's address for a request; settings left at their default are left out. */
export function exportHref(request: Partial<ExportRequest>): string {
  const r = { ...EXPORT_DEFAULTS, ...request };
  const q = new URLSearchParams();
  if (r.courseId) q.set("course", r.courseId);
  if (r.lectureIds) q.set("lectures", r.lectureIds.join(","));
  else if (r.moduleId) q.set("module", r.moduleId);
  if (r.pictures !== EXPORT_DEFAULTS.pictures) q.set("pictures", r.pictures ? "1" : "0");
  if (r.glossary !== EXPORT_DEFAULTS.glossary) q.set("glossary", r.glossary ? "1" : "0");
  if (r.contents !== EXPORT_DEFAULTS.contents) q.set("contents", r.contents ? "1" : "0");
  if (r.paper !== EXPORT_DEFAULTS.paper) q.set("paper", r.paper);
  const s = q.toString();
  return s ? `/export?${s}` : "/export";
}

/** Only the export page may be printed to a file by the desktop app. */
export function isExportPath(pathname: string): boolean {
  return /^\/export(?:\?[^#\s]*)?$/.test(pathname);
}

/** A name that is safe as a file name on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return clean || "Lockin summaries";
}

/**
 * What the PDF is called — also the export page's title, which is what a browser's
 * "Save as PDF" suggests as the file name.
 */
export function exportTitle(parts: {
  courseCode: string;
  /** The module's title when exporting one module. */
  moduleTitle?: string | null;
  /** The lecture, when exporting just one. */
  lecture?: { ordinal: number; title: string } | null;
  /** How many lectures were picked, when exporting a few. */
  picked?: number | null;
}): string {
  const { courseCode, moduleTitle, lecture, picked } = parts;
  let title: string;
  if (lecture) title = `${courseCode} L${lecture.ordinal} — ${lecture.title}`;
  else if (moduleTitle) title = `${courseCode} ${moduleTitle} — summaries`;
  else if (picked) title = `${courseCode} — ${picked} lecture summaries`;
  else title = `${courseCode} — summaries`;
  return safeFileName(title);
}
