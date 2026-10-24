/** Isolated check of clinical cases: writing one, running it as a viva, marking its stages, and keeping them out of everything else. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-cases-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";

  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { setSetting } = await import("../lib/settings");
  const { applyMarking } = await import("../lib/pipeline");
  const { requestCase, writeCase, startCase, caseRows, deleteCase, caseStages } = await import("../lib/cases/service");
  const { readStages } = await import("../lib/cases/schema");
  const { answerViva, runVivaTurn, skipVivaQuestion, startViva } = await import("../lib/viva/service");
  const { readPlan, readTurns } = await import("../lib/viva/schema");
  const { pickQuestions } = await import("../lib/engines/attempt");
  const { createExam } = await import("../lib/exam/service");
  const { questionNumbers } = await import("../lib/views");
  const { buildSnapshot } = await import("../lib/phone/snapshot");
  const { weakSpots } = await import("../lib/lessons/service");
  const provider = new FakeProvider(0);
  try {
    await applyMigrations();
    await setSetting("mode", "manual");
    const course = await prisma.course.create({ data: { code: "CASE1", title: "Cases fixture" } });
    const other = await prisma.course.create({ data: { code: "CASE2", title: "Other course" } });
    const lectures = [];
    for (const [i, title] of ["IgA nephropathy", "Nephritic syndrome"].entries()) {
      const lecture = await prisma.lecture.create({
        data: { courseId: course.id, title, deliveredOn: new Date(Date.now() - (5 - i) * 86_400_000), summaryMd: `## ${title}\n\nIgA deposits in the mesangium.` },
      });
      const concept = await prisma.concept.create({ data: { courseId: course.id, lectureId: lecture.id, name: `${title} concept`, definition: `What ${title} is` } });
      await prisma.question.create({
        data: { lectureId: lecture.id, stem: `Explain ${title}.`, type: "LAQ", rubric: JSON.stringify({ modelAnswer: "…", criteria: [{ point: "It", marks: 10 }], totalMarks: 10 }), promptVersion: "t", concepts: { create: [{ conceptId: concept.id }] } },
      });
      lectures.push(lecture);
    }
    const unprepared = await prisma.lecture.create({ data: { courseId: course.id, title: "Not yet", deliveredOn: new Date() } });
    const elsewhere = await prisma.lecture.create({ data: { courseId: other.id, title: "Elsewhere", deliveredOn: new Date(), summaryMd: "## x" } });
    const ids = lectures.map((l) => l.id);

    // Asking for one.
    await assert.rejects(requestCase(ids), /needs an AI/);
    await setSetting("mode", "auto");
    await assert.rejects(requestCase([unprepared.id]), /been prepared/);
    await assert.rejects(requestCase([ids[0], elsewhere.id]), /one course/);
    const jobId = await requestCase([ids[1], ids[0], unprepared.id]);
    assert.equal(await requestCase(ids), jobId, "the same lectures aren't asked for twice");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.kind, "CASE");
    assert.equal(job.priority, 5, "ahead of other writing");
    assert.deepEqual(JSON.parse(job.payload), { lectureIds: ids }, "in delivery order, prepared only");

    // Written: its stages are questions of their own, each telling the case so far.
    const { caseId, stages: count } = await writeCase(ids, provider);
    assert.equal(count, 3);
    const written = await prisma.clinicalCase.findUniqueOrThrow({ where: { id: caseId }, include: { questions: { include: { concepts: true } } } });
    const stages = readStages(written.stages);
    assert.deepEqual(stages.map((s) => s.kind), ["history", "investigations", "diagnosis"]);
    assert.equal(written.questions.length, 3);
    const stageQ = new Map(written.questions.map((q) => [q.id, q]));
    const third = stageQ.get(stages[2].questionId)!;
    assert.match(third.stem, /^\*\*Clinical case\.\*\* A 24-year-old/);
    assert.match(third.stem, /\*\*History:\*\* She had a sore throat/, "what earlier stages found");
    assert.match(third.stem, /\*\*Investigations:\*\* Urine dipstick/);
    assert.match(third.stem, /\*\*Stage 3 of 3 — Diagnosis\.\*\* What is the most likely diagnosis/);
    assert.doesNotMatch(stageQ.get(stages[0].questionId)!.stem, /sore throat/, "a stage doesn't give away its own findings");
    assert.ok(written.questions.every((q) => q.concepts.length === 1 && q.lectureId === ids[0]), "filed under the lecture of what it tests");

    // Never in a sitting, an exam, a lecture's numbering, a plain viva, or the phone.
    for (const id of ids) {
      for (const q of await pickQuestions(id)) assert.ok(!stageQ.has(q), "not in a sitting");
      for (const q of (await questionNumbers(id)).keys()) assert.ok(!stageQ.has(q), "not numbered as the lecture's LAQ");
    }
    const examId = await createExam({ lectureIds: ids, mcqs: 0, laqs: 10, timeLimitMin: null, focus: "mixed" });
    const examItems = await prisma.examItem.findMany({ where: { examId }, select: { questionId: true } });
    assert.equal(examItems.length, 2);
    assert.ok(examItems.every((i) => !stageQ.has(i.questionId!)), "not in an exam");
    const plainViva = await prisma.viva.findUniqueOrThrow({ where: { id: await startViva({ lectureIds: ids, questions: 8, focus: "mixed" }) } });
    assert.equal(readPlan(plainViva.plan).length, 2, "not in a plain viva");
    const snapshot = await buildSnapshot();
    assert.ok(snapshot.lectures.flatMap((l) => l.questions).every((q) => !stageQ.has(q.id)), "not on the phone");

    // A second case from the same lectures is a different patient.
    const second = await writeCase(ids, provider);
    assert.match((await prisma.clinicalCase.findUniqueOrThrow({ where: { id: second.caseId } })).title, /^Patient 2/);

    // Run as a viva: the presentation and the first stage's question first.
    const vivaId = await startCase(caseId);
    let viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    assert.equal(viva.caseId, caseId);
    assert.equal(viva.title, written.title);
    assert.deepEqual(readPlan(viva.plan).map((p) => p.questionId), stages.map((s) => s.questionId));
    assert.equal(readTurns(viva.turns)[0].text, `${written.presentation}\n\nWhat would you ask her?`);

    // A thin answer is followed up; then the examiner moves on, saying what the stage found
    // before asking the next.
    await answerViva(vivaId, "Infections.");
    assert.deepEqual(await runVivaTurn(vivaId, provider), { move: "probe" });
    await answerViva(vivaId, "Any recent sore throat, how long before the symptoms started, and whether it has happened before with colds, plus family history.");
    assert.deepEqual(await runVivaTurn(vivaId, provider), { move: "next" });
    viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    let turns = readTurns(viva.turns);
    assert.deepEqual(turns.slice(-3).map((t) => t.text), ["Okay, thank you.", stages[0].reveal, stages[1].ask]);
    assert.equal(turns.at(-2)!.questionId, stages[0].questionId, "the findings close the stage they belong to");
    assert.equal(turns.at(-1)!.questionId, stages[1].questionId);
    assert.equal(viva.current, 1);

    // Skipped stages still reveal what they found; the end says it's the case that's over.
    await skipVivaQuestion(vivaId);
    await skipVivaQuestion(vivaId);
    viva = await prisma.viva.findUniqueOrThrow({ where: { id: vivaId } });
    turns = readTurns(viva.turns);
    assert.equal(viva.waitingOn, "done");
    assert.ok(turns.some((t) => t.text === stages[1].reveal) && turns.some((t) => t.text === stages[2].reveal));
    assert.equal(turns.at(-1)!.text, "That's the end of the case. Thank you — your answers are being marked.");

    // Handed in as a case sitting: the answered stage is marked; the skipped ones score 0.
    const attempts = await prisma.attempt.findMany({ where: { source: "CASE" }, include: { responses: true } });
    assert.equal(attempts.length, 1);
    const responses = attempts[0].responses;
    assert.equal(responses.length, 3);
    const answered = responses.find((r) => r.questionId === stages[0].questionId)!;
    assert.match(answered.answerText, /Infections\./);
    assert.ok(!answered.answerText.includes(stages[0].reveal), "the findings aren't part of the answer");
    assert.deepEqual(responses.filter((r) => r.mark === 0).length, 2);
    const mark = await prisma.job.findFirstOrThrow({ where: { kind: "MARK" } });
    assert.equal(JSON.parse(mark.payload).responseId, answered.id);

    // Its gaps count like any answer's: two misses make a weak spot.
    const concept = written.questions[0].concepts[0].conceptId;
    await applyMarking(answered.id, { mark: 4, criteria: [{ point: "It", awarded: 4, outOf: 10, note: null }], gaps: [{ conceptId: concept, type: "MISSED", text: "No timing of the sore throat." }] });
    const skipped = responses.find((r) => r.mark === 0)!;
    await applyMarking(skipped.id, { mark: 0, criteria: [{ point: "It", awarded: 0, outOf: 10, note: null }], gaps: [{ conceptId: concept, type: "MISSED", text: "Not answered." }] });
    assert.equal((await weakSpots()).find((w) => w.conceptId === concept)?.answers, 2);

    // Listed with how it last went.
    const rows = await caseRows();
    const row = rows.find((r) => r.id === caseId)!;
    assert.equal(row.last?.vivaId, vivaId);
    assert.equal(row.last?.done, true);
    assert.equal(row.lectures.join("|"), "IgA nephropathy|Nephritic syndrome");
    assert.deepEqual(row.stages, ["history", "investigations", "diagnosis"]);

    // Deleted: its stages go with it; the run's record stays, nameless.
    await deleteCase(caseId);
    assert.equal(await prisma.question.count({ where: { caseId } }), 0);
    assert.deepEqual(await caseStages(caseId), []);
    assert.ok(await prisma.viva.findUnique({ where: { id: vivaId } }));
    await assert.rejects(startCase(caseId), /isn't here any more/);
    console.log("cases check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
