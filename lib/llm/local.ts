import { createHash } from "node:crypto";

import type { GbnfJsonSchema, Llama, LlamaModel } from "node-llama-cpp";
import type { ZodType } from "zod";

import { digestVars, generateVars, markVars, paperVars, renderPrompt, type PromptName } from "@/lib/llm/prompts";
import type {
  DigestInput,
  GenerateQuestionsInput,
  LlmProvider,
  MarkInput,
  ParsePastPaperInput,
} from "@/lib/llm/provider";
import { importLlamaCpp } from "@/lib/llm/runtime";
import { DigestSchema, MarkingSchema, PaperItemsSchema, QuestionSetSchema } from "@/lib/llm/schemas";

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

/** Loaded once per worker: loading weights takes seconds to minutes. */
let runtime: { modelPath: string; llama: Llama; model: LlamaModel } | null = null;

async function load(modelPath: string) {
  if (runtime?.modelPath === modelPath) return runtime;
  const { getLlama } = await importLlamaCpp();
  const llama = runtime?.llama ?? (await getLlama());
  if (runtime) await runtime.model.dispose();
  runtime = null;
  const model = await llama.loadModel({ modelPath });
  runtime = { modelPath, llama, model };
  return runtime;
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
        items: { type: "object", properties: { what: text(120), where: { type: "string", maxLength: 120 } } },
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
    },
  };
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

export class LocalProvider implements LlmProvider {
  readonly name: string;
  lastPromptVersion = "";
  onProgress?: (detail: string | null) => void;
  /** Condensed notes per transcript, so a lecture's digest and its LAQs condense once. */
  private notes = new Map<string, string>();

  constructor(
    private readonly modelPath: string,
    private readonly modelName: string,
  ) {
    this.name = `local:${modelName}`;
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

  async generateQuestions(input: GenerateQuestionsInput) {
    const total = input.allocation.reduce((n, a) => n + a.count, 0);
    return this.run({
      prompt: "generate-questions",
      vars: (transcript) => generateVars({ ...input, transcript }),
      transcript: input.transcript,
      schema: questionsSchema(input.concepts.map((c) => c.id), input.type, total),
      zod: QuestionSetSchema,
      maxTokens: 900 * Math.max(1, total) + 300,
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

  private progress(detail: string | null) {
    this.onProgress?.(detail);
  }

  private async run<T>(opts: {
    prompt: PromptName;
    vars: (transcript: string) => Record<string, string>;
    transcript?: string;
    schema: GbnfJsonSchema;
    zod: ZodType<T>;
    maxTokens: number;
    temperature: number;
  }): Promise<T> {
    if (!runtime || runtime.modelPath !== this.modelPath) this.progress(`loading ${this.modelName} into memory`);
    const { llama, model } = await load(this.modelPath);
    const { LlamaChatSession } = await importLlamaCpp();

    let transcript = opts.transcript ?? "";
    let rendered = await renderPrompt(opts.prompt, opts.vars(transcript));
    const count = (text: string) => model.tokenize(text).length;
    const needed = count(rendered.text) + opts.maxTokens + OVERHEAD_TOKENS;

    const context = await model.createContext({
      contextSize: { min: Math.min(4096, needed), max: Math.min(needed, model.trainContextSize) },
    });
    try {
      // Too long for the memory this computer has: read the lecture in parts first.
      if (context.contextSize < needed && opts.transcript) {
        const room = context.contextSize - (needed - count(transcript));
        transcript = await this.condense(opts.transcript, Math.max(1024, room), context.contextSize);
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
      const text = await session.prompt(rendered.text, {
        grammar,
        maxTokens: Math.max(256, Math.min(opts.maxTokens, context.contextSize - count(rendered.text) - OVERHEAD_TOKENS)),
        temperature: opts.temperature,
        budgets: { thoughtTokens: 0 },
        onTextChunk: (chunk) => {
          words += chunk.split(/\s+/).filter(Boolean).length;
          if (Date.now() - last > 2000) {
            last = Date.now();
            this.progress(`writing — ${words.toLocaleString("en")} words so far`);
          }
        },
      });
      this.progress(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          "the local model ran out of room before finishing its answer — try a smaller model, or close other apps to free memory",
        );
      }
      return opts.zod.parse(parsed);
    } finally {
      await context.dispose();
    }
  }

  /**
   * Rewrites a transcript too long for the available context as dense notes, part by
   * part, keeping every fact and term. Slower, but nothing is silently cut off.
   */
  private async condense(transcript: string, targetTokens: number, contextSize: number): Promise<string> {
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
      this.progress(`lecture is long for this computer — reading part ${i + 1} of ${chunks.length}`);
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
            { maxTokens: perChunk, temperature: 0.2, budgets: { thoughtTokens: 0 } },
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
