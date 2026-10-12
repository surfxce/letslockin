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
  /** How the files number it — "L7", "A4", "W3 L1" — for the review list. */
  label: string | null;
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
/** "A4", "B12": a letter and a number opening the filename, as some courses number lectures. */
const CODE = /^([a-z])[\s.]?0*(\d{1,2})(?=[\s\-.]|$)/i;

/** Joins the two ends of a range: "4-5", "4 – 5", "4 & 5", "4 and 5", "4 to 5". */
const TO = String.raw`\s*(?:-|–|—|&|\+|and|to)\s*`;
/** One file for several lectures: "A4-A5", "A4–5", "A4 & A5". */
const CODE_RANGE = new RegExp(String.raw`^([a-z])[\s.]?0*(\d{1,2})${TO}(?:([a-z])[\s.]?)?0*(\d{1,2})(?=[\s\-.]|$)`, "i");
const LECTURE_WORD = String.raw`(?:lectures?|lects?|lecs?|l)`;
const LECTURE_RANGE = new RegExp(
  String.raw`(?:^|[^a-z])${LECTURE_WORD}[\s\-.]*0*(\d{1,3})${TO}(?:${LECTURE_WORD}[\s\-.]*)?0*(\d{1,3})(?!\d|[\-.]\d)`,
  "i",
);
const WEEK_RANGE = new RegExp(
  String.raw`(?:^|[^a-z])(?:weeks?|wks?)[\s\-.]*0*(\d{1,2})${TO}(?:(?:weeks?|wks?)[\s\-.]*)?0*(\d{1,2})(?!\d|[\-.]\d)`,
  "i",
);
/** A deck spanning more lectures than this is more likely a compilation than a shared deck. */
const MAX_RANGE = 6;

const ISO_DATE = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/;
const DMY_DATE = /(?<!\d)(0?[1-9]|[12]\d|3[01])[-_.](0?[1-9]|1[0-2])[-_.](20\d{2}|\d{2})(?!\d)/;

const PAPER =
  /(?:past|sample|practice|mock|final|mid[\s_-]?sem(?:ester)?|deferred)[\s_\-]*(?:exam|paper|test)|exam[\s_\-]*(?:paper|questions)/i;
const ADMIN =
  /course[\s_\-]*(?:profile|outline)|syllabus|(?:^|[^a-z])ecp(?:[^a-z]|$)|assessment[\s_\-]*(?:guide|brief|task|info)|reading[\s_\-]*list|timetable|marking[\s_\-]*rubric/i;

/** Words that describe the file rather than the lecture. */
const NOISE =
  /\b(?:transcripts?|captions?|subtitles?|slides?|slide[\s_-]?deck|deck|notes|lecture[\s_-]?notes|handouts?|recordings?|audio|video|echo360|lectopia|final|copy|print|printable|annotated|shared|combined|v\d+|\d+[\s_-]?per[\s_-]?page)\b/gi;
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

/** The filename with any course code taken off, so a lecture code can open it. */
function named(filename: string): string {
  return plain(filename).replace(COURSE_CODE, " ").trim();
}

/** A readable title from a filename, with the numbering and file-type words removed. */
export function titleFromFilename(filename: string): string {
  // With no spaces at all, hyphens are joining words ("Glucose-Homeostasis-and-
  // Diabetes"); in a name with spaces they are real ones ("X-ray", "Non-coding").
  const kebab = !/\s/.test(filename.replace(EXT, ""));
  let cleaned = named(filename)
    .replace(CODE_RANGE, " ")
    .replace(CODE, " ")
    .replace(LECTURE_RANGE, " ")
    .replace(WEEK_RANGE, " ")
    .replace(WEEK_AND_LECTURE, " ")
    .replace(LECTURE, " ")
    .replace(WEEK, " ")
    .replace(MODULE, " ")
    .replace(NOISE, " ")
    .replace(ISO_DATE, " ")
    .replace(DMY_DATE, " ")
    .replace(/\(\d+\)/g, " ")
    .replace(/\b(?:part|pt)\.?\s*0*(\d{1,2})\b/gi, "Part $1")
    // A spaced hyphen, or any dash or colon, separates parts of a title.
    .replace(/\s+-+\s+|\s*[–—:]+\s*/g, " – ");
  if (kebab) cleaned = cleaned.replace(/(?<=[a-z0-9])-+(?=[a-z0-9])/gi, " ");
  cleaned = cleaned
    .replace(/\s+-+\s*|\s*-+\s+/g, " – ")
    .replace(/\s+/g, " ")
    .replace(/^[\s–-]+|[\s–-]+$/g, "")
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

/** Which lecture a file names: a grouping key, a sort position and a label to show. */
interface LectureId {
  key: string;
  n: number;
  label: string;
}

interface Keyed {
  index: number;
  file: GroupInput;
  filename: string;
  dirs: string[];
  mod: { key: string; title: string; n: number } | null;
  lecture: LectureId | null;
  /** Set when one file covers several lectures ("A4-A5 slides"): one id per lecture. */
  range: LectureId[] | null;
  /** Placed into lectures named by a range rather than its own. */
  shared: boolean;
  date: string | null;
  stem: string;
  setAside: string | null;
}

function span(lo: number, hi: number, make: (n: number) => LectureId): LectureId[] | null {
  if (!(hi > lo) || hi - lo >= MAX_RANGE) return null;
  return Array.from({ length: hi - lo + 1 }, (_, i) => make(lo + i));
}

const codeId = (letter: string, n: number): LectureId => {
  const L = letter.toUpperCase();
  return { key: `c${L}${n}`, n: (L.charCodeAt(0) - 64) * 1000 + n, label: `${L}${n}` };
};
const lectureId = (n: number): LectureId => ({ key: `l${n}`, n, label: `L${n}` });
const weekId = (n: number): LectureId => ({ key: `w${n}`, n: n * 100, label: `Week ${n}` });

/** The lecture — or, for a shared file, the lectures — a filename points to. */
function lectureFrom(filename: string, dirs: string[]): { lecture: LectureId | null; range: LectureId[] | null } {
  const name = named(filename);

  // A range too long to be one shared deck ("L1-20 complete") names no lecture at
  // all — not the first in it.
  const lr = name.match(LECTURE_RANGE);
  if (lr) return { lecture: null, range: span(Number(lr[1]), Number(lr[2]), lectureId) };
  const wr = name.match(WEEK_RANGE);
  if (wr) return { lecture: null, range: span(Number(wr[1]), Number(wr[2]), weekId) };
  const cr = name.match(CODE_RANGE);
  if (cr && (!cr[3] || cr[3].toUpperCase() === cr[1].toUpperCase())) {
    return { lecture: null, range: span(Number(cr[2]), Number(cr[4]), (n) => codeId(cr[1], n)) };
  }

  const wl = name.match(WEEK_AND_LECTURE);
  if (wl) {
    const [w, l] = [Number(wl[1]), Number(wl[2])];
    return { lecture: { key: `w${w}l${l}`, n: w * 100 + l, label: `W${w} L${l}` }, range: null };
  }
  const l = name.match(LECTURE);
  if (l) return { lecture: lectureId(Number(l[1])), range: null };
  const w = name.match(WEEK);
  if (w) return { lecture: weekId(Number(w[1])), range: null };
  const c = name.match(CODE);
  if (c) return { lecture: codeId(c[1], Number(c[2])), range: null };

  // "Lecture 3/transcript.vtt": the number can live on the folder instead.
  const fromDir = dirs.length ? dirs[dirs.length - 1].match(LECTURE) : null;
  return { lecture: fromDir ? lectureId(Number(fromDir[1])) : null, range: null };
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

  const { lecture, range } = lectureFrom(filename, dirs);

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
    range,
    shared: false,
    date: dateFromName(plain(filename)),
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

  const ranged: Keyed[] = [];
  for (const k of described) {
    if (k.setAside) {
      aside.push(k);
      continue;
    }
    if (k.range) {
      ranged.push(k);
      continue;
    }
    const key = keyOf(k);
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }

  // A file for several lectures ("A4-A5 slides") goes into each of those lectures
  // that is here — in the same module if possible, else wherever its number is.
  // Only when none of them is here does it stand as a lecture of its own.
  for (const k of ranged) {
    const scope = k.mod?.key ?? "";
    const ids = k.range!.map((r) => r.key);
    let homes = ids.map((id) => `${scope}|${id}`).filter((key) => groups.has(key));
    if (homes.length === 0) homes = [...groups.keys()].filter((key) => ids.includes(key.slice(key.indexOf("|") + 1)));
    if (homes.length === 0) {
      const first = k.range![0];
      const last = k.range![k.range!.length - 1];
      const own: LectureId = { key: `r${ids.join("+")}`, n: first.n, label: `${first.label}–${last.label}` };
      groups.set(`${scope}|${own.key}`, [{ ...k, lecture: own }]);
      continue;
    }
    for (const home of homes) groups.get(home)!.push({ ...k, shared: true });
  }

  const lectures = [...groups.values()].map((members): { lecture: ProposedLecture; sort: number[] } => {
    // A shared file describes several lectures, so it never names, dates or leads one.
    const own = members.some((m) => !m.shared) ? members.filter((m) => !m.shared) : members;
    const lead = own.find((m) => m.file.kind === "TRANSCRIPT") ?? own[0];
    const titles = own.map((m) => titleFromFilename(m.filename)).filter(Boolean);
    // The most descriptive name in the group, preferring the transcript's on a tie.
    const best = titles.sort((a, b) => b.length - a.length)[0] ?? "";
    const number = lead.lecture && lead.lecture.key.startsWith("l") ? lead.lecture.n : null;
    const label = lead.lecture?.label ?? null;
    const title = best || (number ? `Lecture ${number}` : (label ?? "Untitled lecture"));

    const dated = own.map((m) => m.date).find(Boolean);
    const earliest = members
      .map((m) => m.file.modifiedOn)
      .reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const hours = Math.max(0, ...members.map((m) => m.file.measuredHours ?? 0));

    return {
      lecture: {
        title,
        number,
        label,
        moduleTitle: lead.mod?.title ?? null,
        deliveredOn: dated ?? localDay(earliest),
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
    label: null,
    moduleTitle: k.mod?.title ?? null,
    deliveredOn: k.date ?? localDay(k.file.modifiedOn),
    durationHours: k.file.measuredHours ?? 1,
    fileIndexes: [k.index],
    setAside: k.setAside,
  }));

  return [...lectures.map((l) => l.lecture), ...setAside];
}

/** An AI's grouping of a folder: lectures in course order, each listing its files by path. */
export interface SortedFolder {
  lectures: Array<{ title: string; module: string | null; files: string[] }>;
  setAside: Array<{ file: string; reason: string }>;
}

/**
 * Turns an AI's grouping into the same proposals the filename grouping makes, so the
 * review list works the same either way. The AI decides what goes together and what
 * each lecture is called; dates, hours and labels still come from the files. A file
 * the AI left out is listed, unticked, rather than silently dropped.
 */
export function lecturesFromSort(files: GroupInput[], sorted: SortedFolder): ProposedLecture[] {
  const described = files.map(describe);
  const indexOf = new Map(files.map((f, i) => [f.relativePath, i]));
  const placed = new Set<number>();

  const lectures: ProposedLecture[] = [];
  for (const l of sorted.lectures) {
    const members = [...new Set(l.files.map((p) => indexOf.get(p)).filter((i): i is number => i !== undefined))].map(
      (i) => described[i],
    );
    if (members.length === 0) continue;
    for (const m of members) placed.add(m.index);
    const lead = members.find((m) => m.file.kind === "TRANSCRIPT") ?? members[0];
    const dated = lead.date ?? members.map((m) => m.date).find(Boolean);
    const earliest = members.map((m) => m.file.modifiedOn).reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const hours = Math.max(0, ...members.map((m) => m.file.measuredHours ?? 0));
    lectures.push({
      title: l.title.trim() || titleFromFilename(lead.filename) || "Untitled lecture",
      number: lead.lecture?.key.startsWith("l") ? lead.lecture.n : null,
      label: lead.lecture?.label ?? null,
      moduleTitle: l.module?.trim() || lead.mod?.title || null,
      deliveredOn: dated ?? localDay(earliest),
      durationHours: hours > 0 ? hours : 1,
      fileIndexes: members.map((m) => m.index).sort((a, b) => a - b),
      setAside: null,
    });
  }

  const reasons = new Map(sorted.setAside.map((s) => [indexOf.get(s.file), s.reason]));
  const aside: ProposedLecture[] = described
    .filter((k) => !placed.has(k.index))
    .map((k) => ({
      title: titleFromFilename(k.filename) || k.filename,
      number: null,
      label: null,
      moduleTitle: k.mod?.title ?? null,
      deliveredOn: k.date ?? localDay(k.file.modifiedOn),
      durationHours: k.file.measuredHours ?? 1,
      fileIndexes: [k.index],
      setAside: reasons.get(k.index)?.trim() || "the AI didn't place this — tick it to import it on its own",
    }));
  return [...lectures, ...aside];
}
