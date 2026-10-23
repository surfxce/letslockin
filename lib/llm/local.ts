import { FlashcardSetSchema, flashcardVars, type FlashcardsInput } from "@/lib/flashcards/schema";
import { McqSetSchema, mcqVars, type McqInput } from "@/lib/mcq/schema";
import { MistakeCardsSchema, mistakeVars, type MistakeInput } from "@/lib/flashcards/mistakes";
import { PaperGuidesSchema, paperGuideVars, type PaperGuideInput } from "@/lib/papers/schema";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";

import type { GbnfJsonSchema, Llama, LlamaModel } from "node-llama-cpp";
import type { ZodType } from "zod";

import { engineGenerate } from "@/lib/llm/mlx";
import { isLooping, LOOPING_MESSAGE } from "@/lib/llm/looping";
import { strictSchema } from "@/lib/llm/strict-schema";
import { jobSignal } from "@/lib/llm/cancel";
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
  SortFilesInput,
} from "@/lib/llm/provider";
import { importLlamaCpp } from "@/lib/llm/runtime";
import {
  AnswerSchema,
  DigestSchema,
  FolderSortSchema,
  MarkingSchema,
  PaperItemsSchema,
  QuestionSetSchema,
} from "@/lib/llm/schemas";

/**
 * Runs a downloaded model on this computer through llama.cpp — Metal on a Mac, CUDA
 * or Vulkan where present, the CPU otherwise. Fully offline.
 *
 * Small models are unreliable at free-form JSON, so every reply is constrained by a
 * grammar built from the expected shape; concept ids are constrained to the ones that
 * exist, so a reply cannot cite a concept that isn't there. Thinking is switched off:
 * it would double the time for structured output that does not need it.
 */

/** Room for the chat template and the start of the reply beyond what is counted. */
const OVERHEAD_TOKENS = 512;

interface Runtime {
  modelPath: string;
  llama: Llama;
  model: LlamaModel;
}

/** Loaded once per worker: loading weights takes seconds to minutes. */
let runtime: Runtime | null = null;
/** A load in progress. Sorting runs beside preparing, and two lanes must not load twice. */
let loading: Promise<Runtime> | null = null;
/** Calls running on the loaded model, which must not be pulled from under them. */
let inUse = 0;

/**
 * Frees the loaded model's memory — for llama.cpp's own server to load it with its
 * vision part (lib/llm/vision.ts). The next call loads it again. Left loaded while
 * anything is using it.
 */
export async function releaseLocalModel() {
  if (loading) await loading.catch(() => undefined);
  if (!runtime || inUse > 0) return;
  const { model } = runtime;
  runtime = null;
  await model.dispose();
}

function load(modelPath: string): Promise<Runtime> {
  if (runtime?.modelPath === modelPath) return Promise.resolve(runtime);
  const pending: Promise<Runtime> =
    loading ??
    (async () => {
      const { getLlama } = await importLlamaCpp();
      const llama = runtime?.llama ?? (await getLlama());
      if (runtime) await runtime.model.dispose();
      runtime = null;
      const model = await llama.loadModel({ modelPath });
      runtime = { modelPath, llama, model };
      return runtime;
    })().finally(() => {
      loading = null;
    });
  loading = pending;
  return pending.then((r) => (r.modelPath === modelPath ? r : load(modelPath)));
}

const nullable = (schema: GbnfJsonSchema): GbnfJsonSchema => ({ oneOf: [schema, { type: "null" }] });
/** Marks are out of ten in half marks; an open number lets a small model write -3 or 40. */
const MARKS: GbnfJsonSchema = { enum: Array.from({ length: 21 }, (_, i) => i / 2) };
const WHOLE_MARKS: GbnfJsonSchema = { enum: Array.from({ length: 11 }, (_, i) => i) };

/** Non-empty text, matching the schemas' min(1): a grammar alone would allow "". */
const text = (maxLength?: number): GbnfJsonSchema =>
  maxLength ? { type: "string", minLength: 1, maxLength } : { type: "string", minLength: 1 };
const idOf = (ids: string[]): GbnfJsonSchema => (ids.length ? { enum: ids } : { type: "null" });

function digestSchema(existingIds: string[]): GbnfJsonSchema {
  return {
    type: "object",
    properties: {
      title: text(140),
      skipped: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: { what: text(120), where: { type: "string", maxLength: 120 }, about: { type: "string", maxLength: 500 } },
        },
      },
      summaryMd: text(),
      concepts: {
        type: "array",
        minItems: 1,
        maxItems: 60,
        items: {
          type: "object",
          properties: {
            existingId: existingIds.length ? nullable({ enum: existingIds }) : { type: "null" },
            name: text(140),
            definition: text(),
            sourceRef: nullable({ type: "string", maxLength: 60 }),
          },
        },
      },
      // Notes describe what a slide shows; a model that never saw it has none to give.
      slideNotes: { type: "array", maxItems: 0 },
    },
  };
}

/** The reply, held to its shape — with what was wrong in words, not Zod's list of issues. */
function checked<T>(zod: ZodType<T>, reply: unknown): T {
  const result = zod.safeParse(reply);
  if (result.success) return result.data;
  const where = [...new Set(result.error.issues.map((i) => i.path.filter((p) => typeof p === "string").join(".")))]
    .filter(Boolean)
    .slice(0, 3);
  throw new Error(
    `the offline model's answer was missing parts${where.length ? ` (${where.join(", ")})` : ""} — try again, or use a larger model`,
  );
}

function questionsSchema(conceptIds: string[], type: "LAQ" | "SAQ", total: number): GbnfJsonSchema {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: Math.max(1, total),
        maxItems: Math.max(1, total),
        items: {
          type: "object",
          properties: {
            stem: text(),
            type: { const: type },
            conceptIds: { type: "array", minItems: 1, maxItems: 4, items: idOf(conceptIds) },
            rubric: {
              type: "object",
              properties: {
                modelAnswer: text(),
                criteria: {
                  type: "array",
                  minItems: 2,
                  maxItems: 8,
                  items: { type: "object", properties: { point: text(), marks: WHOLE_MARKS } },
                },
                totalMarks: { const: 10 },
              },
            },
          },
        },
      },
    },
  };
}

function markingSchema(conceptIds: string[]): GbnfJsonSchema {
  return {
    type: "object",
    properties: {
      mark: MARKS,
      criteria: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            point: text(),
            awarded: MARKS,
            outOf: MARKS,
            note: nullable({ type: "string" }),
          },
        },
      },
      gaps: conceptIds.length
        ? {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              properties: { conceptId: { enum: conceptIds }, type: { enum: ["MISSED", "WRONG"] }, text: text() },
            },
          }
        : { type: "array", maxItems: 0 },
    },
  };
}

function sortSchema(fileCount: number): GbnfJsonSchema {
  const file: GbnfJsonSchema = { enum: Array.from({ length: fileCount }, (_, i) => i + 1) };
  return {
    type: "object",
    properties: {
      lectures: {
        type: "array",
        maxItems: fileCount,
        items: {
          type: "object",
          properties: {
            title: text(120),
            module: nullable(text(80)),
            files: { type: "array", minItems: 1, maxItems: 8, items: file },
          },
        },
      },
      setAside: {
        type: "array",
        maxItems: fileCount,
        items: { type: "object", properties: { file, reason: text(80) } },
      },
    },
  };
}

/** A question's answer may only be filed under a heading the summary has. */
function answerSchema(headings: string[], maxLength: number): GbnfJsonSchema {
  return {
    type: "object",
    properties: {
      answer: text(maxLength),
      section: headings.length ? nullable({ enum: headings }) : { type: "null" },
    },
  };
}

const PAPER_SCHEMA: GbnfJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNumber: nullable({ type: "string", maxLength: 12 }),
          stem: text(),
          marksAllocated: nullable({ type: "number" }),
          conceptIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

interface RunOpts<T> {
  prompt: PromptName;
  vars: (transcript: string) => Record<string, string>;
  transcript?: string;
  schema: GbnfJsonSchema;
  zod: ZodType<T>;
  maxTokens: number;
  temperature: number;
  quiet?: boolean;
}

export class LocalProvider implements LlmProvider {
  readonly name: string;
  readonly lastModel: string;
  /** An MLX copy is a folder and runs on the Swift engine (lib/llm/mlx.ts); a GGUF file runs on llama.cpp. */
  readonly format: "mlx" | "gguf";
  lastPromptVersion = "";
  onProgress?: (detail: string | null) => void;
  /** Condensed notes per transcript, so a lecture's digest and its LAQs condense once. */
  private notes = new Map<string, string>();

  constructor(
    readonly modelPath: string,
    private readonly modelName: string,
    /** Its catalog id, for finding its vision part. */
    readonly modelId: string,
  ) {
    this.format = isDirectory(modelPath) ? "mlx" : "gguf";
    this.name = `local:${modelName}`;
    this.lastModel = `Offline · ${modelName}${this.format === "mlx" ? " (MLX)" : ""}`;
  }

  async digest(input: DigestInput) {
    return this.run({
      prompt: "digest-lecture",
      vars: (transcript) => digestVars({ ...input, transcript }),
      transcript: input.transcript,
      schema: digestSchema(input.existingConcepts.map((c) => c.id)),
      zod: DigestSchema,
      // A summary plus 8-20 concepts an hour.
      maxTokens: Math.round(2500 + 1200 * input.durationHours),
      temperature: 0.3,
    });
  }

  async generateFlashcards(input: FlashcardsInput) {
    const side: GbnfJsonSchema = {
      type: "object",
      properties: {
        text: text(4000),
        slide: input.slideNumbers.length ? nullable({ enum: input.slideNumbers }) : { type: "null" },
      },
    };
    return this.run({
      prompt: "generate-flashcards",
      vars: (source) => flashcardVars({ ...input, source }),
      transcript: input.source,
      schema: {
        type: "object",
        properties: {
          cards: {
            type: "array", minItems: 1, maxItems: 30,
            items: { type: "object", properties: { front: side, back: side } },
          },
        },
      },
      zod: FlashcardSetSchema,
      maxTokens: 6000,
      temperature: 0.3,
    });
  }

  async writePaperGuides(input: PaperGuideInput) {
    const n = input.questions.length;
    return this.run({
      prompt: "paper-guides",
      vars: (summary) => paperGuideVars({ ...input, summary }),
      transcript: input.summary,
      schema: {
        type: "object",
        properties: {
          guides: {
            type: "array",
            minItems: n,
            maxItems: n,
            items: {
              type: "object",
              properties: {
                key: { enum: input.questions.map((q) => q.key) },
                modelAnswer: text(),
                criteria: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: { point: text(), marks: WHOLE_MARKS } } },
              },
            },
          },
        },
      },
      zod: PaperGuidesSchema,
      maxTokens: 1100 * n + 300,
      temperature: 0.2,
    });
  }

  async writeMistakeCards(input: MistakeInput) {
    const n = input.mistakes.length;
    return this.run({
      prompt: "mistake-cards",
      vars: () => mistakeVars(input),
      schema: {
        type: "object",
        properties: {
          cards: {
            type: "array",
            minItems: n,
            maxItems: n,
            items: {
              type: "object",
              properties: { key: { enum: input.mistakes.map((m) => m.key) }, front: text(600), back: text(900) },
            },
          },
        },
      },
      zod: MistakeCardsSchema,
      maxTokens: 260 * n + 200,
      temperature: 0.3,
    });
  }

  async generateMcqs(input: McqInput) {
    const ids = input.concepts.map((c) => c.id);
    return this.run({
      prompt: "generate-mcqs",
      vars: (summary) => mcqVars({ ...input, summary }),
      transcript: input.summary,
      schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: Math.max(1, input.count),
            maxItems: Math.max(1, input.count),
            items: {
              type: "object",
              properties: {
                stem: text(1500),
                options: { type: "array", minItems: 5, maxItems: 5, items: text(300) },
                answer: { enum: [0, 1, 2, 3, 4] },
                explanation: text(800),
                conceptId: ids.length ? nullable({ enum: ids }) : { type: "null" },
              },
            },
          },
        },
      },
      zod: McqSetSchema,
      // A ceiling, not a target: five questions with options and explanations.
      maxTokens: 900 * Math.max(1, input.count) + 300,
      temperature: 0.5,
    });
  }

  async generateQuestions(input: GenerateQuestionsInput) {
    const total = input.allocation.reduce((n, a) => n + a.count, 0);
    // A fresh start from the summary alone: the summary step already read the transcript
    // and slides, and reading them all again is what ran laptops out of memory here.
    const fromSummary = input.summary?.trim()
      ? {
          transcript:
            "(This is the lecture's revision summary, written from its transcript and slides. " +
            "Write the questions and marking guides from it.)\n\n" +
            input.summary.trim(),
          slidesText: "(already covered in the summary above)",
        }
      : null;
    const source = fromSummary ?? { transcript: input.transcript, slidesText: input.slidesText };
    return this.run({
      prompt: "generate-questions",
      vars: (transcript) => generateVars({ ...input, ...source, transcript }),
      transcript: source.transcript,
      schema: questionsSchema(input.concepts.map((c) => c.id), input.type, total),
      zod: QuestionSetSchema,
      // A ceiling, not a target: a full model answer and up to eight criteria each.
      // A model that gets stuck is stopped sooner by isLooping.
      maxTokens: 2000 * Math.max(1, total) + 300,
      temperature: 0.5,
    });
  }

  async mark(input: MarkInput) {
    return this.run({
      prompt: "mark",
      vars: () => markVars(input),
      schema: markingSchema(input.concepts.map((c) => c.id)),
      zod: MarkingSchema,
      maxTokens: 1500,
      // The same answer should earn the same mark every time.
      temperature: 0,
    });
  }

  async parsePastPaper(input: ParsePastPaperInput) {
    return this.run({
      prompt: "parse-past-paper",
      vars: () => paperVars(input),
      schema: PAPER_SCHEMA,
      zod: PaperItemsSchema,
      maxTokens: 4000,
      temperature: 0,
    });
  }

  async sortFiles(input: SortFilesInput) {
    return this.run({
      prompt: "sort-files",
      vars: () => sortVars(input),
      schema: sortSchema(input.files.length),
      zod: FolderSortSchema,
      maxTokens: 120 + 60 * input.files.length,
      temperature: 0,
      // It runs beside a lecture being prepared, whose progress line this must not take over.
      quiet: true,
    });
  }

  async ask(input: AskInput) {
    const { prompt, vars } = askVars(input);
    const leftOut = input.kind === "leftout" ? input : null;
    return this.run({
      prompt,
      // A left-out part is looked for in the transcript, which may need condensing to fit.
      vars: (transcript) => (leftOut ? askVars({ ...leftOut, transcript }).vars : vars),
      transcript: leftOut?.transcript,
      schema: answerSchema(input.kind === "question" ? input.headings : [], input.kind === "question" ? 2400 : 900),
      zod: AnswerSchema,
      maxTokens: input.kind === "question" ? 700 : 300,
      temperature: 0.3,
      // It runs beside a lecture being prepared, whose progress line this must not take over.
      quiet: true,
    });
  }

  private progress(detail: string | null) {
    this.onProgress?.(detail);
  }

  private async run<T>(opts: RunOpts<T>): Promise<T> {
    inUse++;
    try {
      return await this.runLoaded(opts);
    } finally {
      inUse--;
    }
  }

  private async runLoaded<T>(opts: RunOpts<T>): Promise<T> {
    const progress = (detail: string | null) => (opts.quiet ? undefined : this.progress(detail));
    if (this.format === "mlx") return this.runOnMlx(opts, progress);
    if (!runtime || runtime.modelPath !== this.modelPath) progress(`loading ${this.modelName} into memory`);
    const { llama, model } = await load(this.modelPath);
    const { LlamaChatSession } = await importLlamaCpp();

    let transcript = opts.transcript ?? "";
    let rendered = await renderPrompt(opts.prompt, opts.vars(transcript));
    const count = (text: string) => model.tokenize(text).length;
    const needed = count(rendered.text) + opts.maxTokens + OVERHEAD_TOKENS;

    const context = await model.createContext({
      contextSize: { min: Math.min(4096, needed), max: Math.min(needed, model.trainContextSize) },
      // A lecture's transcript is a long context; this keeps its memory down.
      flashAttention: true,
    });
    try {
      // Too long for the memory this computer has: read the lecture in parts first.
      if (context.contextSize < needed && opts.transcript) {
        const room = context.contextSize - (needed - count(transcript));
        transcript = await this.condense(opts.transcript, Math.max(1024, room), context.contextSize, progress);
        rendered = await renderPrompt(opts.prompt, opts.vars(transcript));
      }
      this.lastPromptVersion = rendered.version;

      // Our schemas are built at runtime, so the typed overload has nothing to infer
      // from; Record<any, any> is the library's own default for the definitions.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const grammar = await llama.createGrammarForJsonSchema<GbnfJsonSchema, Record<any, any>>(opts.schema);
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      let words = 0;
      let last = 0;
      // Stopped early when it starts repeating itself; the job's own cancel still applies.
      let written = "";
      let checkedAt = 0;
      const looping = new AbortController();
      const job = jobSignal();
      const text = await session
        .prompt(rendered.text, {
          grammar,
          maxTokens: Math.max(256, Math.min(opts.maxTokens, context.contextSize - count(rendered.text) - OVERHEAD_TOKENS)),
          temperature: opts.temperature,
          budgets: { thoughtTokens: 0 },
          signal: job ? AbortSignal.any([job, looping.signal]) : looping.signal,
          onTextChunk: (chunk) => {
            written += chunk;
            if (written.length - checkedAt >= 64) {
              checkedAt = written.length;
              if (isLooping(written)) looping.abort();
            }
            words += chunk.split(/\s+/).filter(Boolean).length;
            if (Date.now() - last > 2000) {
              last = Date.now();
              progress(`writing — ${words.toLocaleString("en")} words so far`);
            }
          },
        })
        .catch((err: unknown) => {
          if (looping.signal.aborted && !job?.aborted) throw new Error(LOOPING_MESSAGE);
          throw err;
        });
      progress(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          "the local model ran out of room before finishing its answer — try a smaller model, or close other apps to free memory",
        );
      }
      return checked(opts.zod, parsed);
    } finally {
      await context.dispose();
    }
  }

  /**
   * The same request on the MLX engine. Its models take a whole lecture at once (no
   * condensing), and its reply is held to the same schema as llama.cpp's grammar.
   */
  private async runOnMlx<T>(opts: RunOpts<T>, progress: (detail: string | null) => void): Promise<T> {
    const rendered = await renderPrompt(opts.prompt, opts.vars(opts.transcript ?? ""));
    this.lastPromptVersion = rendered.version;
    progress(`loading ${this.modelName} on MLX`);
    const text = await engineGenerate({
      model: this.modelPath,
      prompt: rendered.text,
      schema: strictSchema(opts.schema),
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      // Roughly three words for every four tokens.
      onTokens: (tokens) => progress(`writing — about ${Math.round(tokens * 0.75).toLocaleString("en")} words so far`),
    });
    progress(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("the offline model stopped before finishing its answer — try a smaller model, or close other apps to free memory");
    }
    return checked(opts.zod, parsed);
  }

  /**
   * Rewrites a transcript too long for the available context as dense notes, part by
   * part, keeping every fact and term. Slower, but nothing is silently cut off.
   */
  private async condense(
    transcript: string,
    targetTokens: number,
    contextSize: number,
    progress: (detail: string | null) => void,
  ): Promise<string> {
    const key = createHash("sha1").update(`${contextSize}:${transcript}`).digest("hex");
    const cached = this.notes.get(key);
    if (cached) return cached;

    const { model } = runtime!;
    const { LlamaChatSession } = await importLlamaCpp();
    const usable = contextSize - OVERHEAD_TOKENS - 400;
    const chunkTokens = Math.floor(usable * 0.65);
    const chunks = splitByTokens(transcript, chunkTokens, (t) => model.tokenize(t).length);
    const perChunk = Math.max(200, Math.min(Math.floor(usable * 0.35), Math.floor(targetTokens / chunks.length)));

    const notes: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      progress(`lecture is long for this computer — reading part ${i + 1} of ${chunks.length}`);
      const context = await model.createContext({ contextSize });
      try {
        const session = new LlamaChatSession({ contextSequence: context.getSequence() });
        notes.push(
          await session.prompt(
            `Below is part ${i + 1} of ${chunks.length} of a university lecture transcript. Rewrite it as dense ` +
              `revision notes in bullet points: keep every fact, definition, number, example, mechanism and the ` +
              `lecturer's exact terms, and mark anything the lecturer calls examinable. Keep the timestamp at the ` +
              `start of each point. Leave out filler, repetition, module aims and housekeeping. Use at most about ` +
              `${Math.round(perChunk * 0.7)} words.\n\n${chunk}`,
            { maxTokens: perChunk, temperature: 0.2, budgets: { thoughtTokens: 0 }, signal: jobSignal() },
          ),
        );
      } finally {
        await context.dispose();
      }
    }
    const result = `(Condensed notes of the transcript, written part by part.)\n\n${notes.join("\n\n")}`;
    this.notes.set(key, result);
    return result;
  }
}

/** Splits on paragraph boundaries into pieces of at most `limit` tokens. */
export function splitByTokens(text: string, limit: number, count: (t: string) => number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    const n = count(p);
    if (n > limit) {
      // One enormous paragraph (captions with no breaks): cut it by sentences.
      if (current.length) out.push(current.join("\n\n"));
      current = [];
      size = 0;
      let piece = "";
      for (const sentence of p.split(/(?<=[.!?])\s+/)) {
        if (piece && count(piece + " " + sentence) > limit) {
          out.push(piece);
          piece = sentence;
        } else piece = piece ? `${piece} ${sentence}` : sentence;
      }
      if (piece) out.push(piece);
      continue;
    }
    if (size + n > limit && current.length) {
      out.push(current.join("\n\n"));
      current = [];
      size = 0;
    }
    current.push(p);
    size += n;
  }
  if (current.length) out.push(current.join("\n\n"));
  return out;
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
