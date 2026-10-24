import { z } from "zod";

/** Misheard words in a Whisper transcript, and what was said. */
export const FixesSchema = z.object({
  fixes: z
    .array(z.object({ heard: z.string().trim().min(1).max(120), correct: z.string().trim().min(1).max(200) }))
    .max(300)
    .default([]),
});
export type Fixes = z.infer<typeof FixesSchema>;

export interface FixInput {
  title: string;
  /** The slides' technical words and the course's concept names, spelled correctly. */
  vocabulary: string[];
  /** One piece of the transcript. */
  transcript: string;
}

export function fixVars(input: FixInput, transcript = input.transcript): Record<string, string> {
  return {
    title: input.title,
    vocabulary: input.vocabulary.length ? input.vocabulary.join(", ") : "(no slides — go by the subject)",
    transcript,
  };
}
