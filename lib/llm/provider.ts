import type { Digest, Marking, PaperItems, QuestionSet } from "@/lib/llm/schemas";

/** A concept as the model sees it: enough to reuse an id, not enough to pad the prompt. */
export interface ConceptRef {
  id: string;
  name: string;
  definition: string;
}

export interface DigestInput {
  currentTitle: string;
  /** True when the current title came from a filename and should be replaced. */
  titleIsPlaceholder: boolean;
  durationHours: number;
  transcript: string;
  slidesText?: string;
  /** Sections already removed before the model saw the text, so it can mention them. */
  alreadySkipped: Array<{ what: string; where: string }>;
  /** Concepts already on the course. The model reuses these ids rather than
   *  minting near-duplicates, which is what stops mastery and yield fragmenting. */
  existingConcepts: ConceptRef[];
}

export interface GenerateQuestionsInput {
  lectureTitle: string;
  transcript: string;
  slidesText?: string;
  concepts: ConceptRef[];
  /** How many questions each concept should get, from the allocation engine. */
  allocation: Array<{ conceptId: string; count: number }>;
  type: "LAQ" | "SAQ";
}

export interface MarkInput {
  questionStem: string;
  rubric: unknown;
  answerText: string;
  /** Only the concepts this question covers — gaps must cite one of these ids. */
  concepts: ConceptRef[];
}

export interface ParsePastPaperInput {
  paperText: string;
  concepts: ConceptRef[];
}

/**
 * The only place in the app a model gets called.
 *
 * Backed by the Claude Code CLI against a personal subscription, by a model running
 * on this computer, or by a canned stand-in for development and demos. Nothing
 * outside lib/llm/ may import an adapter directly.
 */
export interface LlmProvider {
  readonly name: string;
  /** Version of the prompt behind the most recent call, stamped onto the rows it produced. */
  readonly lastPromptVersion: string;
  /** Set by the worker: a slow provider reports what it is doing within a stage
   *  ("reading part 2 of 4"), and null when it has nothing to add. */
  onProgress?: (detail: string | null) => void;
  /** Title, set-aside sections, summary and concepts for one lecture, in one call. */
  digest(input: DigestInput): Promise<Digest>;
  generateQuestions(input: GenerateQuestionsInput): Promise<QuestionSet>;
  mark(input: MarkInput): Promise<Marking>;
  parsePastPaper(input: ParsePastPaperInput): Promise<PaperItems>;
}
