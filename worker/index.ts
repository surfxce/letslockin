/**
 * Drains the Job table one job at a time — so a folder of lectures is prepared one
 * lecture at a time, each finished before the next starts, and marking jumps the
 * queue. Every job records its raw result, duration, prompt version and a timeline
 * of the stages it went through, so the UI can say what it is doing and since when.
 *
 * Run with `npm run worker` (the desktop app starts it for you).
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { closeSteps, enterStage } from "@/lib/jobs";
import { getProvider } from "@/lib/llm";
import { digestLecture, markResponse, writeQuestions } from "@/lib/pipeline";
import { HEARTBEAT_KEY } from "@/lib/settings";
import type { JobKind } from "@/lib/types";

const POLL_MS = Number(process.env.LOCKIN_WORKER_POLL_MS ?? 2000);
const HEARTBEAT_MS = 5000;
/** One retry. Each model call already gets a repair pass for bad JSON, so a second
 *  failure is usually real (not logged in, rate limited) and the queue should move on. */
const MAX_ATTEMPTS = 2;

type Handler = (payload: Record<string, unknown>, jobId: string) => Promise<unknown>;

const handlers: Record<JobKind, Handler> = {
  /** Files → title, summary, concepts → first LAQs. Skips whatever is already done. */
  PREPARE: async (payload, jobId) => {
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
      await enterStage(jobId, "digest");
      // A pasted summary is the student's; keep it unless they asked for a redo.
      result.digest = await digestLecture(lectureId, { keepSummary: !redo });
    }
    if (lecture._count.questions === 0) {
      await enterStage(jobId, "questions");
      result.questions = await writeQuestions(lectureId);
    }
    return result;
  },

  /** Fresh LAQs aimed at weak concepts. Digests first if the lecture never was. */
  GENERATE: async (payload, jobId) => {
    const lectureId = String(payload.lectureId);
    const concepts = await prisma.concept.count({ where: { lectureId, mergedIntoId: null } });
    if (concepts === 0) {
      await enterStage(jobId, "digest");
      await digestLecture(lectureId, { keepSummary: true });
    }
    await enterStage(jobId, "questions");
    return writeQuestions(lectureId);
  },

  MARK: async (payload, jobId) => {
    await enterStage(jobId, "marking");
    return markResponse(String(payload.responseId));
  },
};

async function claimNext() {
  // Single-writer worker, so a read-then-update claim is sufficient here.
  const job = await prisma.job.findFirst({
    where: { status: "PENDING" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  if (!job) return null;
  return prisma.job.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, stage: null },
  });
}

async function runOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const started = Date.now();
  const handler = handlers[job.kind as JobKind];
  try {
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    const result = await handler(JSON.parse(job.payload), job.id);
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { steps: true } });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        stage: null,
        steps: closeSteps(current?.steps ?? null),
        result: JSON.stringify(result),
        promptVersion: getProvider().lastPromptVersion || null,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
        error: null,
      },
    });
    console.log(`✓ ${job.kind} ${job.id} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
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
  }
  return true;
}

let lastBeat = 0;
async function heartbeat() {
  if (Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
  const value = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, provider: getProvider().name });
  await prisma.setting.upsert({
    where: { key: HEARTBEAT_KEY },
    update: { value },
    create: { key: HEARTBEAT_KEY, value },
  });
}

async function main() {
  // A job left RUNNING means the last worker died mid-job. Put it back in the queue.
  const { count } = await prisma.job.updateMany({
    where: { status: "RUNNING" },
    data: { status: "PENDING", stage: null },
  });
  if (count) console.log(`requeued ${count} job(s) interrupted by the last shutdown`);
  console.log(`worker up (${getProvider().name}), polling every ${POLL_MS}ms`);

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

  while (running) {
    const didWork = await runOne();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  clearInterval(beat);
  await prisma.setting.delete({ where: { key: HEARTBEAT_KEY } }).catch(() => undefined);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
