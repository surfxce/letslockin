/** Isolated check of viva mode: the examiner's follow-ups, moving on, ending, and marking. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FAKE_HELPER = `#!/usr/bin/env node
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (process.argv[2] === "transcribe") say({ segments: [{ start: 0, text: "IgA deposits" }, { start: 2, text: "in the mesangium." }], duration: 3 });
else { say({ error: "unknown" }); process.exit(1); }
`;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-viva-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  const helper = path.join(dir, "lockin-whisper");
  await writeFile(helper, FAKE_HELPER);
  await chmod(helper, 0o755);
  process.env.LOCKIN_WHISPER = helper;

  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { setSetting } = await import("../lib/settings");
  const { startViva, answerViva, runVivaTurn, skipVivaQuestion, endViva, recoverViva } = await import("../lib/viva/service");
  const { readPlan, readTurns, MAX_PROBES } = await import("../lib/viva/schema");
  const { hearAnswer } = await import("../lib/viva/listen");
  const { encodeWav } = await import("../lib/viva/wav");
  const provider = new FakeProvider(0);
  try {
    await applyMigrations();
    await setSetting("mode", "manual");
    const course = await prisma.course.create({ data: { code: "VIVA1", title: "Viva fixture" } });
    const lectures = [];
    for (const title of ["IgA nephropathy", "Nephrotic syndrome"]) {
      const lecture = await prisma.lecture.create({ data: { courseId: course.id, title, deliveredOn: new Date(), summaryMd: `## ${title}` } });
      for (let q = 0; q < 2; q++) {
        await prisma.question.create({
          data: {
            lectureId: lecture.id,
            stem: `Explain ${title} (${q + 1}).`,
            type: "LAQ",
            rubric: JSON.stringify({ modelAnswer: "…", criteria: [{ point: "Names the deposit site", marks: 6 }, { point: "Gives the sign", marks: 4 }], totalMarks: 10 }),
            promptVersion: "test",
          },
        });
      }
      lectures.push(lecture);
    }
    const ids = lectures.map((l) => l.id);
    await assert.rejects(startViva({ lectureIds: ids, questions: 3, focus: "mixed" }), /needs an AI/);
    await setSetting("mode", "auto");
    await assert.rejects(startViva({ lectureIds: [], questions: 3, focus: "mixed" }), /at least one lecture/);

    const vivaId = await startViva({ lectureIds: ids, questions: 3, focus: "mixed" });
    let viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    const plan = readPlan(viva.plan);
    assert.equal(plan.length, 3);
    assert.equal(new Set(plan.map((p) => p.lectureId)).size, 2, "spread across the lectures");
    assert.match(readTurns(viva.turns)[0].text, /^Let's begin\. Explain/);

    // A short answer gets a follow-up from the examiner, up to the limit…
    for (let probe = 1; probe <= MAX_PROBES; probe++) {
      assert.deepEqual(await answerViva(vivaId, "Deposits."), { ok: true, message: "" });
      assert.equal((await answerViva(vivaId, "again")).ok, false, "not while the examiner is thinking");
      assert.equal(await prisma.job.count({ where: { kind: "VIVA", status: "PENDING" } }), probe);
      assert.deepEqual(await runVivaTurn(vivaId, provider), { move: "probe" });
      viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
      assert.equal(viva.probes, probe);
      assert.equal(viva.waitingOn, "student");
      assert.match(readTurns(viva.turns).at(-1)!.text, /names the deposit site/);
    }
    // …then moves on without asking the AI.
    await answerViva(vivaId, "In the mesangium, I think.");
    viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    assert.equal(viva.current, 1);
    assert.equal(viva.probes, 0);
    assert.equal(await prisma.job.count({ where: { kind: "VIVA" } }), MAX_PROBES, "no examiner call needed");
    assert.match(readTurns(viva.turns).at(-1)!.text, /^Next question\. Explain/);

    // A full answer is accepted and the next question follows.
    await answerViva(vivaId, "IgA immune complexes deposit in the mesangium and cause visible haematuria after an infection, often in young men.");
    assert.deepEqual(await runVivaTurn(vivaId, provider), { move: "next" });
    viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    assert.equal(viva.current, 2);
    assert.deepEqual(readTurns(viva.turns).slice(-2).map((t) => t.text.split(".")[0]), ["Okay, thank you", "Next question"]);

    // "I don't know" ends it; everything is handed in and marked.
    await skipVivaQuestion(vivaId);
    viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    assert.equal(viva.waitingOn, "done");
    assert.ok(viva.finishedAt);
    assert.equal((await answerViva(vivaId, "late")).ok, false);
    const attempts = await prisma.attempt.findMany({ where: { source: "VIVA" }, include: { responses: true } });
    assert.equal(attempts.reduce((n, a) => n + a.responses.length, 0), 3);
    const handed = readPlan(viva.plan);
    assert.ok(handed.every((p) => p.responseId), "each question points at its answer");
    const first = attempts.flatMap((a) => a.responses).find((r) => r.id === handed[0].responseId)!;
    assert.match(first.answerText, /^\(Answered out loud in a viva/);
    assert.match(first.answerText, /Student: Deposits\.\n\nExaminer: Can you say more/);
    assert.match(first.answerText, /Student: In the mesangium, I think\.$/);
    const skipped = attempts.flatMap((a) => a.responses).find((r) => r.id === handed[2].responseId)!;
    assert.equal(skipped.mark, 0, "asked and not answered scores 0");
    assert.equal(await prisma.job.count({ where: { kind: "MARK" } }), 2);

    // Ending early marks only what was asked; an examiner that fails doesn't leave it hanging.
    const early = await startViva({ lectureIds: ids, questions: 3, focus: "weak" });
    await answerViva(early, "Something.");
    await recoverViva(early);
    assert.equal((await prisma.viva.findUniqueOrThrow({ where: { id: early } })).current, 1, "moved on");
    assert.deepEqual(await runVivaTurn(early, provider), { move: "none" }, "nothing for the examiner to do");
    await endViva(early);
    const ended = await prisma.viva.findUniqueOrThrow({ where: { id: early } });
    assert.equal(ended.waitingOn, "done");
    assert.equal(readPlan(ended.plan).length, 2, "the unasked question is left out");

    // A phone's viva asks this computer's examiner, through the quick lane.
    const { relayVivaTurn } = await import("../lib/viva/service");
    const { ingestViva } = await import("../lib/phone/ingest");
    const questionId = readPlan(viva.plan)[0].questionId;
    const exchange = [
      { role: "examiner" as const, text: "Explain it." },
      { role: "student" as const, text: "Deposits." },
    ];
    const asked = relayVivaTurn({ questionId, exchange, probesLeft: 2 }, 10_000);
    let relayJob = null;
    for (let i = 0; i < 40 && !relayJob; i++) {
      await new Promise((r) => setTimeout(r, 50));
      relayJob = await prisma.job.findFirst({ where: { kind: "VIVA", status: "PENDING", payload: { contains: "relay" } } });
    }
    assert.ok(relayJob, "queued for the worker");
    const move = await provider.vivaTurn(JSON.parse(relayJob.payload).relay);
    await prisma.job.update({ where: { id: relayJob.id }, data: { status: "DONE", result: JSON.stringify(move) } });
    assert.deepEqual(await asked, move);
    assert.equal(move.move, "probe");
    await assert.rejects(relayVivaTurn({ questionId, exchange, probesLeft: 0 }, 300), /took too long/);
    assert.equal((await prisma.job.findFirstOrThrow({ where: { kind: "VIVA", payload: { contains: "relay" } }, orderBy: { createdAt: "desc" } })).status, "FAILED");
    await assert.rejects(relayVivaTurn({ questionId: "gone-question", exchange, probesLeft: 1 }), /no longer on the computer/);

    // A viva held on the phone arrives as sittings (source VIVA) and a finished viva, once.
    const phoneViva = {
      id: "phoneviva1",
      title: "VIVA1 viva",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      submittedAt: new Date().toISOString(),
      plan: [{ questionId, lectureId: readPlan(viva.plan)[0].lectureId, responseId: "phoneresp1" }],
      turns: [
        { role: "examiner" as const, text: "Explain it.", questionId, at: new Date().toISOString() },
        { role: "student" as const, text: "IgA in the mesangium.", questionId, at: new Date().toISOString() },
      ],
      sittings: [
        {
          id: "phonesit1",
          lectureId: readPlan(viva.plan)[0].lectureId,
          startedAt: new Date(Date.now() - 600_000).toISOString(),
          submittedAt: new Date().toISOString(),
          responses: [{ id: "phoneresp1", questionId, answerText: "(Answered out loud in a viva.)\n\nStudent: IgA in the mesangium." }],
        },
      ],
    };
    assert.deepEqual(await ingestViva(phoneViva), { id: "phoneviva1", note: null });
    assert.equal((await ingestViva(phoneViva)).note, "already received");
    const stored = await prisma.viva.findUniqueOrThrow({ where: { id: "phoneviva1" } });
    assert.equal(stored.waitingOn, "done");
    assert.equal(readPlan(stored.plan)[0].responseId, "phoneresp1");
    assert.equal((await prisma.attempt.findUniqueOrThrow({ where: { id: "phonesit1" } })).source, "VIVA");

    // A spoken answer is heard by Whisper here.
    const wav = Buffer.from(encodeWav(new Float32Array(16_000)));
    assert.deepEqual(await hearAnswer(wav, ids[0]), { text: "IgA deposits in the mesangium.", via: "Whisper" });
    delete process.env.LOCKIN_WHISPER;
    await assert.rejects(hearAnswer(wav, ids[0]), /type your answer/);
    console.log("viva check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
