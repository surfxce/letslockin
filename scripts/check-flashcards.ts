/** Isolated AK integration check. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-ak-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  process.env.LOCKIN_FAKE_DELAY_MS = "20";
  process.env.LOCKIN_WORKER_POLL_MS = "50";
  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { queueFlashcards, generateFlashcards, reviewCard } = await import("../lib/flashcards/service");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { getSettings, setSetting } = await import("../lib/settings");
  let worker: ChildProcess | undefined;
  let output = "";
  try {
    await applyMigrations();
    const course = await prisma.course.create({ data: { code: "AKTEST", title: "AK fixture" } });
    const makeLecture = (title: string) => prisma.lecture.create({ data: { courseId: course.id, title, deliveredOn: new Date(), summaryMd: "Insulin lowers blood glucose by increasing glucose uptake into muscle and fat. Glucagon increases hepatic glucose output during fasting." } });
    const lecture = await makeLecture("Glucose regulation");
    const first = await queueFlashcards(lecture.id);
    assert.equal((await queueFlashcards(lecture.id)).id, first.id);
    await prisma.job.update({ where: { id: first.id }, data: { status: "RUNNING" } });
    const provider = new FakeProvider(0);
    assert.ok((await generateFlashcards(lecture.id, first.id, provider)).generated > 0);
    assert.equal((await generateFlashcards(lecture.id, first.id, provider)).generated, 0);
    const card = await prisma.flashcard.findFirstOrThrow({ where: { lectureId: lecture.id } });
    assert.equal((await reviewCard(card.id, 0, 1)).saved, true);
    assert.equal((await reviewCard(card.id, 0, 4)).saved, false);
    assert.equal((await reviewCard(card.id, 1, 4)).saved, false, "future card cannot be reviewed early");
    assert.equal(await prisma.flashcardReview.count(), 1);
    assert.equal((await prisma.lecture.findUniqueOrThrow({ where: { id: lecture.id } })).summaryMd, lecture.summaryMd);
    await prisma.job.update({ where: { id: first.id }, data: { status: "DONE" } });

    const cancelled = await makeLecture("Cancelled deck");
    const cancelledJob = await queueFlashcards(cancelled.id);
    await prisma.job.update({ where: { id: cancelledJob.id }, data: { status: "FAILED" } });
    await assert.rejects(generateFlashcards(cancelled.id, cancelledJob.id, provider), /cancelled/);
    assert.equal(await prisma.flashcard.count({ where: { lectureId: cancelled.id } }), 0);

    const invalid = await makeLecture("Invalid output");
    const badJob = await queueFlashcards(invalid.id);
    await prisma.job.update({ where: { id: badJob.id }, data: { status: "RUNNING" } });
    provider.generateFlashcards = async () => ({ cards: [
      { front: { text: "Valid?", slide: null }, back: { text: "Yes", slide: null } },
      { front: { text: "Imaginary slide?", slide: 999 }, back: { text: "No", slide: null } },
    ] });
    await assert.rejects(generateFlashcards(invalid.id, badJob.id, provider), /slide 999/);
    assert.equal(await prisma.flashcard.count({ where: { lectureId: invalid.id } }), 0, "invalid deck saves no partial cards");
    await prisma.job.update({ where: { id: badJob.id }, data: { status: "FAILED" } });

    const pictured = await makeLecture("Image deck");
    await prisma.material.create({ data: { lectureId: pictured.id, kind: "SLIDES", path: "fixture.pdf", originalName: "fixture.pdf", checksum: "image-test", pageCount: 2 } });
    const imageJob = await queueFlashcards(pictured.id);
    await prisma.job.update({ where: { id: imageJob.id }, data: { status: "RUNNING" } });
    provider.generateFlashcards = async () => ({ cards: [
      { front: { text: "Interpret this diagram.", slide: 1 }, back: { text: "The mechanism.", slide: 2 } },
      { front: { text: "Interpret this diagram.", slide: 1 }, back: { text: "Duplicate question.", slide: null } },
    ] });
    assert.equal((await generateFlashcards(pictured.id, imageJob.id, provider)).generated, 1);
    const image = await prisma.flashcard.findFirstOrThrow({ where: { lectureId: pictured.id } });
    assert.match(image.front, /slide:1/);
    assert.match(image.back, /slide:2/);
    await prisma.job.update({ where: { id: imageJob.id }, data: { status: "DONE" } });

    // Exercise the real worker dispatch, independent lane and opt-in preparation.
    assert.equal((await getSettings()).autoFlashcards, false);
    const manualDeck = await makeLecture("Separate deck lane");
    const manualJob = await queueFlashcards(manualDeck.id);
    worker = spawn(process.execPath, ["--import", "tsx", "worker/index.ts"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout?.on("data", d => output += d);
    worker.stderr?.on("data", d => output += d);
    const untilDone = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const row = await prisma.job.findUniqueOrThrow({ where: { id } });
        if (row.status === "DONE") return row;
        if (row.status === "FAILED") throw new Error(row.error ?? "Job failed");
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`Worker timeout: ${output}`);
    };
    await untilDone(manualJob.id);
    assert.ok(await prisma.flashcard.count({ where: { lectureId: manualDeck.id } }));
    const prepare = async (title: string) => {
      const l = await makeLecture(title);
      await prisma.material.create({ data: { lectureId: l.id, kind: "TRANSCRIPT", path: "fixture.txt", originalName: "fixture.txt", checksum: l.id, extractedText: l.summaryMd } });
      const job = await prisma.job.create({ data: { kind: "PREPARE", lectureId: l.id, payload: JSON.stringify({ lectureId: l.id }) } });
      await untilDone(job.id);
      return l;
    };
    const off = await prepare("Opt out");
    assert.equal(await prisma.job.count({ where: { lectureId: off.id, kind: "FLASHCARDS" } }), 0);
    await setSetting("autoFlashcards", true);
    const on = await prepare("Opt in");
    const auto = await prisma.job.findFirstOrThrow({ where: { lectureId: on.id, kind: "FLASHCARDS" } });
    await untilDone(auto.id);
    assert.ok(await prisma.flashcard.count({ where: { lectureId: on.id } }));
    assert.ok(await prisma.question.count({ where: { lectureId: on.id } }));
    await prisma.lecture.delete({ where: { id: lecture.id } });
    assert.equal(await prisma.flashcardReview.count({ where: { cardId: card.id } }), 0);
    console.log("AK integration passed: migrations, deduplication, atomic generation, cancellation, durable reviews, stale/early review protection, worker lane, opt-in preparation, cascade cleanup.");
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGTERM");
      await new Promise<void>(resolve => worker!.once("exit", () => resolve()));
    }
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
