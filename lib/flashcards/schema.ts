import { z } from "zod";

// Images are structured references, never arbitrary URLs or HTML supplied by a model.
const side = z.object({
  text: z.string().trim().min(1).max(4000),
  slide: z.number().int().positive().nullable(),
});
export const FlashcardSetSchema = z.object({ cards: z.array(z.object({ front: side, back: side })).min(1).max(60) });
export type FlashcardSet = z.infer<typeof FlashcardSetSchema>;
export interface FlashcardsInput {
  lectureTitle: string;
  source: string;
  slideNumbers: number[];
}
export function flashcardVars(input: FlashcardsInput) {
  return { lectureTitle: input.lectureTitle, source: input.source, slideNumbers: input.slideNumbers.join(", ") || "none" };
}
/** Plain text/Markdown only; no embedded HTML or model-invented image sources. */
export function cardText(text: string) {
  return text.replace(/<[^>]*>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g, "").replaceAll("<", "&lt;").replaceAll(">", "&gt;").trim();
}
