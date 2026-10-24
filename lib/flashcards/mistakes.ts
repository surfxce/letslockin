import { z } from "zod";

import { prisma } from "@/lib/db";
import { cardText } from "@/lib/flashcards/schema";
import type { LlmProvider } from "@/lib/llm/provider";
import { LETTERS } from "@/lib/exam/pick";
import { readOptions } from "@/lib/mcq/service";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

/** Cards made from mistakes are kept apart from a lecture's generated deck. */
export const MISTAKE_ORIGIN = "mistake";

export const MistakeCardsSchema = z.object({
  cards: z
    .array(z.object({ key: z.string().min(1).max(20), front: z.string().trim().min(1).max(2000), back: z.string().trim().min(1).max(3000) }))
    .min(1)
    .max(80),
});
export type MistakeCards = z.infer<typeof MistakeCardsSchema>;

export interface MistakeInput {
  lectureTitle: string;
  mistakes: Array<{ key: string; kind: "missed" | "wrong"; concept: string; text: string; question: string }>;
}

export function mistakeVars(input: MistakeInput): Record<string, string> {
  return {
    lectureTitle: input.lectureTitle,
    mistakes: input.mistakes
      .map((m) => `- ${m.key} · ${m.kind} · ${m.concept} :: ${m.text} (${m.question.replace(/\s+/g, " ").slice(0, 200)})`)
      .join("\n"),
  };
}

const gapKey = (gapId: string) => `gap:${gapId}`;
const mcqKey = (mcqId: string) => `mcq:${mcqId}`;

/** The mistakes in some marked answers that aren't cards yet. */
async function openGaps(responseIds: string[]) {
  const gaps = await prisma.gap.findMany({
    where: { responseId: { in: responseIds } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      text: true,
      concept: { select: { name: true } },
      response: { select: { question: { select: { stem: true, lectureId: true } } } },
    },
  });
  if (!gaps.length) return [];
  const made = new Set(
    (await prisma.flashcard.findMany({ where: { sourceKey: { in: gaps.map((g) => gapKey(g.id)) } }, select: { sourceKey: true } })).map(
      (c) => c.sourceKey,
    ),
  );
  return gaps.filter((g) => !made.has(gapKey(g.id)));
}

/** How many of these answers' mistakes could still become cards. */
export async function mistakesLeft(responseIds: string[]): Promise<number> {
  return (await openGaps(responseIds)).length;
}

/**
 * Turns the mistakes in some marked answers into AK cards, in each lecture's deck. With
 * an AI they are written as proper questions, in the background; without one, each
 * mistake becomes a card as it stands.
 */
export async function cardsFromMistakes(responseIds: string[]): Promise<{ queued: number; made: number }> {
  const gaps = await openGaps(responseIds);
  if (!gaps.length) return { queued: 0, made: 0 };
  const byLecture = new Map<string, string[]>();
  for (const g of gaps) {
    const lectureId = g.response.question.lectureId;
    byLecture.set(lectureId, [...(byLecture.get(lectureId) ?? []), g.id]);
  }
  if (usesAi((await getSettings()).mode)) {
    for (const [lectureId, gapIds] of byLecture) {
      // In AK's lane, beside generated decks; the payload's gapIds tell the two apart.
      await prisma.job.create({ data: { lectureId, kind: "FLASHCARDS", payload: JSON.stringify({ lectureId, gapIds }) } });
    }
    return { queued: gaps.length, made: 0 };
  }
  const start = Date.now();
  await prisma.flashcard.createMany({
    data: gaps.map((g, i) => ({
      lectureId: g.response.question.lectureId,
      origin: MISTAKE_ORIGIN,
      sourceKey: gapKey(g.id),
      createdAt: new Date(start + i),
      front: `**${g.concept.name}** — ${g.type === "WRONG" ? "what's the correct fact?" : "what's the key point?"}\n\n*From:* ${g.response.question.stem.replace(/\s+/g, " ").slice(0, 300)}`,
      back: g.text,
    })),
  });
  return { queued: 0, made: gaps.length };
}

/** The worker's half: writes the cards for one lecture's mistakes. */
export async function writeMistakeCards(lectureId: string, gapIds: string[], provider: LlmProvider) {
  const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id: lectureId }, select: { title: true } });
  const gaps = (await openGaps(await responsesOf(gapIds))).filter((g) => gapIds.includes(g.id));
  if (!gaps.length) return { generated: 0, note: "these mistakes are already cards" };
  const keys = new Map(gaps.map((g, i) => [`g${i + 1}`, g]));
  const { cards } = MistakeCardsSchema.parse(
    await provider.writeMistakeCards({
      lectureTitle: lecture.title,
      mistakes: [...keys].map(([key, g]) => ({
        key,
        kind: g.type === "WRONG" ? "wrong" : "missed",
        concept: g.concept.name,
        text: g.text,
        question: g.response.question.stem,
      })),
    }),
  );
  const start = Date.now();
  const data = cards.flatMap((c, i) => {
    const gap = keys.get(c.key);
    const front = cardText(c.front);
    const back = cardText(c.back);
    if (!gap || !front || !back) return [];
    keys.delete(c.key); // one card per mistake
    return [{ lectureId, origin: MISTAKE_ORIGIN, sourceKey: gapKey(gap.id), front, back, createdAt: new Date(start + i), model: provider.lastModel, promptVersion: provider.lastPromptVersion }];
  });
  // Saved one by one: a card made meanwhile (a second click) is skipped, not an error.
  let generated = 0;
  for (const card of data) {
    const exists = await prisma.flashcard.findUnique({ where: { lectureId_sourceKey: { lectureId, sourceKey: card.sourceKey } }, select: { id: true } });
    if (exists) continue;
    await prisma.flashcard.create({ data: card });
    generated++;
  }
  return { generated };
}

async function responsesOf(gapIds: string[]) {
  return (await prisma.gap.findMany({ where: { id: { in: gapIds } }, select: { responseId: true } })).map((g) => g.responseId);
}

/** Wrong or skipped multiple choice from an exam, as cards: the question and its options, then the answer. */
export async function cardsFromWrongMcqs(examId: string): Promise<number> {
  const items = await prisma.examItem.findMany({
    where: { examId, kind: "MCQ", exam: { submittedAt: { not: null } } },
    select: { choice: true, mcq: { select: { id: true, lectureId: true, stem: true, options: true, answer: true, explanation: true } } },
  });
  const wrong = items.filter((i) => i.mcq && i.choice !== i.mcq.answer).map((i) => i.mcq!);
  if (!wrong.length) return 0;
  const made = new Set(
    (await prisma.flashcard.findMany({ where: { sourceKey: { in: wrong.map((m) => mcqKey(m.id)) } }, select: { sourceKey: true } })).map((c) => c.sourceKey),
  );
  const start = Date.now();
  const data = wrong
    .filter((m) => !made.has(mcqKey(m.id)))
    .flatMap((m, i) => {
      const options = readOptions(m.options);
      if (options.length <= m.answer) return [];
      return [
        {
          lectureId: m.lectureId,
          origin: MISTAKE_ORIGIN,
          sourceKey: mcqKey(m.id),
          createdAt: new Date(start + i),
          front: `${m.stem}\n\n${options.map((o, n) => `${LETTERS[n]}. ${o}`).join("  \n")}`,
          back: `**${LETTERS[m.answer]}. ${options[m.answer]}**\n\n${m.explanation}`,
        },
      ];
    });
  await prisma.flashcard.createMany({ data });
  return data.length;
}

/** Wrong MCQs of an exam not yet cards. */
export async function wrongMcqsLeft(examId: string): Promise<number> {
  const items = await prisma.examItem.findMany({
    where: { examId, kind: "MCQ", exam: { submittedAt: { not: null } } },
    select: { choice: true, mcq: { select: { id: true, answer: true } } },
  });
  const wrong = items.filter((i) => i.mcq && i.choice !== i.mcq.answer).map((i) => mcqKey(i.mcq!.id));
  if (!wrong.length) return 0;
  return wrong.length - (await prisma.flashcard.count({ where: { sourceKey: { in: wrong } } }));
}
