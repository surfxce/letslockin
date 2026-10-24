"use server";

import { revalidatePath } from "next/cache";

import type { Result } from "@/app/actions";
import { finishLesson, lessonCards, requestLesson } from "@/lib/lessons/service";

export async function markLessonDone(lessonId: string) {
  await finishLesson(lessonId);
  revalidatePath("/", "layout");
}

export async function cardsFromLesson(lessonId: string): Promise<Result> {
  try {
    const added = await lessonCards(lessonId);
    revalidatePath("/ak");
    return { ok: true, message: added ? `${added} card${added === 1 ? "" : "s"} added to the lecture's AK deck.` : "They're in the deck already." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function askForLesson(conceptId: string): Promise<Result> {
  try {
    const queued = await requestLesson(conceptId);
    revalidatePath("/lessons");
    return { ok: true, message: queued ? "Writing it — it'll be here in a minute or two." : "It's being written already." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
