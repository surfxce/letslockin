/** Isolated check of weak-spot mini-lessons: when one is due, writing it, cards, done, and recovery. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-lessons-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";

  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { setSetting } = await import("../lib/settings");
  const { applyMarking } = await import("../lib/pipeline");
  const { weakSpots, queueLessons, writeLesson, finishLesson, lessonCards, requestLesson, LESSON_AFTER } = await import("../lib/lessons/service");
  const { readChecks } = await import("../lib/lessons/schema");
  const { todayPlan } = await import("../lib/today");
  const provider = new FakeProvider(0);
  try {
    await applyMigrations();
    await setSetting("mode", "manual");
    const course = await prisma.course.create({ data: { code: "LES1", title: "Lessons fixture" } });
    const lecture = await prisma.lecture.create({
      data: { courseId: course.id, title: "IgA nephropathy", deliveredOn: new Date(), summaryMd: "## IgA nephropathy\n\nIgA deposits in the mesangium." },
    });
    const [deposit, sign] = await Promise.all(
      [
        ["Mesangial IgA deposition", "IgA immune complexes deposit in the glomerular mesangium"],
        ["Synpharyngitic haematuria", "Visible haematuria within days of a sore throat"],
      ].map(([name, definition]) => prisma.concept.create({ data: { courseId: course.id, lectureId: lecture.id, name, definition } })),
    );
    const question = await prisma.question.create({
      data: {
        lectureId: lecture.id,
        stem: "Explain the pathogenesis of IgA nephropathy.",
        type: "LAQ",
        rubric: JSON.stringify({ modelAnswer: "…", criteria: [{ point: "Deposits", marks: 10 }], totalMarks: 10 }),
        promptVersion: "test",
        concepts: { create: [{ conceptId: deposit.id }, { conceptId: sign.id }] },
      },
    });
    let day = 0;
    const answer = async (mark: number, gaps: Array<{ conceptId: string; type: "MISSED" | "WRONG"; text: string }>) => {
      const sittingDate = new Date(Date.now() - (30 - day++) * 86_400_000);
      const attempt = await prisma.attempt.create({ data: { lectureId: lecture.id, sittingDate, completedAt: sittingDate } });
      const response = await prisma.response.create({ data: { attemptId: attempt.id, questionId: question.id, answerText: "…" } });
      await applyMarking(response.id, { mark, criteria: [{ point: "Deposits", awarded: mark, outOf: 10, note: null }], gaps });
    };
    const lessonJobs = () => prisma.job.count({ where: { kind: "LESSON", status: "PENDING" } });

    // One answer missing it isn't a pattern.
    await answer(3, [
      { conceptId: deposit.id, type: "MISSED", text: "Didn't say where the IgA deposits." },
      { conceptId: sign.id, type: "MISSED", text: "No timing of the haematuria." },
    ]);
    assert.equal((await weakSpots()).length, 0);
    // A second is — but with no AI, nothing is queued.
    await answer(4, [{ conceptId: deposit.id, type: "WRONG", text: "Said the deposits were subepithelial." }]);
    const spots = await weakSpots();
    assert.equal(LESSON_AFTER, 2);
    assert.deepEqual(spots.map((s) => [s.name, s.answers]), [["Mesangial IgA deposition", 2]]);
    assert.equal(spots[0].gaps[0].text, "Said the deposits were subepithelial.", "most recent first");
    assert.equal(await lessonJobs(), 0, "no lessons without an AI");

    await setSetting("mode", "auto");
    assert.equal(await queueLessons(), 1);
    assert.equal(await queueLessons(), 0, "queued once");
    assert.equal(await requestLesson(deposit.id), false, "already being written");
    const job = await prisma.job.findFirstOrThrow({ where: { kind: "LESSON" } });
    assert.equal(job.lectureId, lecture.id);
    assert.equal(job.priority, -5, "behind everything else");
    assert.deepEqual(JSON.parse(job.payload), { conceptId: deposit.id });
    await prisma.job.update({ where: { id: job.id }, data: { status: "DONE" } });

    // Writing it.
    const written = await writeLesson(deposit.id, provider);
    assert.equal(written.written, true);
    let lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: written.lessonId! } });
    assert.equal(lesson.gapCount, 2);
    assert.equal(lesson.lectureId, lecture.id);
    assert.equal(lesson.promptVersion, "write-lesson@fake");
    assert.match(lesson.explanation, /subepithelial/, "aimed at the latest mistake");
    assert.equal(readChecks(lesson.checks).length, 3);
    assert.deepEqual(await writeLesson(sign.id, provider), { written: false, note: "no longer a weak spot" });

    // It's in Today, and blocks another while it waits.
    let plan = await todayPlan();
    const item = [...plan.items, ...plan.later].find((i) => i.kind === "lesson");
    assert.equal(item?.href, `/lessons/${lesson.id}`);
    assert.equal(await queueLessons(), 0, "one waiting already");

    // Its questions become AK cards, once.
    assert.equal(await lessonCards(lesson.id), 3);
    assert.equal(await lessonCards(lesson.id), 0);
    const cards = await prisma.flashcard.findMany({ where: { lectureId: lecture.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(cards.map((c) => c.sourceKey), [0, 1, 2].map((i) => `lesson:${lesson.id}:${i}`));
    assert.equal(cards[0].front, readChecks(lesson.checks)[0].question);

    // Done: out of Today, and no new lesson until it's missed again.
    await finishLesson(lesson.id);
    lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    assert.ok(lesson.doneAt);
    plan = await todayPlan();
    assert.equal([...plan.items, ...plan.later].filter((i) => i.kind === "lesson").length, 0);
    assert.equal(await queueLessons(), 0, "not missed since");
    await answer(5, [{ conceptId: deposit.id, type: "MISSED", text: "Still no mesangium." }]);
    assert.equal(await lessonJobs(), 1, "missed again after the lesson: marking queued another");
    await prisma.job.deleteMany({ where: { kind: "LESSON" } });

    // Put right in a later sitting: no longer a weak spot.
    await answer(9, []);
    assert.equal((await weakSpots()).length, 0, "recovered");
    assert.equal(await queueLessons(), 0);

    // Marking never fails because of lessons.
    await setSetting("mode", "manual");
    await answer(2, [{ conceptId: deposit.id, type: "MISSED", text: "Nothing on deposits." }]);
    console.log("lessons check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
