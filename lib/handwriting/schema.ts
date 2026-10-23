import { z } from "zod";

/** A handwritten answer as the model typed it out. */
export const HandwritingSchema = z.object({
  text: z.string().max(30_000),
  /** Words or phrases it wasn't sure of, as it typed them: for the student to check. */
  unclear: z.array(z.string().trim().min(1).max(200)).max(60).default([]),
});
export type HandwritingRead = z.infer<typeof HandwritingSchema>;

export interface HandwritingInput {
  /** The question answered: only to help read the words, never to add to them. */
  question: string;
  /** The photos, in page order: JPEG files on this computer. */
  pages: string[];
}

/** Photos of one answer at most: a long answer runs to a few sides, not dozens. */
export const MAX_HANDWRITING_PAGES = 8;

export function handwritingVars(input: HandwritingInput): Record<string, string> {
  return {
    question: input.question.slice(0, 4000),
    pages: String(input.pages.length),
  };
}

/** What to tell a model given the photos as attachments. */
export function photosNote(count: number): string {
  return `\n\n---\n\nThe ${count === 1 ? "photo is" : `${count} photos are`} attached${count > 1 ? ", in page order" : ""}. Read every one before replying.`;
}
