/**
 * Drains the Job table one job at a time. Every job records its raw model output,
 * duration and prompt version, so a mark that looks wrong is always traceable back
 * to the exact reply and prompt that produced it.
 *
 * Run with `npm run worker`.
 */
import "dotenv/config";

import { prisma } from "@/lib/db";
import { getProvider } from "@/lib/llm";
import type { JobKind } from "@/lib/types";

const POLL_MS = Number(process.env.LOCKIN_WORKER_POLL_MS ?? 2000);
const MAX_ATTEMPTS = 3;

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const handlers: Partial<Record<JobKind, Handler>> = {
  SUMMARISE: async (payload) => {
    const lectureId = String(payload.lectureId);
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      include: { materials: true },
    });
    const transcript = lecture.materials.find((m) => m.kind === "TRANSCRIPT")?.extractedText;
    if (!transcript) throw new Error(`lecture ${lectureId} has no parsed transcript`);

    const summary = await getProvider().summarise({
      lectureTitle: lecture.title,
      durationHours: lecture.durationHours,
      transcript,
      slidesText: lecture.materials.find((m) => m.kind === "SLIDES")?.extractedText ?? undefined,
    });
    await prisma.lecture.update({
      where: { id: lectureId },
      data: { summaryMd: summary.summaryMd },
    });
    return summary;
  },
  // EXTRACT_CONCEPTS, GENERATE, MARK and PARSE_PAPER land in phases 1-2 and 6.
};

async function claimNext() {
  // Single-writer worker, so a read-then-update claim is sufficient here.
  const job = await prisma.job.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return null;
  return prisma.job.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
}

async function runOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const started = Date.now();
  const handler = handlers[job.kind as JobKind];
  try {
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    const result = await handler(JSON.parse(job.payload));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        result: JSON.stringify(result),
        durationMs: Date.now() - started,
        finishedAt: new Date(),
        error: null,
      },
    });
    console.log(`✓ ${job.kind} ${job.id} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    await prisma.job.update({
      where: { id: job.id },
      data: {
        // Parked, never silently written to the database as a partial result.
        status: giveUp ? "FAILED" : "PENDING",
        error: message,
        durationMs: Date.now() - started,
        finishedAt: giveUp ? new Date() : null,
      },
    });
    console.error(`✗ ${job.kind} ${job.id} attempt ${job.attempts}: ${message}`);
  }
  return true;
}

async function main() {
  console.log(`worker up, polling every ${POLL_MS}ms`);
  let running = true;
  process.on("SIGINT", () => {
    console.log("\nfinishing current job, then stopping…");
    running = false;
  });

  while (running) {
    const didWork = await runOne();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
