/**
 * Drains the Job table one job at a time — so a folder of lectures is prepared one
 * lecture at a time, each finished before the next starts, and marking jumps the
 * queue. Every job records its raw result, duration, prompt version and a timeline
 * of the stages it went through, so the UI can say what it is doing and since when.
 *
 * The AI part runs on Claude Code or on a model downloaded to this computer, as the
 * settings say at the moment each job starts. Model downloads run in a lane of their
 * own beside the queue, so a lecture can be prepared while a bigger model downloads.
 *
 * Run with `npm run worker` (the desktop app starts it for you).
 */
import "dotenv/config";
import { generateFlashcards, queueFlashcards } from "@/lib/flashcards/service";
import { rm } from "node:fs/promises";

import { runAsk, type AskPayload } from "@/lib/ask";
import { findModel } from "@/lib/llm/catalog";
import { prisma } from "@/lib/db";
import { OWN_QUESTIONS } from "@/lib/mixed/schema";
import type { SortedFolder } from "@/lib/group";
import { closeSteps, enterStage, setStageDetail, SIDE_LANES } from "@/lib/jobs";
import { cloudProvider, getLocalProvider, isFake, type LlmProvider } from "@/lib/llm";
import { CloudError } from "@/lib/llm/base";
import type { SortFile } from "@/lib/llm/provider";
import { downloadMlxModel, downloadModelFile, modelSource } from "@/lib/llm/download";
import { activeLocalModel, activeSlideReader, fallbackLocalModel, installedModels, linkModel, modelsDir, registerModel } from "@/lib/models";
import { LocalProvider, releaseLocalModel } from "@/lib/llm/local";
import { installMmproj, installServer, lookAtSlides, lookAtSlidesMlx, visionParts } from "@/lib/llm/vision";
import { JobCancelled, jobSignal, runCancellable } from "@/lib/llm/cancel";
import { readSlidePictures } from "@/lib/ocr";
import { lectureDecks } from "@/lib/slides";
import type { SlideNote } from "@/lib/sources";
import { CLOUD_ENGINE_LABEL, MODE_LABEL } from "@/lib/modes";
import { writeMcqs } from "@/lib/mcq/service";
import { writeMistakeCards } from "@/lib/flashcards/mistakes";
import { writeMixedQuestions } from "@/lib/mixed/service";
import { transcribeLecture, untranscribed } from "@/lib/recordings/service";
import type { VivaTurnInput } from "@/lib/viva/schema";
import { recoverViva, runVivaTurn } from "@/lib/viva/service";
import { forgetPhotos, runHandwriting, sweepPhotos, type HandwritingPayload } from "@/lib/handwriting/service";
import { writeLesson } from "@/lib/lessons/service";
import { splitPaper } from "@/lib/papers/service";
import { digestLecture, markResponse, writeQuestions } from "@/lib/pipeline";
import { getSettings, HEARTBEAT_KEY, readHeartbeat } from "@/lib/settings";
import type { JobKind } from "@/lib/types";

const POLL_MS = Number(process.env.LOCKIN_WORKER_POLL_MS ?? 2000);
const HEARTBEAT_MS = 5000;
/** One retry. Each model call already gets a repair pass for bad JSON, so a second
 *  failure is usually real (not logged in, rate limited) and the queue should move on. */
const MAX_ATTEMPTS = 2;

/** True when no other live process (such as the Swift app) owns the queue. */
async function canClaimQueue(): Promise<boolean> {
  const beat = await readHeartbeat();
  if (!beat || !beat.alive) return true;
  return !beat.app && beat.pid === process.pid;
}

type Handler = (payload: Record<string, unknown>, jobId: string, provider: LlmProvider) => Promise<unknown>;

const handlers: Record<Exclude<JobKind, "DOWNLOAD" | "SORT" | "ASK" | "TRANSCRIBE" | "VIVA" | "HANDWRITING">, Handler> = {
  /** Files → title, summary, concepts → first LAQs. Skips whatever is already done. */
  PREPARE: async (payload, jobId, provider) => {
    const lectureId = String(payload.lectureId);
    const redo = payload.redo === true;
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      select: {
        summaryMd: true,
        _count: { select: { questions: { where: OWN_QUESTIONS }, mcqs: true, concepts: { where: { mergedIntoId: null } } } },
      },
    });

    const result: Record<string, unknown> = {};
    // A recording is turned into a transcript first, so there is something to read.
    if ((await untranscribed(lectureId)).length) {
      await enterStage(jobId, "transcribe");
      try {
        result.transcribed = await transcribeLecture(lectureId, provider, (detail) => provider.onProgress?.(detail));
      } catch (err) {
        // With slides to go on, the lecture is still prepared; the recording waits.
        if (jobSignal()?.aborted || !(await prisma.material.count({ where: { lectureId, kind: "SLIDES" } }))) throw err;
        result.transcribeError = err instanceof Error ? err.message : String(err);
      }
    }
    if (redo || !lecture.summaryMd || lecture._count.concepts === 0) {
      let visionNotes: SlideNote[] | undefined;
      if (!provider.seesSlides) {
        // An offline model with its vision part is shown each slide first.
        visionNotes = await lookLocally(lectureId, jobId, provider, result);
        // Otherwise the words on picture-only slides are read out. Only pages never
        // read before take any time.
        if (!visionNotes?.length) {
          const read = await readSlidePictures(lectureId, {
            onStart: () => enterStage(jobId, "slides"),
            onProgress: (detail) => void setStageDetail(jobId, detail).catch(() => undefined),
          });
          if (read.pages) result.slidePictures = read;
        }
      }
      await enterStage(jobId, "digest");
      // A pasted summary is the student's; keep it unless they asked for a redo.
      result.digest = await digestLecture(lectureId, { keepSummary: !redo, visionNotes }, provider);
    }
    if (lecture._count.questions === 0) {
      await enterStage(jobId, "questions");
      result.questions = await writeQuestions(lectureId, provider);
    }
    if (lecture._count.mcqs === 0) await addMcqs(lectureId, jobId, provider, result);
    if ((await getSettings()).autoFlashcards) await queueFlashcards(lectureId);
    return result;
  },

  /** Fresh LAQs aimed at weak concepts. Digests first if the lecture never was. */
  GENERATE: async (payload, jobId, provider) => {
    const lectureId = String(payload.lectureId);
    const concepts = await prisma.concept.count({ where: { lectureId, mergedIntoId: null } });
    if (concepts === 0) {
      await enterStage(jobId, "digest");
      await digestLecture(lectureId, { keepSummary: true }, provider);
    }
    await enterStage(jobId, "questions");
    const result: Record<string, unknown> = { ...(await writeQuestions(lectureId, provider)) };
    if ((await prisma.mcq.count({ where: { lectureId } })) === 0) await addMcqs(lectureId, jobId, provider, result);
    return result;
  },

  /** A past paper: split into questions, each filed under its lecture with a marking guide. */
  PAPER: async (payload, jobId, provider) => {
    await enterStage(jobId, "paper");
    return splitPaper(String(payload.paperId), provider);
  },

  /** Questions that join up a course's related lectures, for exams. */
  MIXED: async (payload, jobId, provider) => {
    await enterStage(jobId, "mixed");
    return writeMixedQuestions(String(payload.courseId), provider);
  },

  /** The hidden exam MCQs on their own, for lectures prepared before exam mode. */
  MCQS: async (payload, jobId, provider) => {
    await enterStage(jobId, "mcqs");
    return writeMcqs(String(payload.lectureId), provider);
  },

  FLASHCARDS: async (payload, jobId, provider) => {
    await enterStage(jobId, "flashcards");
    // Cards from the mistakes in marked answers ride in the same lane as decks.
    if (Array.isArray(payload.gapIds)) return writeMistakeCards(String(payload.lectureId), payload.gapIds.map(String), provider);
    return generateFlashcards(String(payload.lectureId), jobId, provider);
  },

  MARK: async (payload, jobId, provider) => {
    await enterStage(jobId, "marking");
    return markResponse(String(payload.responseId), provider);
  },

  /** A short lesson on a concept that keeps coming up missed or wrong. */
  LESSON: async (payload, jobId, provider) => {
    await enterStage(jobId, "lesson");
    return writeLesson(String(payload.conceptId), provider);
  },
};

/**
 * Writes the exam MCQs alongside the LAQs. A failure is noted and the job still
 * succeeds: the LAQs already saved matter more, and exam mode can ask again.
 */
async function addMcqs(lectureId: string, jobId: string, provider: LlmProvider, result: Record<string, unknown>) {
  await enterStage(jobId, "mcqs");
  try {
    result.mcqs = await writeMcqs(lectureId, provider);
  } catch (err) {
    if (err instanceof JobCancelled || jobSignal()?.aborted) throw err;
    result.mcqError = err instanceof Error ? err.message : String(err);
    console.warn(`couldn't write exam MCQs for ${lectureId}: ${result.mcqError}`);
  }
}

/**
 * Shows an offline model the lecture's slides, when it has its vision part. A failure
 * is noted and preparing carries on without: text recognition reads the slides instead.
 */
async function lookLocally(
  lectureId: string,
  jobId: string,
  provider: LlmProvider,
  result: Record<string, unknown>,
): Promise<SlideNote[] | undefined> {
  if (!(provider instanceof LocalProvider)) return undefined;
  // A pair's eye looks at the slides for the writer; else the writer looks itself.
  const reader = await activeSlideReader();
  const mlx = !!reader || (provider.format === "mlx" && !!findModel(provider.modelId)?.vision);
  const parts = mlx ? null : await visionParts(modelsDir(), provider.modelId, provider.modelPath);
  const decks = (await lectureDecks(lectureId)).filter((d) => d.pdf && d.pages > 0);
  if ((!mlx && !parts) || decks.length === 0) return undefined;
  await enterStage(jobId, "vision");
  const slides = { lectureId, decks: decks.map(({ materialId, file, name, first, pages, pdf }) => ({ materialId, file, name, first, pages, pdf })), sharedWith: [] };
  if (mlx) {
    try {
      // The writer's llama.cpp copy needn't hold memory while the eye looks; on MLX the
      // engine swaps one model for the other itself.
      if (reader && provider.format === "gguf") await releaseLocalModel();
      const notes = await lookAtSlidesMlx(reader?.path ?? provider.modelPath, slides, (detail) => void setStageDetail(jobId, detail).catch(() => undefined));
      result.slidesSeen = notes.length;
      if (reader) result.slideReader = reader.model.name;
      return notes;
    } catch (err) {
      if (jobSignal()?.aborted) throw new JobCancelled();
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`couldn't show the slides to the offline model on MLX (${message}); reading them as text instead`);
      result.visionFailed = message;
      return undefined;
    }
  }
  try {
    // llama.cpp's server loads the model itself; two copies may not fit in memory.
    await releaseLocalModel();
    const notes = await lookAtSlides(
      parts!,
      slides,
      (detail) => void setStageDetail(jobId, detail).catch(() => undefined),
    );
    result.slidesSeen = notes.length;
    return notes;
  } catch (err) {
    if (jobSignal()?.aborted) throw new JobCancelled();
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`couldn't show the slides to the offline model (${message}); reading them as text instead`);
    result.visionFailed = message;
    return undefined;
  }
}

/**
 * Which provider the next job runs on, from the settings as they are now. Null means
 * nothing can run: copy-and-paste mode, or local mode with no model downloaded yet.
 * Jobs then wait in the queue rather than failing.
 */
async function currentProvider(fresh = false): Promise<LlmProvider | null> {
  const { mode } = await getSettings();
  if (mode === "manual") return null;
  if (mode === "local") {
    const active = await activeLocalModel();
    return active ? getLocalProvider(active.path, active.model.name, active.model.id, fresh) : null;
  }
  return cloudProvider(fresh);
}

/**
 * The cloud AI first; if it fails — signed out, rate limited, a reply that would not parse —
 * the offline model does the job instead, when one is downloaded and Settings allow.
 * A lecture with nothing to read fails the same way on any model, so that is not
 * retried.
 */
async function withFallback<T>(
  primary: LlmProvider,
  work: (provider: LlmProvider) => Promise<T>,
  onFallback?: (why: string, local: LlmProvider) => void,
): Promise<{ result: T; used: LlmProvider; fellBack: string | null }> {
  try {
    return { result: await work(primary), used: primary, fellBack: null };
  } catch (err) {
    // Cancelled on purpose: nothing to fall back from.
    if (jobSignal()?.aborted) throw err;
    const cloudFailed =
      err instanceof CloudError || (err instanceof Error && (err.name === "ZodError" || err instanceof SyntaxError));
    const { mode, fallbackLocal } = await getSettings();
    if (!cloudFailed || mode !== "auto" || !fallbackLocal || isFake()) throw err;
    const model = await fallbackLocalModel();
    if (!model) throw err;
    const why = err instanceof Error ? err.message : String(err);
    const local = getLocalProvider(model.path, model.model.name, model.model.id, true);
    console.warn(`${primary.lastModel} failed (${why}); doing it on ${model.model.name} instead`);
    onFallback?.(why, local);
    return { result: await work(local), used: local, fellBack: why };
  }
}

async function claimNext(flashcards = false) {
  if (!(await canClaimQueue())) return null;
  // Single-writer worker, so a read-then-update claim is sufficient here.
  const job = await prisma.job.findFirst({
    where: { status: "PENDING", kind: flashcards ? "FLASHCARDS" : { notIn: SIDE_LANES } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  if (!job) return null;
  if (!(await canClaimQueue())) return null;
  return prisma.job.update({
    where: { id: job.id },
    // Each attempt gets a fresh timeline: an earlier one's stages are not this one's.
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, stage: null, steps: null },
  });
}

async function runOne(flashcards = false): Promise<boolean> {
  const provider = await currentProvider(flashcards);
  if (!provider) return false;
  const job = await claimNext(flashcards);
  if (!job) return false;

  const started = Date.now();
  const handler = handlers[job.kind as keyof typeof handlers];
  const progress = (detail: string | null) => void setStageDetail(job.id, detail).catch(() => undefined);
  provider.onProgress = progress;
  let fallback: LlmProvider | null = null;
  // Cancelling is a status change made by the server (the × in the AI panel); watch for it.
  const controller = new AbortController();
  const watch = setInterval(async () => {
    const now = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }).catch(() => null);
    if (!now || now.status !== "RUNNING") controller.abort();
  }, 1500);
  try {
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    const payload = JSON.parse(job.payload);
    const { result, used, fellBack } = await runCancellable(controller.signal, () =>
      withFallback(
        provider,
        (p) => handler(payload, job.id, p),
        (_why, local) => {
          fallback = local;
          local.onProgress = progress;
          progress("The cloud AI failed — the offline model is doing it instead");
        },
      ),
    );
    if (controller.signal.aborted) throw new JobCancelled();
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { steps: true } });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        stage: null,
        steps: closeSteps(current?.steps ?? null),
        result: JSON.stringify(fellBack ? { ...(result as object), fellBack } : result),
        promptVersion: used.lastPromptVersion || null,
        model: used.lastModel,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
        error: null,
      },
    });
    console.log(`✓ ${job.kind} ${job.id} on ${used.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    if (controller.signal.aborted) {
      // The server already marked it cancelled.
      await prisma.job
        .updateMany({ where: { id: job.id }, data: { stage: null, durationMs: Date.now() - started } })
        .catch(() => undefined);
      console.log(`■ ${job.kind} ${job.id} cancelled`);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    // The lecture may have been deleted mid-run, which deletes this job with it.
    await prisma.job
      .update({
        where: { id: job.id },
        data: {
          // Parked, never silently written to the database as a partial result.
          status: giveUp ? "FAILED" : "PENDING",
          stage: null,
          error: message,
          durationMs: Date.now() - started,
          finishedAt: giveUp ? new Date() : null,
        },
      })
      .catch(() => undefined);
    console.error(`✗ ${job.kind} ${job.id} attempt ${job.attempts}: ${message}`);
  } finally {
    clearInterval(watch);
    provider.onProgress = undefined;
    if (fallback) (fallback as LlmProvider).onProgress = undefined;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Model downloads, in their own lane.

async function downloadOne(): Promise<boolean> {
  const pending = await prisma.job.findFirst({
    where: { kind: "DOWNLOAD", status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return false;
  const job = await prisma.job.update({
    where: { id: pending.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, stage: "download" },
  });
  const { modelId, link, visionOnly, mlx, reader } = JSON.parse(job.payload) as {
    modelId: string;
    link?: boolean;
    visionOnly?: boolean;
    mlx?: boolean;
    reader?: string | null;
  };
  const model = findModel(modelId);
  const started = Date.now();
  const controller = new AbortController();

  // Cancelling is a status change made by the server; watch for it.
  const watch = setInterval(async () => {
    const now = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }).catch(() => null);
    if (!now || now.status !== "RUNNING") controller.abort();
  }, 2000);

  let lastWrite = 0;
  const report = (downloaded: number, total: number, part?: string) => {
    if (Date.now() - lastWrite < 1000) return;
    lastWrite = Date.now();
    void prisma.job
      .updateMany({ where: { id: job.id, status: "RUNNING" }, data: { result: JSON.stringify({ downloaded, total, part }) } })
      .catch(() => undefined);
  };
  try {
    if (!model) throw new Error(`unknown model ${modelId}`);
    let bytes = 0;
    let path = "";
    if (mlx) {
      // The MLX copy takes images itself: no separate vision part or server to fetch.
      console.log(`↓ ${model.name} (MLX) from ${model.mlx}`);
      const previous = (await installedModels()).find((m) => m.id === model.id);
      ({ path, bytes } = await downloadMlxModel(model, modelsDir(), (d, t) => report(d, t, "mlx"), controller.signal));
      await registerModel({ id: model.id, path, bytes, downloadedAt: new Date().toISOString(), format: "mlx" });
      // It replaces the llama.cpp copy, which would only take up space.
      if (previous && previous.path !== path) await rm(previous.path, { force: true, recursive: true });
      if (link) await linkModel(model, reader);
    } else if (!visionOnly) {
      console.log(`↓ ${model.name} from ${modelSource(model)}`);
      ({ path, bytes } = await downloadModelFile(model, modelsDir(), (d, t) => report(d, t), controller.signal));
      await registerModel({ id: model.id, path, bytes, downloadedAt: new Date().toISOString() });
      // Linking up: a finished download becomes the model local mode uses.
      if (link) await linkModel(model, reader);
    }
    // A model that takes images gets its vision part and llama.cpp's server, so it can
    // be shown the slides. Without them it still works, reading slides as text.
    let visionError: string | null = null;
    if (model.vision && !mlx) {
      try {
        console.log(`↓ vision part for ${model.name}`);
        await installMmproj(modelsDir(), model, (d, t) => report(d, t, "vision"), controller.signal);
        lastWrite = 0;
        report(0, 0, "server");
        await installServer(modelsDir(), controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw err;
        visionError = err instanceof Error ? err.message : String(err);
        if (visionOnly) throw err;
        console.warn(`✗ vision part for ${model.name}: ${visionError}`);
      }
    }
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        stage: null,
        result: JSON.stringify({ downloaded: bytes, total: bytes, visionError }),
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });
    console.log(`✓ downloaded ${model.name}${visionOnly ? "'s vision part" : ` to ${path}`}`);
  } catch (err) {
    const cancelled = controller.signal.aborted;
    const message = cancelled ? "Cancelled" : err instanceof Error ? err.message : String(err);
    await prisma.job
      .updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { status: "FAILED", stage: null, error: message, durationMs: Date.now() - started, finishedAt: new Date() },
      })
      .catch(() => undefined);
    console.error(`✗ download ${modelId}: ${message}`);
  } finally {
    clearInterval(watch);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transcribing a recording on its own, in its own lane: it runs with no AI set up too
// (Whisper alone), and a long one shouldn't hold up the main queue.

async function transcribeOne(): Promise<boolean> {
  if (!(await canClaimQueue())) return false;
  const pending = await prisma.job.findFirst({ where: { kind: "TRANSCRIBE", status: "PENDING" }, orderBy: { createdAt: "asc" } });
  if (!pending) return false;
  const job = await prisma.job.update({
    where: { id: pending.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, stage: null, steps: null },
  });
  const started = Date.now();
  const controller = new AbortController();
  const watch = setInterval(async () => {
    const now = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }).catch(() => null);
    if (!now || now.status !== "RUNNING") controller.abort();
  }, 1500);
  try {
    const { lectureId } = JSON.parse(job.payload) as { lectureId: string };
    // The AI checks Whisper's technical words when there is one; it isn't needed.
    const provider = await currentProvider(true).catch(() => null);
    await enterStage(job.id, "transcribe");
    const result = await runCancellable(controller.signal, () =>
      transcribeLecture(lectureId, provider, (detail) => void setStageDetail(job.id, detail).catch(() => undefined)),
    );
    if (controller.signal.aborted) throw new JobCancelled();
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { steps: true } });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        stage: null,
        steps: closeSteps(current?.steps ?? null),
        result: JSON.stringify(result),
        model: result.via.join("; ") || null,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
        error: null,
      },
    });
    console.log(`✓ TRANSCRIBE ${job.id}: ${result.transcribed} recording(s) (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    if (controller.signal.aborted) {
      await prisma.job.updateMany({ where: { id: job.id }, data: { stage: null, durationMs: Date.now() - started } }).catch(() => undefined);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    await prisma.job
      .update({ where: { id: job.id }, data: { status: "FAILED", stage: null, error: message, durationMs: Date.now() - started, finishedAt: new Date() } })
      .catch(() => undefined);
    console.error(`✗ TRANSCRIBE ${job.id}: ${message}`);
  } finally {
    clearInterval(watch);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sorting a folder into lectures, in its own lane: someone is waiting on the
// import screen, so it must not queue behind a lecture being prepared.

async function sortOne(): Promise<boolean> {
  if (!(await canClaimQueue())) return false;
  const pending = await prisma.job.findFirst({
    where: { kind: "SORT", status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return false;
  if (!(await canClaimQueue())) return false;
  const job = await prisma.job.update({
    where: { id: pending.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  const started = Date.now();
  try {
    const provider = await currentProvider();
    if (!provider) throw new Error("no AI is set up — choose Claude Code or download an offline model in Settings");
    const { files } = JSON.parse(job.payload) as { files: SortFile[] };
    const { result: sorted, used } = await withFallback(provider, (p) => p.sortFiles({ files }));
    // The model answers in file numbers; the screen knows files by path.
    const pathOf = (n: number) => files[n - 1]?.path;
    const result: SortedFolder = {
      lectures: sorted.lectures.map((l) => ({
        title: l.title,
        module: l.module,
        files: l.files.map(pathOf).filter((p): p is string => !!p),
      })),
      setAside: sorted.setAside.flatMap((s) => {
        const file = pathOf(s.file);
        return file ? [{ file, reason: s.reason }] : [];
      }),
    };
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        result: JSON.stringify(result),
        promptVersion: used.lastPromptVersion || null,
        model: used.lastModel,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });
    console.log(`✓ SORT ${job.id}: ${files.length} files into ${result.lectures.length} lectures on ${used.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.job
      .update({
        where: { id: job.id },
        data: { status: "FAILED", error: message, durationMs: Date.now() - started, finishedAt: new Date() },
      })
      .catch(() => undefined);
    console.error(`✗ SORT ${job.id}: ${message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Quick questions from a lecture page, in their own lane: someone is waiting on the
// answer, so it must not queue behind a lecture being prepared.

async function askOne(): Promise<boolean> {
  if (!(await canClaimQueue())) return false;
  const pending = await prisma.job.findFirst({
    where: { kind: { in: ["ASK", "VIVA", "HANDWRITING"] }, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return false;
  if (!(await canClaimQueue())) return false;
  const job = await prisma.job.update({
    where: { id: pending.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  const started = Date.now();
  try {
    const provider = await currentProvider();
    if (job.kind === "VIVA") {
      const { vivaId, relay } = JSON.parse(job.payload) as { vivaId?: string; relay?: VivaTurnInput };
      try {
        if (!provider) throw new Error("no AI is set up to be the examiner");
        // A phone's viva: the examiner's line is all it wants back.
        const { result, used } = await withFallback(provider, (p) => (relay ? p.vivaTurn(relay) : runVivaTurn(vivaId!, p)));
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "DONE", result: JSON.stringify(result), model: used.lastModel, durationMs: Date.now() - started, finishedAt: new Date() },
        });
      } finally {
        // Never leave the student waiting on an examiner who can't speak.
        if (vivaId) await recoverViva(vivaId).catch(() => undefined);
      }
      return true;
    }
    if (job.kind === "HANDWRITING") {
      const payload = JSON.parse(job.payload) as HandwritingPayload;
      try {
        if (!provider) throw new Error("no AI is set up to read handwriting — choose one in Settings");
        const { result, used } = await withFallback(provider, (p) => runHandwriting(payload, p));
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "DONE",
            result: JSON.stringify(result),
            promptVersion: used.lastPromptVersion || null,
            model: used.lastModel,
            durationMs: Date.now() - started,
            finishedAt: new Date(),
          },
        });
        console.log(`✓ HANDWRITING ${job.id} on ${used.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } finally {
        // Photos of someone's writing are kept no longer than it takes to read them.
        await forgetPhotos(payload).catch(() => undefined);
      }
      return true;
    }
    if (!provider) throw new Error("no AI is set up — choose Claude Code or download an offline model in Settings");
    const payload = JSON.parse(job.payload) as AskPayload;
    const { result, used } = await withFallback(provider, (p) => runAsk(payload, p));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        result: JSON.stringify({ ...result, model: used.lastModel }),
        promptVersion: used.lastPromptVersion || null,
        model: used.lastModel,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });
    console.log(`✓ ASK ${job.id} (${result.kind}) on ${used.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The lecture may have been deleted while it waited, which deletes this job with it.
    await prisma.job
      .update({
        where: { id: job.id },
        data: { status: "FAILED", error: message, durationMs: Date.now() - started, finishedAt: new Date() },
      })
      .catch(() => undefined);
    console.error(`✗ ASK ${job.id}: ${message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------

let lastBeat = 0;
let ownsQueue = false;

async function releaseHeartbeatIfOurs() {
  const beat = await readHeartbeat();
  if (beat && !beat.app && beat.pid === process.pid) {
    await prisma.setting.delete({ where: { key: HEARTBEAT_KEY } }).catch(() => undefined);
  }
  ownsQueue = false;
}

async function heartbeat() {
  if (Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
  if (!(await canClaimQueue())) {
    if (ownsQueue) {
      console.log("the queue is now run by the Swift app; yielding");
      ownsQueue = false;
    }
    return;
  }
  if (!ownsQueue) {
    // Taking over the queue: requeue any non-DOWNLOAD jobs left RUNNING by the last owner.
    const { count } = await prisma.job.updateMany({
      where: { status: "RUNNING", kind: { not: "DOWNLOAD" } },
      data: { status: "PENDING", stage: null },
    });
    if (count) console.log(`requeued ${count} job(s) interrupted by the last shutdown`);
    ownsQueue = true;
  }
  const { mode, cloudEngine } = await getSettings();
  const provider = mode === "auto" ? CLOUD_ENGINE_LABEL[cloudEngine] : MODE_LABEL[mode];
  const value = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, provider });
  await prisma.setting.upsert({
    where: { key: HEARTBEAT_KEY },
    update: { value },
    create: { key: HEARTBEAT_KEY, value },
  });
}

async function main() {
  // Requeue interrupted DOWNLOAD jobs (the Swift app runs downloads too, so it is not
  // always the last owner that left them) — but not one the Swift app is downloading
  // right now: a live swift heartbeat means it owns the queue, and its lane will finish.
  const swiftBeat = await readHeartbeat();
  if (!swiftBeat || !swiftBeat.alive || !swiftBeat.app) {
    const { count: downloadCount } = await prisma.job.updateMany({
      where: { status: "RUNNING", kind: "DOWNLOAD" },
      data: { status: "PENDING", stage: null },
    });
    if (downloadCount) console.log(`requeued ${downloadCount} download(s) interrupted by the last shutdown`);
  }
  // Non-download RUNNING jobs are requeued by heartbeat() when this worker acquires the queue.
  // A sort's answer is only wanted while its import screen is open.
  await prisma.job.deleteMany({ where: { kind: "SORT", createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
  // Questions asked are kept a while: the lecture page lists recent ones.
  await prisma.job.deleteMany({ where: { kind: "ASK", createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
  // A viva's turns are kept in the viva itself.
  await prisma.job.deleteMany({ where: { kind: { in: ["VIVA", "HANDWRITING"] }, createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
  await sweepPhotos().catch(() => undefined);
  console.log(`worker up, polling every ${POLL_MS}ms`);

  let running = true;
  // Ctrl-C in a terminal finishes the current job first. The desktop app quitting
  // (SIGTERM) does not wait out a model call that can run for minutes: the job is
  // left RUNNING and requeued at the next launch, above.
  process.on("SIGINT", () => {
    console.log("\nfinishing current job, then stopping…");
    running = false;
  });
  process.on("SIGTERM", () => {
    releaseHeartbeatIfOurs().finally(() => process.exit(0));
  });

  // The heartbeat runs on its own timer so a long model call does not make the
  // worker look dead to the UI.
  const beat = setInterval(() => heartbeat().catch(() => undefined), HEARTBEAT_MS);
  await heartbeat();

  const lane = (work: () => Promise<boolean>, poll: number) =>
    (async () => {
      while (running) {
        const did = await work().catch((err) => {
          console.error(err);
          return false;
        });
        if (!did) await new Promise((r) => setTimeout(r, poll));
      }
    })();
  const downloads = lane(downloadOne, POLL_MS);
  // Someone is watching the import screen: look often.
  const sorts = lane(sortOne, Math.min(POLL_MS, 750));
  // Someone is waiting on the lecture page for an answer: look often.
  const asks = lane(askOne, Math.min(POLL_MS, 500));
  const transcriptions = lane(transcribeOne, POLL_MS);

  // Cloud decks have their own calls and lane. Offline decks run between main jobs
  // to avoid loading competing contexts on a small laptop.
  const flashcards = lane(async () => {
    if ((await getSettings()).mode !== "auto") return false;
    return runOne(true);
  }, POLL_MS);

  while (running) {
    let didWork = await runOne();
    if (!didWork && (await getSettings()).mode === "local") didWork = await runOne(true);
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await Promise.all([downloads, sorts, asks, flashcards, transcriptions]);
  clearInterval(beat);
  await releaseHeartbeatIfOurs();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
