import type {
  ConceptList,
  LectureIdentification,
  Marking,
  PaperItems,
  QuestionSet,
  Summary,
} from "@/lib/llm/schemas";

/** A concept as the model sees it: enough to reuse an id, not enough to pad the prompt. */
export interface ConceptRef {
  id: string;
  name: string;
  definition: string;
}

export interface SummariseInput {
  lectureTitle: string;
  durationHours: number;
  transcript: string;
  slidesText?: string;
}

export interface ExtractConceptsInput {
  lectureTitle: string;
  durationHours: number;
  transcript: string;
  slidesText?: string;
  /** Concepts already on the course. The model reuses these ids rather than
   *  minting near-duplicates, which is what stops mastery and yield fragmenting. */
  existingConcepts: ConceptRef[];
}

export interface GenerateQuestionsInput {
  lectureTitle: string;
  transcript: string;
  slidesText?: string;
  concepts: ConceptRef[];
  /** How many questions each concept should get, from the allocation engine.
   *  Phase 2 passes a flat 2-per-lecture-hour; phase 5 makes it adaptive. */
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

/** One candidate file, as the identifier sees it. */
export interface ManifestEntry {
  index: number;
  filename: string;
  modifiedOn: string;
  kindGuess: string;
  /** Read off the transcript's own timestamps, when it has them. Authoritative. */
  measuredHours: number | null;
  excerpt: string;
}

export interface IdentifyLecturesInput {
  files: ManifestEntry[];
  existingModules: Array<{ id: string; title: string }>;
}

export interface ParsePastPaperInput {
  paperText: string;
  concepts: ConceptRef[];
}

/**
 * The only place in the app a model gets called.
 *
 * v1 is backed by the Claude Code CLI against a personal subscription; the
 * Anthropic SDK adapter lands when this needs to run for anyone but its author.
 * Nothing outside lib/llm/ may import an adapter directly.
 */
export interface LlmProvider {
  readonly name: string;
  /** Version of the prompt behind the most recent call, stamped onto the rows it produced. */
  readonly lastPromptVersion: string;
  summarise(input: SummariseInput): Promise<Summary>;
  extractConcepts(input: ExtractConceptsInput): Promise<ConceptList>;
  generateQuestions(input: GenerateQuestionsInput): Promise<QuestionSet>;
  mark(input: MarkInput): Promise<Marking>;
  parsePastPaper(input: ParsePastPaperInput): Promise<PaperItems>;
  /** Groups a folder of loose files into the lectures they belong to. */
  identifyLectures(input: IdentifyLecturesInput): Promise<LectureIdentification>;
}
