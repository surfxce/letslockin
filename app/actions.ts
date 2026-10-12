"use server";

import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { pickQuestions } from "@/lib/engines/attempt";
import { geometricMean } from "@/lib/engines/geomean";
import { fromDateInput } from "@/lib/format";
import { groupFiles, titleFromFilename, type ProposedLecture } from "@/lib/group";
import { clearQueue, enqueue, queuePrepare, retryJob } from "@/lib/jobs";
import { ingestFile } from "@/lib/materials";
import { checksum } from "@/lib/parse";
import { parseLaqs, parseScores, parseSummary } from "@/lib/paste";
import { activeLocalModel, cancelDownload, removeModel, requestDownload } from "@/lib/models";
import { materialsDir } from "@/lib/paths";
import { scoreAttemptIfMarked } from "@/lib/pipeline";
import { scanFolder } from "@/lib/scan";
import { describeForSort } from "@/lib/sortfiles";
import { getSettings, setSetting, type Mode } from "@/lib/settings";
import type { MaterialKind } from "@/lib/types";
import { usesAi } from "@/lib/modes";
import { questionNumbers } from "@/lib/views";

/** What a form gets back when it stays on the page: shown next to the button. */
export type Result = { ok: boolean; message: string } | null;

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

function refreshAll() {
  revalidatePath("/", "layout");
}

function positiveHours(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ---------------------------------------------------------------------------
// Courses

export async function createCourse(_prev: Result, fd: FormData): Promise<Result> {
  const code = str(fd, "code").toUpperCase();
  const title = str(fd, "title");
  if (!code || !title) return { ok: false, message: "Give the course a code and a name." };
  if (await prisma.course.findUnique({ where: { code } })) {
    return { ok: false, message: `${code} is already here.` };
  }
  const course = await prisma.course.create({
    data: { code, title, examDate: fromDateInput(str(fd, "examDate")) },
  });
  refreshAll();
  redirect(`/courses/${course.id}/import?new=1`);
}

export async function updateCourse(_prev: Result, fd: FormData): Promise<Result> {
  const id = str(fd, "courseId");
  const code = str(fd, "code").toUpperCase();
  const title = str(fd, "title");
  if (!code || !title) return { ok: false, message: "A course needs a code and a name." };
  const clash = await prisma.course.findUnique({ where: { code } });
  if (clash && clash.id !== id) return { ok: false, message: `${code} is already another course.` };
  await prisma.course.update({
    where: { id },
    data: { code, title, examDate: fromDateInput(str(fd, "examDate")) },
  });
  refreshAll();
  return { ok: true, message: "Saved." };
}

export async function deleteCourse(_prev: Result, fd: FormData): Promise<Result> {
  const id = str(fd, "courseId");
  const course = await prisma.course.findUniqueOrThrow({ where: { id } });
  if (str(fd, "confirm").toUpperCase() !== course.code) {
    return { ok: false, message: `Type ${course.code} to confirm.` };
  }
  const lectures = await prisma.lecture.findMany({ where: { courseId: id }, select: { id: true } });
  await prisma.course.delete({ where: { id } });
  // Cascades clear the rows; the uploaded files have to go too.
  for (const l of lectures) await rm(path.join(materialsDir(), l.id), { recursive: true, force: true });
  refreshAll();
  redirect("/");
}

export async function deleteModule(fd: FormData) {
  // Lectures survive; they just lose the module.
  await prisma.module.delete({ where: { id: str(fd, "moduleId") } });
  refreshAll();
}

async function moduleIdFor(courseId: string, title: string, cache = new Map<string, string>()) {
  const name = title.trim();
  if (!name) return null;
  const hit = cache.get(name.toLowerCase());
  if (hit) return hit;
  const existing = await prisma.module.findFirst({ where: { courseId, title: name } });
  const mod =
    existing ??
    (await prisma.module.create({
      data: { courseId, title: name, position: await prisma.module.count({ where: { courseId } }) },
    }));
  cache.set(name.toLowerCase(), mod.id);
  return mod.id;
}

// ---------------------------------------------------------------------------
// Importing a folder

export interface ScannedFileView {
  relativePath: string;
  kind: string;
  warnings: string[];
  measuredHours: number | null;
  /** ISO date of the file's last change: a lecture's date when its name has none. */
  modifiedOn: string;
}

export interface ScanState {
  error?: string;
  root?: string;
  /** Distinguishes one scan from the next, so the review form resets between them. */
  scannedAt?: number;
  files?: ScannedFileView[];
  lectures?: ProposedLecture[];
  skipped?: Array<{ path: string; why: string }>;
  /** For each file index already in this course (same contents): the lectures holding it. */
  inLectures?: Record<number, Array<{ id: string; title: string }>>;
}

/** Reads the folder and proposes lectures. Local and instant: no model call. */
export async function scanFolderAction(_prev: ScanState, fd: FormData): Promise<ScanState> {
  const courseId = str(fd, "courseId");
  const raw = str(fd, "root");
  if (!raw) return { error: "Choose the folder your lecture files are in." };
  const root = path.resolve(raw.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~"));

  try {
    const { files, skipped } = await scanFolder(root);
    if (files.length === 0) {
      return { error: `Nothing readable in ${root}. Lockin reads .vtt .srt .txt .md .pdf and .pptx.`, root };
    }
    const held = new Map<string, Array<{ id: string; title: string }>>();
    const existing = await prisma.material.findMany({
      where: { lecture: { courseId } },
      select: { checksum: true, lecture: { select: { id: true, title: true } } },
    });
    for (const m of existing) {
      if (!m.lecture) continue;
      const list = held.get(m.checksum) ?? [];
      if (!list.some((l) => l.id === m.lecture!.id)) list.push(m.lecture);
      held.set(m.checksum, list);
    }
    return {
      root,
      scannedAt: Date.now(),
      files: files.map((f) => ({
        relativePath: f.relativePath,
        kind: f.kindGuess,
        warnings: f.warnings,
        measuredHours: f.measuredHours,
        modifiedOn: f.modifiedOn.toISOString(),
      })),
      lectures: groupFiles(
        files.map((f) => ({
          relativePath: f.relativePath,
          kind: f.kindGuess,
          modifiedOn: f.modifiedOn,
          measuredHours: f.measuredHours,
        })),
      ),
      skipped,
      inLectures: Object.fromEntries(
        files.flatMap((f, i) => (held.has(f.checksum) ? [[i, held.get(f.checksum)!]] : [])),
      ),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), root };
  }
}

/**
 * Asks the AI to group a scanned folder: for folders whose names don't say which
 * lecture is which. Queued for the worker, which runs it beside anything already
 * being prepared; the import screen polls /api/jobs/<id> for the answer.
 */
export async function startSort(input: {
  root: string;
  paths: string[];
}): Promise<{ jobId: string } | { error: string }> {
  const { mode } = await getSettings();
  if (!usesAi(mode)) {
    return { error: "Sorting with AI needs Claude Code or an offline model — you're in copy & paste mode (Settings)." };
  }
  if (mode === "local" && !(await activeLocalModel())) {
    return { error: "Download an offline model first, in Settings → Offline AI." };
  }
  const root = path.resolve(input.root);
  if (input.paths.some((rel) => !path.resolve(root, rel).startsWith(root + path.sep))) {
    return { error: "Those files are not inside the folder. Scan it again." };
  }
  try {
    // A small local model has less room to read in, so it gets shorter openings.
    const files = await describeForSort(root, input.paths, mode === "local" ? 260 : 600);
    const job = await enqueue("SORT", { root, files }, null);
    return { jobId: job.id };
  } catch (err) {
    return { error: `Could not read the files again (${err instanceof Error ? err.message : err}). Scan again.` };
  }
}

/**
 * Creates the reviewed lectures, then queues them to be prepared one at a time in
 * course order. Everything comes from the form the student just edited.
 */
export async function importLectures(_prev: Result, fd: FormData): Promise<Result> {
  const courseId = str(fd, "courseId");
  const root = path.resolve(str(fd, "root"));
  const prepare = fd.get("prepare") === "on";
  const rows = fd.getAll("include").map(String);
  if (rows.length === 0) return { ok: false, message: "Tick at least one lecture to import." };

  const planned = rows.map((i) => ({
    title: str(fd, `title.${i}`),
    proposed: str(fd, `proposed.${i}`),
    module: str(fd, `module.${i}`),
    date: str(fd, `date.${i}`),
    hours: str(fd, `hours.${i}`),
    paths: fd.getAll(`paths.${i}`).map((v) => String(v)),
    /** An existing lecture these files belong to: add them to it, don't make another. */
    into: str(fd, `into.${i}`),
  }));
  if (planned.some((p) => p.paths.length === 0)) {
    return { ok: false, message: "A ticked lecture has no files left — tick a file back, or untick the lecture." };
  }

  // Every file must still be where the scan found it, and inside the chosen folder,
  // before anything is written — no half-finished imports.
  const missing: string[] = [];
  for (const { paths } of planned) {
    for (const rel of paths) {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) return { ok: false, message: `${rel} is outside ${root}.` };
      await access(abs).catch(() => missing.push(rel));
    }
  }
  if (missing.length) {
    return { ok: false, message: `These files have moved since the scan: ${missing.join(", ")}. Scan again.` };
  }

  const modules = new Map<string, string>();
  const created: string[] = [];
  const added: string[] = [];
  for (const row of planned) {
    if (row.into) {
      const lecture = await prisma.lecture.findFirst({
        where: { id: row.into, courseId },
        include: { materials: { select: { checksum: true } } },
      });
      if (lecture) {
        const have = new Set(lecture.materials.map((m) => m.checksum));
        let fresh = 0;
        for (const rel of row.paths) {
          const buffer = await readFile(path.resolve(root, rel));
          if (have.has(checksum(buffer))) continue;
          await ingestFile({ file: new File([new Uint8Array(buffer)], path.basename(rel)), lectureId: lecture.id });
          fresh++;
        }
        if (fresh) added.push(lecture.id);
        continue;
      }
      // The lecture was deleted since the scan: import the row as a new one.
    }
    const title = row.title || row.proposed || "Untitled lecture";
    const lecture = await prisma.lecture.create({
      data: {
        courseId,
        moduleId: await moduleIdFor(courseId, row.module, modules),
        title,
        // A title still as the scan proposed it came from a filename; the first AI
        // pass replaces it with one written from the content.
        autoTitle: !row.title || row.title === row.proposed,
        deliveredOn: fromDateInput(row.date) ?? new Date(),
        durationHours: positiveHours(row.hours),
      },
    });
    try {
      for (const rel of row.paths) {
        const abs = path.resolve(root, rel);
        const buffer = await readFile(abs);
        await ingestFile({ file: new File([new Uint8Array(buffer)], path.basename(abs)), lectureId: lecture.id });
      }
    } catch (err) {
      // A lecture with no material is worse than no lecture: it looks importable and
      // every later step on it fails.
      await prisma.lecture.delete({ where: { id: lecture.id } }).catch(() => undefined);
      return { ok: false, message: `Stopped at "${title}": ${err instanceof Error ? err.message : err}` };
    }
    created.push(lecture.id);
  }

  if (prepare && usesAi((await getSettings()).mode)) {
    await queuePrepare(created);
    // New slides change what a lecture's summary can show: write it again from all its files.
    await queuePrepare(added, { redo: true });
  }
  refreshAll();
  redirect(`/?course=${courseId}&imported=${created.length}${added.length ? `&updated=${added.length}` : ""}`);
}

// ---------------------------------------------------------------------------
// Lectures

/** One lecture by hand: files, pasted transcript text, or both. */
export async function createLecture(_prev: Result, fd: FormData): Promise<Result> {
  const courseId = str(fd, "courseId");
  const typed = str(fd, "title");
  const pasted = String(fd.get("transcriptText") ?? "").trim();
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!courseId) return { ok: false, message: "Pick a course first." };
  if (!typed && files.length === 0 && !pasted) {
    return { ok: false, message: "Give it a title, a file, or some transcript text." };
  }

  const fromFile = files.map((f) => titleFromFilename(f.name)).find(Boolean);
  const lecture = await prisma.lecture.create({
    data: {
      courseId,
      moduleId: await moduleIdFor(courseId, str(fd, "module")),
      title: typed || fromFile || "Untitled lecture",
      autoTitle: !typed,
      deliveredOn: fromDateInput(str(fd, "deliveredOn")) ?? new Date(),
      durationHours: positiveHours(str(fd, "durationHours")),
    },
  });
  try {
    for (const file of files) await ingestFile({ file, lectureId: lecture.id });
    if (pasted) {
      await ingestFile({
        file: new File([pasted], "pasted-transcript.txt"),
        lectureId: lecture.id,
        kind: "TRANSCRIPT",
      });
    }
  } catch (err) {
    await prisma.lecture.delete({ where: { id: lecture.id } }).catch(() => undefined);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  if ((files.length || pasted) && fd.get("prepare") === "on" && usesAi((await getSettings()).mode)) {
    await queuePrepare([lecture.id]);
  }
  refreshAll();
  redirect(`/lectures/${lecture.id}`);
}

export async function updateLecture(_prev: Result, fd: FormData): Promise<Result> {
  const id = str(fd, "lectureId");
  const title = str(fd, "title");
  if (!title) return { ok: false, message: "A lecture needs a title." };
  const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id } });
  await prisma.lecture.update({
    where: { id },
    data: {
      title,
      autoTitle: lecture.autoTitle && title === lecture.title,
      moduleId: await moduleIdFor(lecture.courseId, str(fd, "module")),
      deliveredOn: fromDateInput(str(fd, "deliveredOn")) ?? lecture.deliveredOn,
      durationHours: positiveHours(str(fd, "durationHours")),
    },
  });
  refreshAll();
  return { ok: true, message: "Saved." };
}

export async function deleteLecture(fd: FormData) {
  const id = str(fd, "lectureId");
  const lecture = await prisma.lecture.delete({ where: { id } });
  await rm(path.join(materialsDir(), id), { recursive: true, force: true });
  refreshAll();
  redirect(`/?course=${lecture.courseId}`);
}

export async function uploadMaterial(_prev: Result, fd: FormData): Promise<Result> {
  const lectureId = str(fd, "lectureId");
  const kind = str(fd, "kind") as MaterialKind | "";
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const pasted = String(fd.get("transcriptText") ?? "").trim();
  if (files.length === 0 && !pasted) return { ok: false, message: "Choose a file or paste some text." };
  const warnings: string[] = [];
  try {
    for (const file of files) {
      warnings.push(...(await ingestFile({ file, lectureId, kind: kind || undefined })).warnings);
    }
    if (pasted) {
      await ingestFile({ file: new File([pasted], "pasted-transcript.txt"), lectureId, kind: "TRANSCRIPT" });
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  refreshAll();
  return { ok: true, message: warnings.length ? `Added, with warnings: ${warnings.join(" ")}` : "Added." };
}

export async function correctText(_prev: Result, fd: FormData): Promise<Result> {
  await prisma.material.update({
    where: { id: str(fd, "materialId") },
    data: { extractedText: String(fd.get("extractedText") ?? "") },
  });
  refreshAll();
  return { ok: true, message: "Saved." };
}

export async function deleteMaterial(fd: FormData) {
  await prisma.material.delete({ where: { id: str(fd, "materialId") } });
  refreshAll();
}

// ---------------------------------------------------------------------------
// The AI queue

/** Queues lectures one at a time, in the order given. */
export async function prepareLectures(fd: FormData) {
  await queuePrepare(fd.getAll("lectureId").map(String), { redo: fd.get("redo") === "1" });
  refreshAll();
}

export async function writeMoreLaqs(fd: FormData) {
  const lectureId = str(fd, "lectureId");
  const busy = await prisma.job.count({
    where: { lectureId, kind: { in: ["PREPARE", "GENERATE"] }, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (!busy) await enqueue("GENERATE", { lectureId }, lectureId);
  refreshAll();
}

export async function clearQueueAction(fd: FormData) {
  await clearQueue(str(fd, "lectureId") || undefined);
  refreshAll();
}

export async function retryJobAction(fd: FormData) {
  await retryJob(str(fd, "jobId"));
  refreshAll();
}

// ---------------------------------------------------------------------------
// Copy-and-paste mode: replies pasted back from an AI chat

export async function saveSummary(_prev: Result, fd: FormData): Promise<Result> {
  const lectureId = str(fd, "lectureId");
  const parsed = parseSummary(String(fd.get("text") ?? ""));
  if (!parsed.markdown) return { ok: false, message: "That paste is empty." };
  const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId } });
  await prisma.lecture.update({
    where: { id: lectureId },
    data: {
      summaryMd: parsed.markdown,
      ...(lecture.autoTitle && parsed.title ? { title: parsed.title, autoTitle: false } : {}),
    },
  });
  refreshAll();
  return { ok: true, message: "Summary saved." };
}

export async function saveLaqs(_prev: Result, fd: FormData): Promise<Result> {
  const lectureId = str(fd, "lectureId");
  const laqs = parseLaqs(String(fd.get("text") ?? ""));
  if (laqs.length === 0) return { ok: false, message: "No questions found in that paste." };
  for (const q of laqs) {
    await prisma.question.create({
      data: {
        lectureId,
        stem: q.stem,
        type: "LAQ",
        rubric: JSON.stringify({
          modelAnswer: q.modelAnswer ?? "",
          criteria: q.criteria,
          totalMarks: 10,
          source: "pasted",
        }),
        promptVersion: "pasted",
      },
    });
  }
  refreshAll();
  return { ok: true, message: `Saved ${laqs.length} LAQ${laqs.length === 1 ? "" : "s"}.` };
}

export async function deleteQuestion(fd: FormData) {
  await prisma.question.delete({ where: { id: str(fd, "questionId") } });
  refreshAll();
}

/** Pasted marking for LAQs answered outside the app — in the chat, or on paper. */
export async function logScores(_prev: Result, fd: FormData): Promise<Result> {
  const lectureId = str(fd, "lectureId");
  const scores = parseScores(String(fd.get("text") ?? ""));
  if (scores.length === 0) {
    return { ok: false, message: 'No scores found. Each needs a line like "LAQ 1: 7/10".' };
  }
  const numbers = await questionNumbers(lectureId);
  if (numbers.size === 0) return { ok: false, message: "Save this lecture's LAQs first, so scores can be matched to them." };
  const byNumber = new Map([...numbers].map(([id, n]) => [n, id]));
  const unknown = scores.filter((s) => !byNumber.has(s.number)).map((s) => s.number);
  const matched = scores.filter((s) => byNumber.has(s.number));
  if (matched.length === 0) {
    return { ok: false, message: `This lecture has LAQ 1 to LAQ ${numbers.size}; the paste mentions ${unknown.join(", ")}.` };
  }

  await prisma.attempt.create({
    data: {
      lectureId,
      source: "PASTED",
      completedAt: new Date(),
      geometricMean: geometricMean(matched.map((s) => s.mark)),
      responses: {
        create: matched.map((s) => ({
          questionId: byNumber.get(s.number)!,
          answerText: "",
          mark: s.mark,
          rubricVersion: "pasted",
          rawMarkingJson: JSON.stringify({ source: "pasted", raw: s.raw, feedback: s.feedback }),
          markedAt: new Date(),
        })),
      },
    },
  });
  refreshAll();
  return {
    ok: true,
    message:
      `Logged ${matched.length} score${matched.length === 1 ? "" : "s"}.` +
      (unknown.length ? ` Ignored LAQ ${unknown.join(", ")} — not in this lecture.` : ""),
  };
}

/** Pasted marking for an attempt answered in the app (copy-and-paste mode). */
export async function saveAttemptScores(_prev: Result, fd: FormData): Promise<Result> {
  const attemptId = str(fd, "attemptId");
  const attempt = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { responses: true },
  });
  const scores = parseScores(String(fd.get("text") ?? ""));
  if (scores.length === 0) {
    return { ok: false, message: 'No scores found. Each needs a line like "LAQ 1: 7/10".' };
  }
  const numbers = await questionNumbers(attempt.lectureId);
  let saved = 0;
  for (const s of scores) {
    const response = attempt.responses.find((r) => numbers.get(r.questionId) === s.number);
    if (!response) continue;
    await prisma.response.update({
      where: { id: response.id },
      data: {
        mark: s.mark,
        rubricVersion: "pasted",
        rawMarkingJson: JSON.stringify({ source: "pasted", raw: s.raw, feedback: s.feedback }),
        markedAt: new Date(),
      },
    });
    saved++;
  }
  if (!saved) return { ok: false, message: "None of those LAQ numbers are in this sitting." };
  await scoreAttemptIfMarked(attemptId);
  refreshAll();
  return { ok: true, message: `Saved ${saved} mark${saved === 1 ? "" : "s"}.` };
}

// ---------------------------------------------------------------------------
// Practising

export async function startAttempt(fd: FormData) {
  const lectureId = str(fd, "lectureId");
  const questionIds = await pickQuestions(lectureId);
  if (questionIds.length === 0) throw new Error("This lecture has no LAQs yet.");
  const attempt = await prisma.attempt.create({
    data: {
      lectureId,
      responses: { create: questionIds.map((questionId) => ({ questionId, answerText: "" })) },
    },
  });
  redirect(`/attempts/${attempt.id}`);
}

/**
 * Closed-book answers in. A blank answer scores 0, as it would in the exam — and
 * the geometric mean means one blank zeroes the sitting, which is the point.
 */
export async function submitAttempt(_prev: Result, fd: FormData): Promise<Result> {
  const attemptId = str(fd, "attemptId");
  const attempt = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { responses: true },
  });
  const answers = attempt.responses.map((r) => ({ r, text: String(fd.get(`answer.${r.id}`) ?? "").trim() }));
  if (answers.every((a) => !a.text)) return { ok: false, message: "Answer at least one question first." };

  const { mode } = await getSettings();
  for (const { r, text } of answers) {
    await prisma.response.update({
      where: { id: r.id },
      data: text
        ? { answerText: text }
        : {
            answerText: "",
            mark: 0,
            markedAt: new Date(),
            rawMarkingJson: JSON.stringify({ source: "blank", feedback: [{ kind: "missed", text: "Left blank." }] }),
          },
    });
    if (text && usesAi(mode)) await enqueue("MARK", { responseId: r.id }, attempt.lectureId);
  }
  await scoreAttemptIfMarked(attemptId);
  refreshAll();
  return { ok: true, message: "Submitted." };
}

// ---------------------------------------------------------------------------
// Settings

export async function setMode(fd: FormData) {
  const raw = str(fd, "mode");
  const mode: Mode = raw === "manual" || raw === "local" ? raw : "auto";
  await setSetting("mode", mode);
  refreshAll();
}

// ---------------------------------------------------------------------------
// Models on this computer

/** Starts a download in the worker. When it finishes, it is linked: local mode uses it. */
export async function downloadModel(modelId: string): Promise<Result> {
  try {
    await requestDownload(modelId);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  refreshAll();
  return { ok: true, message: "Downloading." };
}

export async function stopDownload(jobId: string) {
  await cancelDownload(jobId);
  refreshAll();
}

/** Switches to a model that is already downloaded. */
export async function switchLocalModel(modelId: string) {
  await setSetting("localModel", modelId);
  await setSetting("mode", "local");
  refreshAll();
}

export async function deleteLocalModel(modelId: string) {
  await removeModel(modelId);
  refreshAll();
}

export async function setNotify(enabled: boolean) {
  await setSetting("notify", enabled);
  refreshAll();
}

export async function finishOnboarding(choice: { mode: Mode; notify: boolean }) {
  await setSetting("mode", choice.mode);
  await setSetting("notify", choice.notify);
  await setSetting("onboarded", true);
  refreshAll();
}
