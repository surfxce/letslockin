/**
 * Groups a folder's files into lectures without a model call. Folders are messy,
 * but most of the signal is in the names: "L7", "Lecture 07", "Week 3 Lecture 2",
 * a date, a module folder, or a transcript and a deck sharing a name. This runs in
 * milliseconds, works offline, and every guess it makes is shown for review — the
 * AI's only job afterwards is writing a real title for each lecture, one at a time.
 */

export interface GroupInput {
  relativePath: string;
  kind: string;
  modifiedOn: Date;
  measuredHours: number | null;
}

export interface ProposedLecture {
  title: string;
  /** Position in the course when the files say so ("L7" → 7). */
  number: number | null;
  moduleTitle: string | null;
  /** YYYY-MM-DD */
  deliveredOn: string;
  durationHours: number;
  fileIndexes: number[];
  /** Set when the files do not look like a lecture; shown unticked, with this reason. */
  setAside: string | null;
}

const EXT = /\.[a-z0-9]+$/i;

const WEEK_AND_LECTURE =
  /(?:^|[^a-z])w(?:ee)?k?[\s_\-.]*0*(\d{1,2})[\s_\-.]*(?:l|lec|lect|lecture)[\s_\-.]*0*(\d{1,2})(?!\d)/i;
const LECTURE = /(?:^|[^a-z])(?:lecture|lect|lec|l)[\s_\-.]*0*(\d{1,3})(?!\d)/i;
const WEEK = /(?:^|[^a-z])(?:week|wk)[\s_\-.]*0*(\d{1,2})(?!\d)/i;
const MODULE = /(?:^|[^a-z])(?:module|mod|unit|block|topic)[\s_\-.]*0*(\d{1,2})(?!\d)/i;

const ISO_DATE = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/;
const DMY_DATE = /(?<!\d)(0?[1-9]|[12]\d|3[01])[-_.](0?[1-9]|1[0-2])[-_.](20\d{2}|\d{2})(?!\d)/;

const PAPER =
  /(?:past|sample|practice|mock|final|mid[\s_-]?sem(?:ester)?|deferred)[\s_\-]*(?:exam|paper|test)|exam[\s_\-]*(?:paper|questions)/i;
const ADMIN =
  /course[\s_\-]*(?:profile|outline)|syllabus|(?:^|[^a-z])ecp(?:[^a-z]|$)|assessment[\s_\-]*(?:guide|brief|task|info)|reading[\s_\-]*list|timetable|marking[\s_\-]*rubric/i;

/** Words that describe the file rather than the lecture. */
const NOISE =
  /\b(?:transcripts?|captions?|subtitles?|slides?|slide[\s_-]?deck|deck|notes|lecture[\s_-]?notes|handouts?|recordings?|audio|video|echo360|lectopia|final|copy|print|printable|annotated|v\d+|\d+[\s_-]?per[\s_-]?page)\b/gi;
const COURSE_CODE = /\b[a-z]{4}\d{4}\b/gi;

/** Underscores join words without a \b between them, which hides "_transcript". */
function plain(filename: string): string {
  return filename.replace(EXT, "").replace(/_+/g, " ");
}

export function stemOf(filename: string): string {
  return plain(filename)
    .replace(COURSE_CODE, " ")
    .replace(NOISE, " ")
    .replace(/\(\d+\)/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

/** A readable title from a filename, with the numbering and file-type words removed. */
export function titleFromFilename(filename: string): string {
  const cleaned = plain(filename)
    .replace(COURSE_CODE, " ")
    .replace(WEEK_AND_LECTURE, " ")
    .replace(LECTURE, " ")
    .replace(WEEK, " ")
    .replace(MODULE, " ")
    .replace(NOISE, " ")
    .replace(ISO_DATE, " ")
    .replace(DMY_DATE, " ")
    .replace(/\(\d+\)/g, " ")
    .replace(/\s*[-–—:]+\s*/g, " – ")
    .replace(/\s+/g, " ")
    .replace(/^[\s–]+|[\s–]+$/g, "")
    .trim();
  if (!cleaned || !/[a-z]/i.test(cleaned)) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function dateFromName(name: string): string | null {
  const iso = name.match(ISO_DATE);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = name.match(DMY_DATE);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface Keyed {
  index: number;
  file: GroupInput;
  filename: string;
  dirs: string[];
  mod: { key: string; title: string; n: number } | null;
  lecture: { key: string; n: number } | null;
  date: string | null;
  stem: string;
  setAside: string | null;
}

function describe(file: GroupInput, index: number): Keyed {
  const parts = file.relativePath.split(/[\\/]/);
  const filename = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);

  // A module comes from a folder ("Module 2 - Heart/") before the filename.
  let mod: Keyed["mod"] = null;
  for (const dir of [...dirs].reverse()) {
    const m = dir.match(MODULE);
    if (m) {
      mod = { key: `m${Number(m[1])}`, title: dir.replace(/[_]+/g, " ").trim(), n: Number(m[1]) };
      break;
    }
  }
  if (!mod) {
    const m = filename.match(MODULE);
    if (m) mod = { key: `m${Number(m[1])}`, title: `Module ${Number(m[1])}`, n: Number(m[1]) };
  }

  const name = plain(filename);
  let lecture: Keyed["lecture"] = null;
  const wl = name.match(WEEK_AND_LECTURE);
  const l = name.match(LECTURE);
  const w = name.match(WEEK);
  if (wl) lecture = { key: `w${Number(wl[1])}l${Number(wl[2])}`, n: Number(wl[1]) * 100 + Number(wl[2]) };
  else if (l) lecture = { key: `l${Number(l[1])}`, n: Number(l[1]) };
  else if (w) lecture = { key: `w${Number(w[1])}`, n: Number(w[1]) * 100 };
  else {
    // "Lecture 3/transcript.vtt": the number can live on the folder instead.
    const fromDir = dirs.length ? dirs[dirs.length - 1].match(LECTURE) : null;
    if (fromDir) lecture = { key: `l${Number(fromDir[1])}`, n: Number(fromDir[1]) };
  }

  // "Final exam revision.vtt" is a lecture: a real recording has timestamps.
  const recorded = file.kind === "TRANSCRIPT" && file.measuredHours !== null;
  const setAside =
    !recorded && PAPER.test(filename)
      ? "looks like a past exam paper"
      : ADMIN.test(filename)
        ? "looks like course admin, not a lecture"
        : null;

  return {
    index,
    file,
    filename,
    dirs,
    mod,
    lecture,
    date: dateFromName(name),
    stem: stemOf(filename),
    setAside,
  };
}

function keyOf(k: Keyed): string {
  const scope = k.mod?.key ?? "";
  if (k.lecture) return `${scope}|${k.lecture.key}`;
  if (k.date) return `${scope}|d${k.date}`;
  if (k.stem) return `${scope}|s${k.stem}`;
  return `${scope}|f${k.index}`;
}

export function groupFiles(files: GroupInput[]): ProposedLecture[] {
  const described = files.map(describe);
  const groups = new Map<string, Keyed[]>();
  const aside: Keyed[] = [];

  for (const k of described) {
    if (k.setAside) {
      aside.push(k);
      continue;
    }
    const key = keyOf(k);
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }

  const lectures = [...groups.values()].map((members): { lecture: ProposedLecture; sort: number[] } => {
    const lead = members.find((m) => m.file.kind === "TRANSCRIPT") ?? members[0];
    const titles = members.map((m) => titleFromFilename(m.filename)).filter(Boolean);
    // The most descriptive name in the group, preferring the transcript's on a tie.
    const best = titles.sort((a, b) => b.length - a.length)[0] ?? "";
    const number = lead.lecture && lead.lecture.n < 100 ? lead.lecture.n : null;
    const title = best || (number ? `Lecture ${number}` : "Untitled lecture");

    const named = members.map((m) => m.date).find(Boolean);
    const earliest = members
      .map((m) => m.file.modifiedOn)
      .reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const hours = Math.max(0, ...members.map((m) => m.file.measuredHours ?? 0));

    return {
      lecture: {
        title,
        number,
        moduleTitle: lead.mod?.title ?? null,
        deliveredOn: named ?? localDay(earliest),
        durationHours: hours > 0 ? hours : 1,
        fileIndexes: members.map((m) => m.index).sort((a, b) => a - b),
        setAside: null,
      },
      // Course order: module, then lecture number, then date.
      sort: [lead.mod?.n ?? 0, lead.lecture?.n ?? Number.MAX_SAFE_INTEGER],
    };
  });

  lectures.sort(
    (a, b) =>
      a.sort[0] - b.sort[0] ||
      a.sort[1] - b.sort[1] ||
      a.lecture.deliveredOn.localeCompare(b.lecture.deliveredOn) ||
      a.lecture.title.localeCompare(b.lecture.title),
  );

  const setAside: ProposedLecture[] = aside.map((k) => ({
    title: titleFromFilename(k.filename) || k.filename,
    number: null,
    moduleTitle: k.mod?.title ?? null,
    deliveredOn: k.date ?? localDay(k.file.modifiedOn),
    durationHours: k.file.measuredHours ?? 1,
    fileIndexes: [k.index],
    setAside: k.setAside,
  }));

  return [...lectures.map((l) => l.lecture), ...setAside];
}
