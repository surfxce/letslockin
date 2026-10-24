/** Isolated check of mistakes→cards, AK scopes and Anki import, Today, Progress and past papers. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-study-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { FakeProvider } = await import("../lib/llm/fake");
  const { setSetting } = await import("../lib/settings");
  const { cardsFromMistakes, writeMistakeCards, mistakesLeft, cardsFromWrongMcqs } = await import("../lib/flashcards/mistakes");
  const { nextCard, scopeCounts, tagCounts } = await import("../lib/flashcards/review");
  const { reviewCard } = await import("../lib/flashcards/service");
  const { importAnki } = await import("../lib/flashcards/manual");
  const { todayPlan } = await import("../lib/today");
  const { progressData } = await import("../lib/progress/data");
  const { addPaper, splitPaper, createPaperExam, paperRows, deletePaper } = await import("../lib/papers/service");
  const { pickQuestions } = await import("../lib/engines/attempt");
  const { createExam, submitExam } = await import("../lib/exam/service");
  const provider = new FakeProvider(0);
  try {
    await applyMigrations();
    await setSetting("mode", "manual");
    const course = await prisma.course.create({ data: { code: "STUDY1", title: "Study fixture", examDate: new Date(Date.now() + 10 * 86_400_000) } });
    const make = async (title: string, summary: string, conceptNames: string[]) => {
      const lecture = await prisma.lecture.create({ data: { courseId: course.id, title, deliveredOn: new Date(), summaryMd: summary } });
      const concepts = [];
      for (const name of conceptNames) concepts.push(await prisma.concept.create({ data: { courseId: course.id, lectureId: lecture.id, name, definition: `about ${name}` } }));
      const question = await prisma.question.create({
        data: {
          lectureId: lecture.id,
          stem: `Explain ${title}.`,
          type: "LAQ",
          rubric: JSON.stringify({ modelAnswer: "…", criteria: [{ point: "Core", marks: 10 }], totalMarks: 10 }),
          promptVersion: "test",
          concepts: { create: concepts.map((c) => ({ conceptId: c.id })) },
        },
      });
      return { lecture, concepts, question };
    };
    const iga = await make("IgA nephropathy", "IgA1 immune complexes deposit in the mesangium, with haematuria after infection.", ["mesangial deposits"]);
    const hsp = await make("Henoch-Schonlein purpura", "IgA1 immune complexes deposit in the mesangium and in skin vessels: purpura.", ["purpura"]);
    const drugs = await make("Cholinergic drugs", "Muscarinic agonists and acetylcholinesterase inhibitors.", ["muscarinic agonists"]);

    // A marked sitting with two mistakes.
    const attempt = await prisma.attempt.create({ data: { lectureId: iga.lecture.id, geometricMean: 4, completedAt: new Date() } });
    const response = await prisma.response.create({ data: { attemptId: attempt.id, questionId: iga.question.id, answerText: "Something.", mark: 4, markedAt: new Date() } });
    await prisma.gap.createMany({
      data: [
        { responseId: response.id, conceptId: iga.concepts[0].id, type: "MISSED", text: "Gd-IgA1 complexes deposit in the mesangium." },
        { responseId: response.id, conceptId: iga.concepts[0].id, type: "WRONG", text: "It is IgA, not IgG, that deposits." },
      ],
    });
    assert.equal(await mistakesLeft([response.id]), 2);
    // Without an AI, each mistake becomes a card as it stands.
    assert.deepEqual(await cardsFromMistakes([response.id]), { queued: 0, made: 2 });
    assert.equal(await mistakesLeft([response.id]), 0, "never carded twice");
    assert.deepEqual(await cardsFromMistakes([response.id]), { queued: 0, made: 0 });
    // With one, they're queued in AK's lane and written by the worker.
    await prisma.flashcard.deleteMany({ where: { origin: "mistake" } });
    await setSetting("mode", "auto");
    assert.deepEqual(await cardsFromMistakes([response.id]), { queued: 2, made: 0 });
    const job = await prisma.job.findFirstOrThrow({ where: { kind: "FLASHCARDS" } });
    const payload = JSON.parse(job.payload);
    assert.equal((await writeMistakeCards(payload.lectureId, payload.gapIds, provider)).generated, 2);
    assert.equal((await writeMistakeCards(payload.lectureId, payload.gapIds, provider)).generated, 0);
    const mistakeCard = await prisma.flashcard.findFirstOrThrow({ where: { origin: "mistake" } });
    assert.match(mistakeCard.front, /mesangial deposits/);

    // Wrong exam MCQs become cards with the options on the front.
    await prisma.mcq.create({ data: { lectureId: iga.lecture.id, stem: "Which deposits?", options: JSON.stringify(["IgG", "IgA", "IgM", "IgE", "C3"]), answer: 1, explanation: "IgA1.", promptVersion: "t" } });
    const examId = await createExam({ lectureIds: [iga.lecture.id], mcqs: 1, laqs: 0, timeLimitMin: null, focus: "mixed" });
    const examItem = await prisma.examItem.findFirstOrThrow({ where: { examId } });
    await submitExam(examId, { choices: new Map([[examItem.id, 0]]), texts: new Map() });
    assert.equal(await cardsFromWrongMcqs(examId), 1);
    assert.equal(await cardsFromWrongMcqs(examId), 0);
    const mcqCard = await prisma.flashcard.findFirstOrThrow({ where: { sourceKey: { startsWith: "mcq:" } } });
    assert.match(mcqCard.front, /A\. IgG/);
    assert.match(mcqCard.back, /\*\*B\. IgA\*\*/);

    // Review across decks, by tag, hard cards, and suspended cards left out.
    await prisma.flashcard.create({ data: { lectureId: drugs.lecture.id, front: "Atropine?", back: "Antagonist.", sourceKey: "k-drug", tags: " pharm ", dueAt: new Date(0) } });
    const hard = await prisma.flashcard.create({
      data: { lectureId: hsp.lecture.id, front: "Purpura?", back: "Vasculitis.", sourceKey: "k-hard", state: "review", lapses: 5, ease: 1.6, intervalDays: 3, dueAt: new Date(Date.now() + 5 * 86_400_000) },
    });
    const all = await nextCard({});
    assert.ok(all.card && all.remaining >= 4, "every deck's due cards");
    assert.equal((await nextCard({ tag: "pharm" })).card?.front.includes("Atropine"), true);
    const hardSession = await nextCard({ hard: true });
    assert.equal(hardSession.card?.id, hard.id, "a hard card comes up even before it's due");
    assert.equal(hardSession.card?.problem, true);
    assert.equal((await reviewCard(hard.id, 0, 3)).saved, false, "not early outside a hard session");
    assert.equal((await reviewCard(hard.id, 0, 3, new Date(), true)).saved, true);
    assert.equal((await nextCard({ hard: true }, [hard.id])).card, null, "each once per session");
    const counts = await scopeCounts({});
    assert.equal(counts.problems, 1);
    await prisma.flashcard.update({ where: { id: mistakeCard.id }, data: { suspended: true } });
    assert.ok((await nextCard({ lectureId: iga.lecture.id }, [])).card?.id !== mistakeCard.id, "suspended cards stay out");
    assert.deepEqual(await tagCounts(), [{ tag: "pharm", count: 1 }]);

    // An Anki package: new cards with tags, pictures saved once, re-imports skipped.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const pkg = {
      cards: [
        { key: "n1", front: "Label it\n\n![Picture](anki-media:a%20b.png)", back: "Glomerulus", tags: ["renal"], deck: "Renal Deck" },
        { key: "n2", front: "Again\n\n![Picture](anki-media:a%20b.png)", back: "Same picture", tags: [], deck: "Renal Deck" },
        { key: "n3", front: "Missing picture\n\n![Picture](anki-media:gone.png)", back: "Still a card", tags: [], deck: "Renal Deck" },
      ],
      decks: [{ name: "Renal Deck", cards: 3 }],
      skipped: 1,
      media: async (name: string) => (name === "a b.png" ? png : null),
    };
    const imported = await importAnki(iga.lecture.id, pkg);
    assert.equal(imported.added, 3);
    assert.equal(imported.pictures, 1, "one file for two cards");
    const ankiCard = await prisma.flashcard.findFirstOrThrow({ where: { sourceKey: "anki:n1" } });
    assert.match(ankiCard.front, /\/api\/ak\/images\/[a-f0-9]{24}\.png/);
    assert.equal(ankiCard.tags, " renal Renal_Deck ");
    assert.equal((await prisma.flashcard.findFirstOrThrow({ where: { sourceKey: "anki:n3" } })).front, "Missing picture");
    assert.equal((await importAnki(iga.lecture.id, pkg)).added, 0, "re-importing adds nothing");

    // Today: the overdue lecture, due cards, the exam.
    await prisma.attempt.update({ where: { id: attempt.id }, data: { completedAt: new Date(Date.now() - 20 * 86_400_000), sittingDate: new Date(Date.now() - 20 * 86_400_000) } });
    await prisma.flashcard.updateMany({ where: { sourceKey: "k-drug" }, data: { state: "review", intervalDays: 2 } });
    const plan = await todayPlan();
    assert.ok(plan.items.some((i) => i.kind === "cards" && i.title === "Review 1 AK card"), "due cards are in the plan");
    assert.ok([...plan.items, ...plan.later].some((i) => i.kind === "new-cards"), "and new ones");
    assert.ok([...plan.items, ...plan.later].some((i) => i.id === `laq:${iga.lecture.id}` || i.id === `weak:${iga.lecture.id}`), "the weak lecture is in the plan");
    assert.equal(plan.exams[0]?.days, 10);

    // Progress: readiness, concepts, and how lectures relate.
    const progress = await progressData(course.id);
    assert.equal(progress.courses[0].lectures, 3);
    assert.equal(progress.courses[0].drilled, 1);
    assert.equal(Math.round(progress.courses[0].predicted!), 13, "4/10 on one of three lectures");
    assert.equal(progress.heat.find((r) => r.lectureId === iga.lecture.id)?.cells[0].mastery, 4);
    const link = progress.map.links[0];
    assert.deepEqual([link.a, link.b].sort(), [iga.lecture.id, hsp.lecture.id].sort(), "the two IgA lectures are closest");
    assert.ok(link.shared.includes("mesangium"));
    assert.ok(progress.stats.streak >= 1);

    // A past paper: split, filed under lectures, given guides, sat as an exam, kept out of sittings.
    await assert.rejects(addPaper(course.id, new File([""], "empty.txt")), /No text/);
    const paperId = await addPaper(
      course.id,
      new File(["STUDY1 Final 2024\n1. Explain the mesangial deposits in IgA nephropathy. (10 marks)\n2a) Describe purpura and its cause. (5 marks)\n3. What do muscarinic agonists do? (5 marks)\n"], "STUDY1 2024 final.txt"),
    );
    assert.equal((await prisma.pastPaper.findUniqueOrThrow({ where: { id: paperId } })).year, 2024);
    assert.equal(await prisma.job.count({ where: { kind: "PAPER" } }), 1);
    const split = await splitPaper(paperId, provider);
    assert.deepEqual(split, { items: 3, questions: 3, unplaced: 0 });
    const paperQs = await prisma.question.findMany({ where: { paperItemId: { not: null } }, include: { concepts: true } });
    assert.equal(paperQs.find((q) => q.stem.startsWith("Explain the mesangial"))?.lectureId, iga.lecture.id);
    assert.equal(paperQs.find((q) => q.stem.startsWith("Describe purpura"))?.lectureId, hsp.lecture.id);
    assert.equal(JSON.parse(paperQs[0].rubric).criteria.reduce((n: number, c: { marks: number }) => n + c.marks, 0), 10);
    assert.ok(!(await pickQuestions(iga.lecture.id)).some((id) => paperQs.some((q) => q.id === id)), "paper questions stay out of sittings");
    const rows = await paperRows();
    assert.equal(rows[0].questions, 3);
    assert.equal(rows[0].marks, 20);
    const paperExam = await createPaperExam(paperId, 60);
    const items = await prisma.examItem.findMany({ where: { examId: paperExam }, orderBy: { position: "asc" }, include: { question: true } });
    assert.deepEqual(items.map((i) => i.question?.stem.slice(0, 8)), ["Explain ", "Describe", "What do "]);
    await submitExam(paperExam, { choices: new Map(), texts: new Map([[items[0].id, "Gd-IgA1 complexes."]]) });
    assert.equal((await paperRows())[0].sat, 1);
    await deletePaper(paperId);
    assert.equal(await prisma.pastPaper.count(), 0);
    assert.equal(await prisma.question.count({ where: { paperItemId: { not: null } } }), 3, "questions handed in (even blank) stay with their sittings");
    console.log("study check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
