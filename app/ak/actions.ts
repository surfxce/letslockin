"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { cancelJob } from "@/lib/jobs";
import { queueFlashcards, reviewCard } from "@/lib/flashcards/service";
import { deleteCards, importCards, saveCard, saveOcclusionCards } from "@/lib/flashcards/manual";
import { type Rating } from "@/lib/flashcards/schedule";
import { nextCard as nextInScope, type ReviewScope } from "@/lib/flashcards/review";
import { addTags, removeTag, storeTags, tagList } from "@/lib/flashcards/tags";
import { getSettings, setSetting } from "@/lib/settings";
import { activeLocalModel } from "@/lib/models";

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

export async function nextCard(scope: ReviewScope | string, seen: string[] = []) {
  return nextInScope(typeof scope === "string" ? { lectureId: scope } : scope, seen.slice(-500));
}

export async function gradeCard(cardId: string, version: number, rating: Rating, early = false) {
  try {
    const result = await reviewCard(cardId, version, rating, new Date(), early);
    revalidatePath("/ak");
    return result;
  } catch { return { saved: false, reason: "Could not save your review. Please try again." }; }
}

export async function suspendCards(ids: string[], suspended: boolean) {
  const { count } = await prisma.flashcard.updateMany({ where: { id: { in: ids.slice(0, 5000) } }, data: { suspended } });
  revalidatePath("/ak", "layout");
  return { ok: true as const, message: `${suspended ? "Suspended" : "Unsuspended"} ${count} card${count === 1 ? "" : "s"}.` };
}

/** Adds tags to cards, or with `remove`, takes one off. */
export async function tagCards(ids: string[], tags: string, remove = false) {
  const cards = await prisma.flashcard.findMany({ where: { id: { in: ids.slice(0, 5000) } }, select: { id: true, tags: true } });
  const wanted = tagList(storeTags(tags));
  if (!wanted.length) return { ok: false as const, message: "Type a tag first." };
  for (const c of cards) {
    const next = remove ? wanted.reduce((t, w) => removeTag(t, w), c.tags) : addTags(c.tags, wanted);
    if (next !== c.tags) await prisma.flashcard.update({ where: { id: c.id }, data: { tags: next } });
  }
  revalidatePath("/ak", "layout");
  return { ok: true as const, message: `${remove ? "Untagged" : "Tagged"} ${cards.length} card${cards.length === 1 ? "" : "s"}.` };
}

// ---------------------------------------------------------------------------
// Cards made by hand

type Saved = { ok: true; id?: string; message: string } | { ok: false; message: string };

function failed(err: unknown): Saved {
  return { ok: false, message: err instanceof Error ? err.message : "Couldn't save that. Try again." };
}

export async function saveOwnCard(lectureId: string, card: { id?: string; front: string; back: string; tags?: string }): Promise<Saved> {
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
