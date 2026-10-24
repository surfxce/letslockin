"use server";

import { revalidatePath } from "next/cache";

import type { Result } from "@/app/actions";
import { cardsFromMistakes, cardsFromWrongMcqs } from "@/lib/flashcards/mistakes";
import { prisma } from "@/lib/db";

function said(queued: number, made: number): Result {
  const total = queued + made;
  if (!total) return { ok: true, message: "These mistakes are already in AK." };
  const cards = `${total} card${total === 1 ? "" : "s"}`;
  return {
    ok: true,
    message: queued ? `Writing ${cards} — they'll be in AK in a minute.` : `Added ${cards} to AK.`,
  };
}

/** The mistakes in a sitting's marked answers, as AK cards. */
export async function makeSittingCards(attemptId: string): Promise<Result> {
  const responses = await prisma.response.findMany({ where: { attemptId, mark: { not: null } }, select: { id: true } });
  const { queued, made } = await cardsFromMistakes(responses.map((r) => r.id));
  revalidatePath("/", "layout");
  return said(queued, made);
}

/** An exam's wrong multiple choice and the mistakes in its marked long answers, as AK cards. */
export async function makeExamCards(examId: string): Promise<Result> {
  const items = await prisma.examItem.findMany({ where: { examId, kind: "LAQ", responseId: { not: null } }, select: { responseId: true } });
  const mcqs = await cardsFromWrongMcqs(examId);
  const { queued, made } = await cardsFromMistakes(items.map((i) => i.responseId!));
  revalidatePath("/", "layout");
  return said(queued, made + mcqs);
}
