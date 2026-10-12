import type { Digest, FolderSort, Marking, PaperItems, QuestionSet } from "@/lib/llm/schemas";

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
  slides?: SlidesInfo;
}

/** A lecture's slide decks, for a model that can look at them and for the picture markers. */
export interface SlidesInfo {
  decks: Array<{
    /** Absolute path of the stored file. */
    file: string;
    name: string;
    /** Lecture-wide number of its first slide; numbers run on across decks. */
    first: number;
    pages: number;
    /** A PDF can be shown as pictures and read as pages. */
    pdf: boolean;
  }>;
  /** Other lectures using the same deck — this lecture covers only its own part. */
  sharedWith: string[];
}

export interface GenerateQuestionsInput {
  lectureTitle: string;
  transcript: string;
  slidesText?: string;
  concepts: ConceptRef[];
  /** How many questions each concept should get, from the allocation engine. */
  allocation: Array<{ conceptId: string; count: number }>;
  type: "LAQ" | "SAQ";
  /** Other lectures using the same slides: ask only about this lecture's part. */
  sharedWith?: string[];
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

/** One file in a folder being sorted: enough to tell what it is without reading all of it. */
export interface SortFile {
  /** 1-based; the reply refers to files by this. */
  number: number;
  path: string;
  /** "transcript, 52 min" · "slides, 48 pages" */
  detail: string;
  /** The opening text, or for slides each slide's first line. */
  excerpt: string;
}

export interface SortFilesInput {
  files: SortFile[];
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
  /** Looks at the slides themselves, as pages it can see. Without this, slides that
   *  are pictures are read with text recognition first (lib/ocr.ts). */
  readonly seesSlides?: boolean;
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
  /** Groups a folder's files into lectures. Quick and cheap: it reads only openings. */
  sortFiles(input: SortFilesInput): Promise<FolderSort>;
}
