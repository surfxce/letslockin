import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { LlmProvider } from "@/lib/llm/provider";
import { throwIfCancelled } from "@/lib/llm/cancel";
import { lectureDecks } from "@/lib/slides";
import { lectureSources, readSlideNotes, slideNotesText } from "@/lib/sources";
import { FlashcardSetSchema, cardText } from "@/lib/flashcards/schema";
import { RATINGS, scheduleCard, type Rating } from "@/lib/flashcards/schedule";

/** One deck per lecture. Repeated clicks and retries never reset existing learning. */
export async function queueFlashcards(lectureId: string) {
  return prisma.$transaction(async tx => {
    const lecture = await tx.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { id: true } });
    const existing = await tx.job.findFirst({ where: { lectureId, kind: "FLASHCARDS", status: { in: ["PENDING", "RUNNING"] } } });
    if (existing) return existing;
    return tx.job.create({ data: { lectureId: lecture.id, kind: "FLASHCARDS", payload: JSON.stringify({ lectureId }) } });
  });
}

export async function generateFlashcards(lectureId: string, jobId: string, provider: LlmProvider) {
  // A crash after saving but before marking the job DONE is safe to retry.
  if (await prisma.flashcard.count({ where: { lectureId } })) return { generated: 0, note: "Deck already exists" };
  const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, include: { materials: true } });
  const decks = await lectureDecks(lectureId);
  const slideNumbers = decks.filter(d => d.pdf).flatMap(d => Array.from({ length: d.pages }, (_, i) => d.first + i));
  const notes = slideNotesText(readSlideNotes(lecture.slideNotes));
  let source: string;
  if (lecture.summaryMd?.trim()) {
    source = [lecture.summaryMd, notes].filter(Boolean).join("\n\n");
  } else {
    // Standalone AK generation also works before summary preparation, including
    // scanned slides. OCR is cached by the existing slide pipeline.
    const { readSlidePictures } = await import("@/lib/ocr");
    await readSlidePictures(lectureId);
    const materials = await prisma.material.findMany({ where: { lectureId } });
    if (!materials.some(m => m.extractedText?.trim()) && !notes.trim()) {
      throw new Error("No readable lecture content yet. Prepare the lecture or add a transcript first.");
    }
    const sources = lectureSources(materials);
    source = [sources.transcript, notes || sources.slidesText].filter(Boolean).join("\n\n");
  }
  if (!source.trim()) throw new Error("This lecture has no readable material. Add a transcript or prepare its summary first.");
  const result = FlashcardSetSchema.parse(await provider.generateFlashcards({ lectureTitle: lecture.title, source, slideNumbers }));
  throwIfCancelled();
  const allowed = new Set(slideNumbers);
  const side = (s: typeof result.cards[number]["front"]) => {
    if (s.slide !== null && !allowed.has(s.slide)) throw new Error(`The AI cited slide ${s.slide}, which is not in this lecture.`);
    const text = cardText(s.text);
    if (!text) throw new Error("The AI returned an empty card.");
    return text + (s.slide ? `\n\n![Lecture diagram](slide:${s.slide})` : "");
  };
  const seen = new Set<string>();
  const cards = result.cards.flatMap(card => {
    const front = side(card.front), back = side(card.back);
    const sourceKey = createHash("sha256").update(front.toLowerCase().replace(/\s+/g, " ")).digest("hex");
    if (seen.has(sourceKey)) return [];
    seen.add(sourceKey);
    return [{ lectureId, front, back, sourceKey, model: provider.lastModel, promptVersion: provider.lastPromptVersion }];
  });
  return prisma.$transaction(async tx => {
    // A cancelled/deleted job cannot publish a late answer even before the poll notices.
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (job?.status !== "RUNNING") throw new Error("Flashcard generation was cancelled.");
    if (await tx.flashcard.count({ where: { lectureId } })) return { generated: 0 };
    await tx.flashcard.createMany({ data: cards });
    return { generated: cards.length };
  });
}

export async function reviewCard(cardId: string, version: number, rating: Rating, now = new Date()) {
  if (!RATINGS.includes(rating) || !Number.isInteger(version) || version < 0) throw new Error("Invalid review.");
  return prisma.$transaction(async tx => {
    const card = await tx.flashcard.findUniqueOrThrow({ where: { id: cardId } });
    if (card.version !== version) return { saved: false, reason: "This card was already reviewed. Your progress is safe." };
    if (card.dueAt > now) return { saved: false, reason: "This card is not due yet." };
    const next = scheduleCard(card, rating, now);
    const updated = await tx.flashcard.updateMany({ where: { id: cardId, version }, data: { ...next, version: { increment: 1 } } });
    if (!updated.count) return { saved: false, reason: "This card was already reviewed." };
    await tx.flashcardReview.create({ data: { cardId, version, rating, reviewedAt: now, dueAt: next.dueAt } });
    return { saved: true, reason: null };
  });
}
