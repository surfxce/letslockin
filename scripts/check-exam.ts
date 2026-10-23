/** Isolated exam-mode integration check. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-exam-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { writeMcqs, queueMcqs, readOptions } = await import("../lib/mcq/service");
  const { createExam, saveExamAnswer, submitExam, summarise, examTree, deleteExam } = await import("../lib/exam/service");
  const { setSetting } = await import("../lib/settings");
  try {
    await applyMigrations();
    await setSetting("mode", "auto");
    const course = await prisma.course.create({ data: { code: "EXAM1", title: "Exam fixture" } });
    const renal = await prisma.module.create({ data: { courseId: course.id, title: "Renal" } });
    const lectures = [];
    for (const [i, title] of ["IgA nephropathy", "Nephrotic syndrome", "Acid-base"].entries()) {
      const lecture = await prisma.lecture.create({
        data: {
          courseId: course.id,
          moduleId: i < 2 ? renal.id : null,
          title,
          deliveredOn: new Date(2026, 9, i + 1),
          summaryMd: `## ${title}\n\nKey points about ${title}.`,
        },
      });
      const concept = await prisma.concept.create({ data: { courseId: course.id, lectureId: lecture.id, name: `${title} core`, definition: `what ${title} is` } });
      for (let q = 0; q < 2; q++) {
        await prisma.question.create({
          data: {
            lectureId: lecture.id,
            stem: `Explain ${title} (${q + 1}).`,
            type: "LAQ",
            rubric: JSON.stringify({ modelAnswer: "…", criteria: [{ point: "Core", marks: 10 }], totalMarks: 10 }),
            promptVersion: "test",
            concepts: { create: [{ conceptId: concept.id }] },
          },
        });
      }
      lectures.push(lecture);
    }
    const bare = await prisma.lecture.create({ data: { courseId: course.id, title: "Not prepared", deliveredOn: new Date(2026, 9, 9) } });

    // MCQs: written once, options shuffled, the answer still pointing at the right one.
    const provider = new FakeProvider(0);
    for (const l of lectures.slice(0, 2)) assert.equal((await writeMcqs(l.id, provider)).generated, 5);
    assert.equal((await writeMcqs(lectures[0].id, provider)).generated, 0, "never written twice");
    const mcq = await prisma.mcq.findFirstOrThrow({ where: { lectureId: lectures[0].id } });
    const options = readOptions(mcq.options);
    assert.equal(options.length, 5);
    assert.ok(options[mcq.answer].startsWith("what IgA nephropathy is"), "the shuffled answer is still the right option");
    await assert.rejects(writeMcqs(bare.id, provider), /no summary/);
    assert.deepEqual(await queueMcqs([lectures[2].id, bare.id, lectures[0].id]), [lectures[2].id], "only prepared lectures with none yet");
    assert.deepEqual(await queueMcqs([lectures[2].id]), [], "not queued twice");

    const tree = await examTree();
    assert.equal(tree[0].modules.length, 2);
    assert.equal(tree[0].modules[0].title, "Renal");
    assert.equal(tree[0].modules[1].lectures.length, 2, "lectures without a module are listed too");

    // An exam across all three: MCQs from the two that have them, LAQs spread out.
    await assert.rejects(createExam({ lectureIds: [], mcqs: 5, laqs: 2, timeLimitMin: null, focus: "mixed" }), /at least one lecture/);
    await assert.rejects(createExam({ lectureIds: [bare.id], mcqs: 5, laqs: 2, timeLimitMin: null, focus: "mixed" }), /no LAQs or MCQs/);
    const examId = await createExam({ lectureIds: lectures.map((l) => l.id), mcqs: 4, laqs: 3, timeLimitMin: 45, focus: "mixed" });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { items: { orderBy: { position: "asc" }, include: { mcq: true, question: true } } } });
    assert.equal(exam.timeLimitMin, 45);
    assert.deepEqual(exam.items.map((i) => i.kind), ["MCQ", "MCQ", "MCQ", "MCQ", "LAQ", "LAQ", "LAQ"], "multiple choice first");
    assert.equal(new Set(exam.items.filter((i) => i.kind === "MCQ").map((i) => i.mcq!.lectureId)).size, 2, "MCQs spread across lectures");
    assert.equal(new Set(exam.items.filter((i) => i.kind === "LAQ").map((i) => i.question!.lectureId)).size, 3, "one LAQ from each lecture");

    const [m1, m2, m3] = exam.items.filter((i) => i.kind === "MCQ");
    const [l1, l2, l3] = exam.items.filter((i) => i.kind === "LAQ");
    assert.equal(await saveExamAnswer(m1.id, { choice: m1.mcq!.answer }), true);
    assert.equal(await saveExamAnswer(m2.id, { choice: (m2.mcq!.answer + 1) % 5 }), true);
    assert.equal(await saveExamAnswer(l1.id, { text: "A drafted answer." }), true);

    // Handed in: what the form holds wins over the drafts; a blank LAQ scores 0.
    const choices = new Map<string, number | null>([[m3.id, m3.mcq!.answer]]);
    const texts = new Map([[l2.id, "Typed at the end."], [l3.id, "   "]]);
    assert.equal((await submitExam(examId, { choices, texts })).ok, true);
    assert.equal((await submitExam(examId, { choices, texts })).message, "Already handed in.");
    assert.equal(await saveExamAnswer(m1.id, { choice: 0 }), false, "closed once handed in");

    const attempts = await prisma.attempt.findMany({ where: { source: "EXAM" }, include: { responses: true } });
    assert.equal(attempts.length, 3, "one sitting per lecture");
    const responses = attempts.flatMap((a) => a.responses);
    assert.deepEqual(responses.map((r) => r.answerText).sort(), ["", "A drafted answer.", "Typed at the end."]);
    assert.equal(responses.find((r) => !r.answerText)?.mark, 0);
    const blankAttempt = attempts.find((a) => a.responses.some((r) => !r.answerText))!;
    assert.equal(blankAttempt.geometricMean, 0, "a lecture whose only answer is blank is scored at once");
    assert.equal(await prisma.job.count({ where: { kind: "MARK" } }), 2, "the written answers are queued for marking");

    const done = await prisma.exam.findUniqueOrThrow({
      where: { id: examId },
      include: { items: { select: { kind: true, choice: true, questionId: true, mcq: { select: { answer: true } }, response: { select: { mark: true } } } } },
    });
    const s = summarise(done.items);
    assert.equal(s.mcqTotal, 4);
    assert.equal(s.mcqCorrect, 2, "one saved right, one chosen at hand-in, one wrong, one left out");
    assert.equal(s.pending, 2);
    assert.equal(s.laqScore, null);

    // A second exam prefers what wasn't asked before…
    const second = await createExam({ lectureIds: lectures.map((l) => l.id), mcqs: 4, laqs: 3, timeLimitMin: null, focus: "mixed" });
    const secondItems = await prisma.examItem.findMany({ where: { examId: second } });
    const firstMcqs = new Set(exam.items.map((i) => i.mcqId).filter(Boolean));
    assert.ok(secondItems.filter((i) => i.mcqId).every((i) => !firstMcqs.has(i.mcqId)), "unseen MCQs first");
    const firstLaqs = new Set(exam.items.map((i) => i.questionId).filter(Boolean));
    assert.ok(secondItems.filter((i) => i.questionId).every((i) => !firstLaqs.has(i.questionId)), "unseen LAQs first");
    // …and with weak focus, the ones got wrong or left out come back first.
    const third = await createExam({ lectureIds: lectures.map((l) => l.id), mcqs: 2, laqs: 0, timeLimitMin: null, focus: "weak" });
    const missed = exam.items.filter((i) => i.kind === "MCQ" && ![m1.id, m3.id].includes(i.id)).map((i) => i.mcqId).sort();
    assert.deepEqual((await prisma.examItem.findMany({ where: { examId: third } })).map((i) => i.mcqId).sort(), missed);

    // Deleting results keeps the sittings with their lectures.
    await deleteExam(examId);
    assert.equal(await prisma.attempt.count({ where: { source: "EXAM" } }), 3);
    // Deleting a lecture leaves the exam, minus its questions.
    await prisma.lecture.delete({ where: { id: lectures[0].id } });
    assert.ok(await prisma.exam.findUnique({ where: { id: second } }));
    console.log("exam check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
