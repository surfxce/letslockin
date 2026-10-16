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

import { runAsk, type AskPayload } from "@/lib/ask";
import { findModel } from "@/lib/llm/catalog";
import { prisma } from "@/lib/db";
import type { SortedFolder } from "@/lib/group";
import { closeSteps, enterStage, setStageDetail, SIDE_LANES } from "@/lib/jobs";
import { cloudProvider, getLocalProvider, isFake, type LlmProvider } from "@/lib/llm";
import { CloudError } from "@/lib/llm/base";
import type { SortFile } from "@/lib/llm/provider";
import { downloadModelFile, modelSource } from "@/lib/llm/download";
import { activeLocalModel, fallbackLocalModel, modelsDir, registerModel } from "@/lib/models";
import { LocalProvider, releaseLocalModel } from "@/lib/llm/local";
import { installMmproj, installServer, lookAtSlides, visionParts } from "@/lib/llm/vision";
import { JobCancelled, jobSignal, runCancellable } from "@/lib/llm/cancel";
import { readSlidePictures } from "@/lib/ocr";
import { lectureDecks } from "@/lib/slides";
import type { SlideNote } from "@/lib/sources";
import { CLOUD_ENGINE_LABEL, MODE_LABEL } from "@/lib/modes";
import { digestLecture, markResponse, writeQuestions } from "@/lib/pipeline";
import { getSettings, HEARTBEAT_KEY, setSetting } from "@/lib/settings";
import type { JobKind } from "@/lib/types";

const POLL_MS = Number(process.env.LOCKIN_WORKER_POLL_MS ?? 2000);
const HEARTBEAT_MS = 5000;
/** One retry. Each model call already gets a repair pass for bad JSON, so a second
 *  failure is usually real (not logged in, rate limited) and the queue should move on. */
const MAX_ATTEMPTS = 2;

type Handler = (payload: Record<string, unknown>, jobId: string, provider: LlmProvider) => Promise<unknown>;

const handlers: Record<Exclude<JobKind, "DOWNLOAD" | "SORT" | "ASK">, Handler> = {
  /** Files → title, summary, concepts → first LAQs. Skips whatever is already done. */
  PREPARE: async (payload, jobId, provider) => {
    const lectureId = String(payload.lectureId);
    const redo = payload.redo === true;
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      select: {
        summaryMd: true,
        _count: { select: { questions: true, concepts: { where: { mergedIntoId: null } } } },
      },
    });

    const result: Record<string, unknown> = {};
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
    return writeQuestions(lectureId, provider);
  },

  MARK: async (payload, jobId, provider) => {
    await enterStage(jobId, "marking");
    return markResponse(String(payload.responseId), provider);
  },
};

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
  const parts = await visionParts(modelsDir(), provider.modelId, provider.modelPath);
  const decks = (await lectureDecks(lectureId)).filter((d) => d.pdf && d.pages > 0);
  if (!parts || decks.length === 0) return undefined;
  await enterStage(jobId, "vision");
  try {
    // llama.cpp's server loads the model itself; two copies may not fit in memory.
    await releaseLocalModel();
    const notes = await lookAtSlides(
      parts,
      { lectureId, decks: decks.map(({ materialId, file, name, first, pages, pdf }) => ({ materialId, file, name, first, pages, pdf })), sharedWith: [] },
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
async function currentProvider(): Promise<LlmProvider | null> {
  const { mode } = await getSettings();
  if (mode === "manual") return null;
  if (mode === "local") {
    const active = await activeLocalModel();
    return active ? getLocalProvider(active.path, active.model.name, active.model.id) : null;
  }
  return cloudProvider();
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
    const local = getLocalProvider(model.path, model.model.name, model.model.id);
    console.warn(`${primary.lastModel} failed (${why}); doing it on ${model.model.name} instead`);
    onFallback?.(why, local);
    return { result: await work(local), used: local, fellBack: why };
  }
}

async function claimNext() {
  // Single-writer worker, so a read-then-update claim is sufficient here.
  const job = await prisma.job.findFirst({
    where: { status: "PENDING", kind: { notIn: SIDE_LANES } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  if (!job) return null;
  return prisma.job.update({
    where: { id: job.id },
    // Each attempt gets a fresh timeline: an earlier one's stages are not this one's.
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, stage: null, steps: null },
  });
}

async function runOne(): Promise<boolean> {
  const provider = await currentProvider();
  if (!provider) return false;
  const job = await claimNext();
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
  const { modelId, link, visionOnly } = JSON.parse(job.payload) as { modelId: string; link?: boolean; visionOnly?: boolean };
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
    if (!visionOnly) {
      console.log(`↓ ${model.name} from ${modelSource(model)}`);
      ({ path, bytes } = await downloadModelFile(model, modelsDir(), (d, t) => report(d, t), controller.signal));
      await registerModel({ id: model.id, path, bytes, downloadedAt: new Date().toISOString() });
      // Linking up: a finished download becomes the model local mode uses.
      if (link) {
        await setSetting("localModel", model.id);
        await setSetting("mode", "local");
      }
    }
    // A model that takes images gets its vision part and llama.cpp's server, so it can
    // be shown the slides. Without them it still works, reading slides as text.
    let visionError: string | null = null;
    if (model.vision) {
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
// Sorting a folder into lectures, in its own lane: someone is waiting on the
// import screen, so it must not queue behind a lecture being prepared.

async function sortOne(): Promise<boolean> {
  const pending = await prisma.job.findFirst({
    where: { kind: "SORT", status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return false;
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
  const pending = await prisma.job.findFirst({
    where: { kind: "ASK", status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return false;
  const job = await prisma.job.update({
    where: { id: pending.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  const started = Date.now();
  try {
    const provider = await currentProvider();
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
async function heartbeat() {
  if (Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
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
  // A job left RUNNING means the last worker died mid-job. Put it back in the queue;
  // a download picks up from its partial file.
  const { count } = await prisma.job.updateMany({
    where: { status: "RUNNING" },
    data: { status: "PENDING", stage: null },
  });
  if (count) console.log(`requeued ${count} job(s) interrupted by the last shutdown`);
  // A sort's answer is only wanted while its import screen is open.
  await prisma.job.deleteMany({ where: { kind: "SORT", createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
  // Questions asked are kept a while: the lecture page lists recent ones.
  await prisma.job.deleteMany({ where: { kind: "ASK", createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
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
    prisma.setting
      .delete({ where: { key: HEARTBEAT_KEY } })
      .catch(() => undefined)
      .finally(() => process.exit(0));
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

  while (running) {
    const didWork = await runOne();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await Promise.all([downloads, sorts, asks]);
  clearInterval(beat);
  await prisma.setting.delete({ where: { key: HEARTBEAT_KEY } }).catch(() => undefined);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
