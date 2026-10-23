import { FlashcardSetSchema, flashcardVars, type FlashcardsInput } from "@/lib/flashcards/schema";
import { McqSetSchema, mcqVars, type McqInput } from "@/lib/mcq/schema";
import { MistakeCardsSchema, mistakeVars, type MistakeInput } from "@/lib/flashcards/mistakes";
import { PaperGuidesSchema, paperGuideVars, type PaperGuideInput } from "@/lib/papers/schema";
import { mixedVars, type MixedInput } from "@/lib/mixed/schema";
import type { ZodType } from "zod";

import {
  askVars,
  digestVars,
  generateVars,
  markVars,
  paperVars,
  renderPrompt,
  sortVars,
  type PromptName,
} from "@/lib/llm/prompts";
import type {
  AskInput,
  DigestInput,
  GenerateQuestionsInput,
  LlmProvider,
  MarkInput,
  ParsePastPaperInput,
  SlidesInfo,
  SortFilesInput,
} from "@/lib/llm/provider";
import {
  AnswerSchema,
  DigestSchema,
  FolderSortSchema,
  MarkingSchema,
  PaperItemsSchema,
  QuestionSetSchema,
} from "@/lib/llm/schemas";

/**
 * A cloud AI that could not do the job: not installed, signed out, out of credit, a
 * reply that would not parse. The worker hands such a job to the offline model when
 * there is one (worker/index.ts); a lecture with nothing to read fails another way.
 */
export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudError";
  }
}

export type Task = "digest" | "questions" | "mark" | "paper" | "sort" | "ask" | "flashcards" | "mcqs";

/** What a call needs beyond its prompt text. */
export interface CallOptions {
  task: Task;
  /** The lecture's slide decks, for an engine that looks at them; only on digests. */
  slides?: SlidesInfo;
}

export interface Reply {
  text: string;
  /** The model that wrote it, when the engine says. */
  model?: string | null;
}

/**
 * The shape every cloud engine shares: a versioned prompt goes in, JSON comes out,
 * is validated, and one bad reply gets a repair pass before the job fails. An engine
 * only says how it sends a prompt (and the slides) and gets text back.
 */
export abstract class PromptProvider implements LlmProvider {
  abstract readonly name: string;
  abstract readonly seesSlides: boolean;
  lastPromptVersion = "";
  lastModel = "";
  onProgress?: (detail: string | null) => void;

  /** Sends one prompt and returns the reply's text. Throws CloudError on failure. */
  protected abstract complete(prompt: string, opts: CallOptions): Promise<Reply>;

  /** How this engine's replies are credited: "ChatGPT Codex · gpt-…". */
  protected abstract label(model?: string | null): string;

  protected async call<T>(promptName: PromptName, vars: Record<string, string>, schema: ZodType<T>, opts: CallOptions) {
    const rendered = await renderPrompt(promptName, vars);
    this.lastPromptVersion = rendered.version;
    const attempt = async (extra = "") => {
      const reply = await this.complete(rendered.text + extra, opts);
      this.lastModel = this.label(reply.model);
      return schema.parse(extractJson(reply.text));
    };
    try {
      return await attempt();
    } catch (first) {
      // A failure to reach the engine is not fixed by asking again.
      if (first instanceof CloudError && !/no JSON|unbalanced JSON/.test(first.message)) throw first;
      const why = first instanceof Error ? first.message : String(first);
      return attempt(
        `\n\nYour previous reply could not be used: ${why}\n` +
          `Reply again with valid JSON matching the schema exactly. No prose, no code fences.`,
      );
    }
  }

  digest(input: DigestInput) {
    const pictured = this.seesSlides && input.slides?.decks.some((d) => d.pdf && d.pages > 0);
    return this.call("digest-lecture", digestVars(input, { visual: pictured }), DigestSchema, {
      task: "digest",
      slides: pictured ? input.slides : undefined,
    });
  }

  generateFlashcards(input: FlashcardsInput) {
    return this.call("generate-flashcards", flashcardVars(input), FlashcardSetSchema, { task: "flashcards" });
  }

  generateMcqs(input: McqInput) {
    return this.call("generate-mcqs", mcqVars(input), McqSetSchema, { task: "mcqs" });
  }

  writeMistakeCards(input: MistakeInput) {
    return this.call("mistake-cards", mistakeVars(input), MistakeCardsSchema, { task: "flashcards" });
  }

  writePaperGuides(input: PaperGuideInput) {
    return this.call("paper-guides", paperGuideVars(input), PaperGuidesSchema, { task: "paper" });
  }

  generateQuestions(input: GenerateQuestionsInput) {
    return this.call("generate-questions", generateVars(input), QuestionSetSchema, { task: "questions" });
  }

  writeMixedQuestions(input: MixedInput) {
    return this.call("mixed-questions", mixedVars(input), QuestionSetSchema, { task: "questions" });
  }

  mark(input: MarkInput) {
    return this.call("mark", markVars(input), MarkingSchema, { task: "mark" });
  }

  parsePastPaper(input: ParsePastPaperInput) {
    return this.call("parse-past-paper", paperVars(input), PaperItemsSchema, { task: "paper" });
  }

  sortFiles(input: SortFilesInput) {
    return this.call("sort-files", sortVars(input), FolderSortSchema, { task: "sort" });
  }

  ask(input: AskInput) {
    const { prompt, vars } = askVars(input);
    return this.call(prompt, vars, AnswerSchema, { task: "ask" });
  }
}

/** Quick work — sorting files, a question asked on a lecture page — needs little thought. */
export function isQuick(task: Task): boolean {
  return task === "sort" || task === "ask";
}

/** Pulls the JSON body out of a reply that may be fenced or prefaced with prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    // Fall through to bracket scanning.
  }
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new CloudError(`no JSON found in reply: ${text.slice(0, 300)}`);
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) throw new CloudError(`unbalanced JSON in reply: ${text.slice(0, 300)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

/** The slide pictures an engine looks at: no more than this many, in order. */
export const MAX_SLIDE_PICTURES = 80;

/** Each PDF slide as a picture file (rendered once and kept), for engines that take images. */
export async function slidePictures(slides: SlidesInfo): Promise<Array<{ slide: number; file: string }>> {
  // Loaded here, not at the top: drawing pages pulls in the PDF engine and a canvas.
  const { pagePngFile } = await import("@/lib/slides");
  const out: Array<{ slide: number; file: string }> = [];
  for (const deck of slides.decks) {
    if (!deck.pdf) continue;
    for (let page = 1; page <= deck.pages && out.length < MAX_SLIDE_PICTURES; page++) {
      out.push({ slide: deck.first + page - 1, file: await pagePngFile(slides.lectureId, deck, page) });
    }
  }
  return out;
}

/** What to tell a model that has been given the slides as pictures. */
export function picturesNote(pictures: Array<{ slide: number }>, total: number): string {
  if (pictures.length === 0) return "";
  const first = pictures[0].slide;
  const last = pictures[pictures.length - 1].slide;
  return (
    `\n\n---\n\nThe slides are attached as ${pictures.length} pictures, in order: the first is slide ${first}, ` +
    `the last slide ${last}${total > pictures.length ? ` (the rest are only in the slide text above)` : ""}. The ` +
    `slide text above was extracted from them and misses everything inside pictures, diagrams, tables and photos, ` +
    `so look at every picture before writing anything. Use those slide numbers for slide pictures and slideNotes. ` +
    `Then reply with the JSON described above.`
  );
}

/** What to tell a model that has been given the slide PDFs themselves. */
export function decksNote(slides: SlidesInfo): string {
  const pdfs = slides.decks.filter((d) => d.pdf && d.pages > 0);
  if (pdfs.length === 0) return "";
  const list = pdfs.map((d) => `- ${d.name}: slides ${d.first}–${d.first + d.pages - 1}`).join("\n");
  return (
    `\n\n---\n\nThe slide decks are attached as PDF files. The slide text above was extracted from them and misses ` +
    `everything inside pictures, diagrams, tables and photos, so look at every page yourself before writing ` +
    `anything. Slides are numbered across the decks as listed:\n\n${list}\n\nUse those numbers for slide pictures ` +
    `and slideNotes. Then reply with the JSON described above.`
  );
}

/** An engine that can't run as set up — no API key, no address — and says so on every call. */
export class MisconfiguredProvider extends PromptProvider {
  readonly name = "misconfigured";
  readonly seesSlides = false;

  constructor(
    private readonly what: string,
    private readonly problem: string,
  ) {
    super();
    this.lastModel = what;
  }

  protected label() {
    return this.what;
  }

  protected async complete(): Promise<Reply> {
    throw new CloudError(this.problem);
  }
}
