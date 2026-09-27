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
import { allocate } from "@/lib/engines/allocation";
import { geometricMean } from "@/lib/engines/geomean";
import { conceptMastery, questionBudget } from "@/lib/engines/mastery";
import { scanFolder, toManifest } from "@/lib/scan";
import type { JobKind } from "@/lib/types";

const POLL_MS = Number(process.env.LOCKIN_WORKER_POLL_MS ?? 2000);
const MAX_ATTEMPTS = 3;

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * A lecture usually has a transcript and slides, but slides alone still make a
 * summarisable lecture — fall back rather than refusing to run.
 */
function sources(
  materials: Array<{ kind: string; extractedText: string | null }>,
  lectureId: string,
): { transcript: string; slidesText?: string } {
  const pick = (kind: string) =>
    materials.find((m) => m.kind === kind && (m.extractedText ?? "").trim())?.extractedText ??
    undefined;
  const transcript = pick("TRANSCRIPT");
  const slides = pick("SLIDES");
  if (transcript) return { transcript, slidesText: slides };
  if (slides) return { transcript: slides };
  throw new Error(`lecture ${lectureId} has no parsed transcript or slides`);
}

const handlers: Partial<Record<JobKind, Handler>> = {
  SUMMARISE: async (payload) => {
    const lectureId = String(payload.lectureId);
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      include: { materials: true },
    });
    const { transcript, slidesText } = sources(lecture.materials, lectureId);

    const summary = await getProvider().summarise({
      lectureTitle: lecture.title,
      durationHours: lecture.durationHours,
      transcript,
      slidesText,
    });
    await prisma.lecture.update({
      where: { id: lectureId },
      data: { summaryMd: summary.summaryMd },
    });
    return summary;
  },
  EXTRACT_CONCEPTS: async (payload) => {
    const lectureId = String(payload.lectureId);
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      include: { materials: true },
    });
    const { transcript, slidesText } = sources(lecture.materials, lectureId);

    // The whole course's concepts go in, so the model reuses an id rather than
    // minting a synonym. Merged-away concepts are excluded — they are dead ids.
    const existing = await prisma.concept.findMany({
      where: { courseId: lecture.courseId, mergedIntoId: null },
      select: { id: true, name: true, definition: true },
    });

    const { concepts } = await getProvider().extractConcepts({
      lectureTitle: lecture.title,
      durationHours: lecture.durationHours,
      transcript,
      slidesText,
      existingConcepts: existing,
    });

    const knownIds = new Set(existing.map((c) => c.id));
    let reused = 0;
    let minted = 0;
    for (const c of concepts) {
      if (c.existingId && knownIds.has(c.existingId)) {
        // Reuse means "this lecture also covers it" — never overwrite the original
        // wording, or the id stops meaning one stable thing.
        reused++;
        continue;
      }
      await prisma.concept.create({
        data: {
          courseId: lecture.courseId,
          lectureId,
          name: c.name,
          definition: c.definition,
          sourceRef: c.sourceRef,
        },
      });
      minted++;
    }
    return { reused, minted, total: concepts.length };
  },
  IDENTIFY: async (payload) => {
    const courseId = String(payload.courseId);
    const root = String(payload.root);

    const { files, skipped } = await scanFolder(root);
    if (files.length === 0) {
      throw new Error(`nothing readable in ${root} — supported: .txt .md .vtt .srt .pdf .pptx`);
    }
    const modules = await prisma.module.findMany({
      where: { courseId },
      select: { id: true, title: true },
      orderBy: { position: "asc" },
    });

    const identification = await getProvider().identifyLectures({
      files: toManifest(files),
      existingModules: modules,
    });

    // The proposal is stored, not applied. Nothing reaches the database until the
    // review screen is confirmed.
    return {
      root,
      files: files.map((f) => ({
        relativePath: f.relativePath,
        filename: f.filename,
        kindGuess: f.kindGuess,
        measuredHours: f.measuredHours,
        warnings: f.warnings,
        checksum: f.checksum,
      })),
      skipped,
      identification,
    };
  },
  GENERATE: async (payload) => {
    const lectureId = String(payload.lectureId);
    const lecture = await prisma.lecture.findUniqueOrThrow({
      where: { id: lectureId },
      include: { materials: true, concepts: { where: { mergedIntoId: null } } },
    });
    if (lecture.concepts.length === 0) {
      throw new Error("extract concepts before generating questions — they are what it asks about");
    }
    const { transcript, slidesText } = sources(lecture.materials, lectureId);

    const mastery = await conceptMastery(lecture.concepts.map((c) => c.id));
    const budget = questionBudget(lecture.durationHours);
    const allocation = allocate(mastery, budget);
    if (allocation.length === 0) {
      return { generated: 0, note: "every concept in this lecture is already at 10/10" };
    }

    const provider = getProvider();
    const { questions } = await provider.generateQuestions({
      lectureTitle: lecture.title,
      transcript,
      slidesText,
      concepts: lecture.concepts.map((c) => ({
        id: c.id,
        name: c.name,
        definition: c.definition,
      })),
      allocation,
      type: "LAQ",
    });

    const known = new Set(lecture.concepts.map((c) => c.id));
    let generated = 0;
    for (const q of questions) {
      const conceptIds = q.conceptIds.filter((id) => known.has(id));
      if (conceptIds.length === 0) continue; // a question about nothing cannot be scored
      await prisma.question.create({
        data: {
          lectureId,
          stem: q.stem,
          type: q.type,
          rubric: JSON.stringify(q.rubric),
          promptVersion: provider.lastPromptVersion,
          concepts: { create: conceptIds.map((conceptId) => ({ conceptId })) },
        },
      });
      generated++;
    }
    return { generated, budget, targeted: allocation.length };
  },

  MARK: async (payload) => {
    const responseId = String(payload.responseId);
    const response = await prisma.response.findUniqueOrThrow({
      where: { id: responseId },
      include: {
        question: { include: { concepts: { include: { concept: true } } } },
        attempt: true,
      },
    });
    if (!response.answerText.trim()) throw new Error("nothing was written for this question");

    const concepts = response.question.concepts.map((qc) => ({
      id: qc.concept.id,
      name: qc.concept.name,
      definition: qc.concept.definition,
    }));

    const provider = getProvider();
    const marking = await provider.mark({
      questionStem: response.question.stem,
      // The rubric was frozen when the question was written. Marking applies it.
      rubric: JSON.parse(response.question.rubric),
      answerText: response.answerText,
      concepts,
    });

    const allowed = new Set(concepts.map((c) => c.id));
    await prisma.$transaction([
      prisma.response.update({
        where: { id: responseId },
        data: {
          mark: marking.mark,
          rubricVersion: response.question.promptVersion,
          rawMarkingJson: JSON.stringify(marking),
          markedAt: new Date(),
        },
      }),
      prisma.gap.deleteMany({ where: { responseId } }),
      ...marking.gaps
        // A gap must cite a concept this question covers, or recurrence counting breaks.
        .filter((g) => allowed.has(g.conceptId))
        .map((g) =>
          prisma.gap.create({
            data: { responseId, conceptId: g.conceptId, type: g.type, text: g.text },
          }),
        ),
    ]);

    // The attempt is scored only once every question in it has a mark.
    const siblings = await prisma.response.findMany({
      where: { attemptId: response.attemptId },
      select: { mark: true },
    });
    if (siblings.every((r) => r.mark !== null)) {
      await prisma.attempt.update({
        where: { id: response.attemptId },
        data: {
          geometricMean: geometricMean(siblings.map((r) => r.mark as number)),
          completedAt: new Date(),
        },
      });
    }
    return { mark: marking.mark, gaps: marking.gaps.length };
  },
  // PARSE_PAPER lands with yield scoring in phase 6.
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
