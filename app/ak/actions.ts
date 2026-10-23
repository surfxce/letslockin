"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { cancelJob } from "@/lib/jobs";
import { queueFlashcards, reviewCard } from "@/lib/flashcards/service";
import { deleteCards, importCards, saveCard, saveOcclusionCards } from "@/lib/flashcards/manual";
import { scheduleCard, intervalLabel, RATINGS, type Rating } from "@/lib/flashcards/schedule";
import { getSettings, setSetting } from "@/lib/settings";
import { activeLocalModel } from "@/lib/models";
import { lectureDecks } from "@/lib/slides";
import { renderMarkdown } from "@/lib/markdown";

export async function setAutoFlashcards(enabled: boolean) {
  if (typeof enabled !== "boolean") throw new Error("Invalid setting.");
  await setSetting("autoFlashcards", enabled);
  revalidatePath("/settings");
}

export async function startDeck(lectureId: string): Promise<{ error?: string }> {
  try {
    const settings = await getSettings();
    if (settings.mode === "manual") return { error: "Choose an AI in Settings to generate decks. Existing cards can still be reviewed offline." };
    if (settings.mode === "local" && !(await activeLocalModel())) return { error: "Download an offline model in Settings first." };
    if (await prisma.flashcard.count({ where: { lectureId, origin: "ai" } })) return { error: "This lecture already has a generated deck." };
    await queueFlashcards(lectureId);
    revalidatePath("/ak", "layout");
    return {};
  } catch (error) { return { error: error instanceof Error ? error.message : "Could not queue the deck." }; }
}

export async function stopDeck(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { kind: true } });
  if (job?.kind !== "FLASHCARDS") return;
  await cancelJob(jobId);
  revalidatePath("/ak", "layout");
}

export async function nextCard(lectureId: string) {
  const now = new Date();
  // Already-seen due cards first, then new cards in creation order.
  const where = { lectureId, dueAt: { lte: now } };
  const card = await prisma.flashcard.findFirst({ where: { ...where, state: { not: "new" } }, orderBy: [{ dueAt: "asc" }, { id: "asc" }] })
    ?? await prisma.flashcard.findFirst({ where: { ...where, state: "new" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const [remaining, upcoming] = await Promise.all([
    prisma.flashcard.count({ where }),
    prisma.flashcard.findFirst({ where: { lectureId, dueAt: { gt: now } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);
  if (!card) return { card: null, remaining, nextDue: upcoming?.dueAt.toISOString() ?? null };
  const decks = await lectureDecks(lectureId);
  const slides = { base: `/api/lectures/${encodeURIComponent(lectureId)}/slides`, ranges: decks.filter(d => d.pdf).map(d => [d.first, d.first + d.pages - 1] as [number, number]) };
  return {
    card: { id: card.id, version: card.version, state: card.state,
      front: renderMarkdown(card.front, slides), back: renderMarkdown(card.back, slides),
      intervals: RATINGS.map(r => intervalLabel(scheduleCard(card, r, now).intervalDays)),
    }, remaining, nextDue: upcoming?.dueAt.toISOString() ?? null,
  };
}

export async function gradeCard(cardId: string, version: number, rating: Rating) {
  try {
    const result = await reviewCard(cardId, version, rating);
    revalidatePath("/ak");
    return result;
  } catch { return { saved: false, reason: "Could not save your review. Please try again." }; }
}

// ---------------------------------------------------------------------------
// Cards made by hand

type Saved = { ok: true; id?: string; message: string } | { ok: false; message: string };

function failed(err: unknown): Saved {
  return { ok: false, message: err instanceof Error ? err.message : "Couldn't save that. Try again." };
}

export async function saveOwnCard(lectureId: string, card: { id?: string; front: string; back: string }): Promise<Saved> {
  try {
    const id = await saveCard(lectureId, card);
    revalidatePath("/ak", "layout");
    return { ok: true, id, message: card.id ? "Card saved." : "Card added." };
  } catch (err) {
    return failed(err);
  }
}

export async function removeCards(lectureId: string, ids: string[]): Promise<Saved> {
  try {
    const n = await deleteCards(lectureId, ids.slice(0, 5000));
    revalidatePath("/ak", "layout");
    return { ok: true, message: `Deleted ${n} card${n === 1 ? "" : "s"}.` };
  } catch (err) {
    return failed(err);
  }
}

/** One batch of imported cards; the browser sends a big file in several. */
export async function importCardBatch(lectureId: string, cards: Array<{ front: string; back: string }>) {
  try {
    const result = await importCards(lectureId, cards);
    revalidatePath("/ak", "layout");
    return { ok: true as const, ...result };
  } catch (err) {
    return { ok: false as const, message: err instanceof Error ? err.message : "Couldn't import those cards." };
  }
}

export async function saveCoverUpCards(lectureId: string, input: { prompt: string; extra: string; cards: Array<{ front: string; back: string }> }): Promise<Saved> {
  try {
    const { added } = await saveOcclusionCards(lectureId, input);
    revalidatePath("/ak", "layout");
    return { ok: true, message: `Added ${added} cover-up card${added === 1 ? "" : "s"}.` };
  } catch (err) {
    return failed(err);
  }
}
