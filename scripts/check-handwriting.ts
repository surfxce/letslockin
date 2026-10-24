/** Isolated check of handwritten answers: photos made ready, read by the AI, and forgotten. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A JPEG as a phone saves it: stored sideways, with a tag saying to turn it upright. */
async function sidewaysPhoto(width: number, height: number): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(width, height);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#000";
  g.fillRect(0, 0, width / 4, height / 4);
  const jpg = await c.encode("jpeg", 90);
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-handwriting-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";

  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { LocalProvider } = await import("../lib/llm/local");
  const { setSetting } = await import("../lib/settings");
  const { loadImage } = await import("@napi-rs/canvas");
  const hw = await import("../lib/handwriting/service");
  const provider = new FakeProvider(0);
  try {
    await applyMigrations();

    // Photos are turned upright and made no bigger than needed.
    const upright = await hw.preparePhoto(await sidewaysPhoto(4000, 3000));
    const image = await loadImage(upright);
    assert.deepEqual([image.width, image.height], [1500, 2000], "upright, longest side 2000");
    assert.equal(upright[0], 0xff, "a JPEG");
    const small = await loadImage(await hw.preparePhoto(await sidewaysPhoto(800, 600)));
    assert.deepEqual([small.width, small.height], [600, 800], "small ones aren't enlarged");
    await assert.rejects(hw.preparePhoto(Buffer.from("%PDF-1.7 not a photo")), /isn't a photo/);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(64)]);
    if (process.platform !== "darwin") await assert.rejects(hw.preparePhoto(heic), /only be read on a Mac/);
    await assert.rejects(hw.savePhotos([]), /Add a photo/);

    const course = await prisma.course.create({ data: { code: "HW1", title: "Handwriting fixture" } });
    const lecture = await prisma.lecture.create({ data: { courseId: course.id, title: "IgA nephropathy", deliveredOn: new Date(), summaryMd: "## IgA" } });
    const question = await prisma.question.create({
      data: { lectureId: lecture.id, stem: "Explain the pathogenesis of IgA nephropathy.", type: "LAQ", rubric: "{}", promptVersion: "test" },
    });
    const photos = [await sidewaysPhoto(1200, 900), await sidewaysPhoto(1200, 900)];

    // No AI, no reading.
    await setSetting("mode", "manual");
    await assert.rejects(hw.queueHandwriting(question.id, photos), /needs an AI/);
    await setSetting("mode", "auto");
    await assert.rejects(hw.queueHandwriting("nope", photos), /isn't here any more/);

    // Queued in the quick lane, with the question to help read medical words.
    const jobId = await hw.queueHandwriting(question.id, photos);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.kind, "HANDWRITING");
    assert.equal(job.lectureId, lecture.id);
    const payload = JSON.parse(job.payload) as { files: string[]; question: string };
    assert.equal(payload.question, question.stem);
    assert.deepEqual(payload.files.map((f) => path.basename(f)), ["page-1.jpg", "page-2.jpg"]);
    assert.deepEqual(await hw.handwritingState(jobId), { status: "waiting" });

    // Read by the AI: the text, and the words to check — only ones that are in it.
    const read = await hw.runHandwriting(payload, provider);
    assert.match(read.text, /mesangium/);
    assert.match(read.text, /Read from 2 photos/);
    assert.deepEqual(read.unclear, ["IgA1"]);
    await prisma.job.update({ where: { id: jobId }, data: { status: "DONE", result: JSON.stringify(read), model: provider.lastModel } });
    const state = await hw.handwritingState(jobId);
    assert.equal(state.status, "done");
    assert.equal(state.status === "done" && state.text, read.text);
    assert.deepEqual(await hw.handwritingState("missing"), { status: "failed", error: "That reading isn't here any more — add the photos again." });

    // The photos go once read.
    await hw.forgetPhotos(payload);
    assert.deepEqual(await readdir(hw.handwritingDir()), []);
    await hw.forgetPhotos({ files: [path.join(dir, "lockin.db")] });
    assert.ok(await stat(path.join(dir, "lockin.db")), "never anything outside its own folder");

    // Left behind by a job that never ran: swept after a day.
    const stale = await hw.savePhotos([photos[0]]);
    const fresh = await hw.savePhotos([photos[0]]);
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(path.dirname(stale[0]), old, old);
    await hw.sweepPhotos();
    assert.deepEqual(await readdir(hw.handwritingDir()), [path.basename(path.dirname(fresh[0]))]);

    // The offline model says it can't, rather than guessing.
    const local = new LocalProvider("/nowhere/model.gguf", "Tiny", "tiny");
    await assert.rejects(local.readHandwriting(), /offline model can't read handwriting/);

    // A phone's photos, read by this computer while the phone waits.
    const relay = hw.relayHandwriting(question.id, [photos[0]], 20_000);
    for (let i = 0; i < 40; i++) {
      const pending = await prisma.job.findFirst({ where: { kind: "HANDWRITING", status: "PENDING" } });
      if (pending) {
        const result = await hw.runHandwriting(JSON.parse(pending.payload), provider);
        await prisma.job.update({ where: { id: pending.id }, data: { status: "DONE", result: JSON.stringify(result), model: "Fake" } });
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const relayed = await relay;
    assert.match(relayed.text, /Read from 1 photo\./);
    assert.equal(relayed.model, "Fake");
    console.log("handwriting check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
