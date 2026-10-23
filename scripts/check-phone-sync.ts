/** Isolated phone-sync integration check. Never opens the user's database or calls a real AI. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely read replies, checked by asserts
type Json = Record<string, any>;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "lockin-phone-check-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "lockin.db")}`;
  process.env.LOCKIN_DATA_DIR = dir;
  process.env.LOCKIN_PROVIDER = "fake";
  const { prisma } = await import("../lib/db");
  const { applyMigrations } = await import("../lib/migrate");
  const { createPairing, findPairing, removePairing, setPhoneMayMarkWithKey, pairingLink } = await import("../lib/phone/pairing");
  const { seal, open, requestAad, replyAad, fromBase64Url } = await import("../lib/phone/crypto");
  const { openRequest } = await import("../lib/phone/protocol");
  const { handleHello, handleSync, handleSlide } = await import("../lib/phone/handlers");
  const { PhoneSnapshotSchema } = await import("../lib/phone/schema");
  const { phoneMarkingTemplate } = await import("../lib/phone/marking");
  const { setSetting, setApiKey } = await import("../lib/settings");
  try {
    await applyMigrations();
    const course = await prisma.course.create({ data: { code: "PHONE1", title: "Phone fixture" } });
    const lecture = await prisma.lecture.create({
      data: {
        courseId: course.id,
        title: "IgA nephropathy",
        deliveredOn: new Date("2026-10-01"),
        summaryMd: "## Mechanism\n\nGd-IgA1 forms complexes.\n\n![Deposits](slide:2#crop=2:0.1,0.2,0.5,0.4)\n",
      },
    });
    await prisma.material.create({
      data: { lectureId: lecture.id, kind: "SLIDES", path: "deck.pdf", originalName: "deck.pdf", checksum: "phone", pageCount: 3 },
    });
    const concept = await prisma.concept.create({
      data: { courseId: course.id, lectureId: lecture.id, name: "Gd-IgA1", definition: "galactose-deficient IgA1" },
    });
    const rubric = { modelAnswer: "Gd-IgA1 …", criteria: [{ point: "Names Gd-IgA1", marks: 10 }], totalMarks: 10 };
    const question = await prisma.question.create({
      data: {
        lectureId: lecture.id,
        stem: "Explain IgA nephropathy.",
        type: "LAQ",
        rubric: JSON.stringify(rubric),
        promptVersion: "generate-questions@1.3.0",
        concepts: { create: [{ conceptId: concept.id }] },
      },
    });
    const card = await prisma.flashcard.create({
      data: { lectureId: lecture.id, front: "What is deficient?\n\n![Lecture diagram](slide:3)", back: "Galactose.", sourceKey: "k1", dueAt: new Date(Date.now() - 60_000) },
    });

    // Pairing and the sealed request.
    const pairing = await createPairing();
    assert.match(pairingLink(pairing, ["192.168.1.20", "Mac.local"], 47821), /^lockin:\/\/pair\?d=/);
    const key = fromBase64Url(pairing.key);
    const request = (op: "hello" | "sync" | "slide", body: unknown, t = Date.now(), r = randomBytes(8).toString("hex")) => ({
      r,
      sealed: seal(key, Buffer.from(JSON.stringify({ t, r, body })), requestAad(op, pairing.id)),
    });

    const hello = request("hello", { device: { name: "Test iPhone", app: "1.0" } });
    const opened = await openRequest("hello", pairing.id, hello.sealed);
    assert.ok(opened.ok);
    await handleHello(opened.pairing, opened.body);
    assert.equal((await findPairing(pairing.id))?.deviceName, "Test iPhone");
    assert.equal((await openRequest("hello", pairing.id, hello.sealed)).ok, false, "a replayed request is refused");
    const stale = await openRequest("hello", pairing.id, request("hello", {}, Date.now() - 3_600_000).sealed);
    assert.ok(!stale.ok && stale.status === 400, "a request from an hour ago is refused");
    assert.equal((await openRequest("sync", pairing.id, request("hello", {}).sealed)).ok, false, "a hello can't be used as a sync");
    assert.equal((await openRequest("hello", "someone-else", request("hello", {}).sealed)).ok, false);

    // A sitting from the phone: one answer marked there, one blank, one for the computer.
    const sittingId = "phone-sitting-0001";
    const sync = {
      device: { name: "Test iPhone", app: "1.0" },
      sittings: [
        {
          id: sittingId,
          lectureId: lecture.id,
          startedAt: new Date(Date.now() - 600_000).toISOString(),
          submittedAt: new Date().toISOString(),
          responses: [
            {
              id: "phone-response-0001",
              questionId: question.id,
              answerText: "Gd-IgA1 is bound by autoantibodies.",
              marking: {
                mark: 7,
                criteria: [{ point: "Names Gd-IgA1", awarded: 7, outOf: 10, note: null }],
                gaps: [
                  { conceptId: concept.id, type: "MISSED", text: "Complexes deposit in the mesangium." },
                  { conceptId: "not-this-question", type: "WRONG", text: "Dropped." },
                ],
              },
            },
            { id: "phone-response-0002", questionId: question.id, answerText: "   " },
            { id: "phone-response-0003", questionId: question.id, answerText: "Unmarked answer.", marking: { mark: 99 } },
            { id: "phone-response-0004", questionId: "a-question-gone", answerText: "Ignored." },
          ],
        },
      ],
      reviews: [{ id: "phone-review-0001", cardId: card.id, version: 0, rating: 3, reviewedAt: new Date().toISOString() }],
    };
    const first = (await handleSync(pairing, sync)) as { kind: "json"; value: Json };
    assert.equal(first.value.ok, true);
    assert.deepEqual(first.value.accepted.sittings, [sittingId]);
    assert.deepEqual(first.value.accepted.reviews, ["phone-review-0001"]);
    const responses = await prisma.response.findMany({ where: { attemptId: sittingId }, orderBy: { id: "asc" }, include: { gaps: true } });
    assert.equal(responses.length, 3, "the answer to a deleted question is left out");
    assert.equal(responses[0].mark, 7);
    assert.deepEqual(responses[0].gaps.map((g) => g.text), ["Complexes deposit in the mesangium."]);
    assert.equal(responses[1].mark, 0, "a blank answer scores 0");
    assert.equal(responses[2].mark, null, "an invalid phone mark is left for the computer");
    const jobs = await prisma.job.findMany({ where: { kind: "MARK" } });
    assert.equal(jobs.length, 1);
    assert.equal(JSON.parse(jobs[0].payload).responseId, "phone-response-0003");
    const reviewed = await prisma.flashcard.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(reviewed.version, 1);
    assert.equal(reviewed.state, "review");

    const snapshot = PhoneSnapshotSchema.parse(first.value.snapshot);
    const phoneLecture = snapshot.lectures.find((l) => l.id === lecture.id)!;
    assert.ok(phoneLecture.summaryHtml?.includes(`lockin-slide://${lecture.id}/2?crop=0.1,0.2,0.5,0.4`));
    assert.deepEqual(phoneLecture.images.sort(), ["2?crop=0.1,0.2,0.5,0.4", "3"]);
    assert.deepEqual(phoneLecture.nextSitting, [question.id]);
    assert.match(phoneLecture.questions[0].markVars.concepts, new RegExp(concept.id));
    const sitting = snapshot.sittings.find((s) => s.id === sittingId)!;
    assert.equal(sitting.responses.find((r) => r.id === "phone-response-0003")?.pending, true);
    assert.ok(sitting.responses.find((r) => r.id === "phone-response-0001")?.feedback.some((f) => f.kind === "missed"));
    assert.equal(snapshot.cards[0].version, 1);
    assert.equal(snapshot.marking, null, "Claude Code can't run on a phone");

    // The same sync again — a reply lost on the way — changes nothing.
    const again = (await handleSync(pairing, sync)) as { kind: "json"; value: Json };
    assert.deepEqual(again.value.accepted.sittings, [sittingId]);
    assert.equal(await prisma.response.count(), 3);
    assert.equal(await prisma.job.count({ where: { kind: "MARK" } }), 1);
    assert.equal(await prisma.flashcardReview.count(), 1);
    assert.equal((await prisma.flashcard.findUniqueOrThrow({ where: { id: card.id } })).version, 1);

    // Pictures: only refs that look like slides.
    const bad = (await handleSlide(pairing, { lectureId: lecture.id, ref: "../etc/passwd" })) as { kind: "json"; value: Json };
    assert.equal(bad.value.ok, false);

    // Marking on the phone: with an API key only, and only while allowed.
    await setSetting("cloudEngine", "api");
    await setSetting("apiService", "anthropic");
    assert.equal(await phoneMarkingTemplate(), null, "no key, no marking on the phone");
    await setApiKey("sk-ant-test");
    const template = await phoneMarkingTemplate();
    assert.equal(template?.kind, "anthropic");
    assert.equal(template?.request.headers["x-api-key"], "sk-ant-test");
    assert.ok(template?.prompt.includes("{{answerText}}"));
    assert.ok(JSON.stringify(template?.request.body).includes("{{LOCKIN_PROMPT}}"));
    await setPhoneMayMarkWithKey(false);
    assert.equal(await phoneMarkingTemplate(), null);
    await setPhoneMayMarkWithKey(true);
    await setSetting("apiService", "custom");
    await setSetting("apiBaseUrl", "http://localhost:11434/v1");
    await setSetting("apiModel", "llama");
    assert.equal(await phoneMarkingTemplate(), null, "a service on this computer can't be reached from the phone");
    await setSetting("apiBaseUrl", "https://llm.example.com/v1/");
    assert.equal((await phoneMarkingTemplate())?.request.url, "https://llm.example.com/v1/chat/completions");

    // A reply sealed for one request can't be read as another's.
    const sealedReply = seal(key, Buffer.from("{}"), replyAad("sync", "request-a"));
    assert.equal(open(key, sealedReply, replyAad("sync", "request-b")), null);

    // Unpaired: the key no longer works.
    await removePairing(pairing.id);
    assert.equal((await openRequest("hello", pairing.id, request("hello", {}).sealed)).ok, false);
    console.log("phone sync check passed");
  } finally {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
