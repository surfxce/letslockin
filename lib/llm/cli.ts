import { FlashcardSetSchema, flashcardVars, type FlashcardsInput } from "@/lib/flashcards/schema";
import { McqSetSchema, mcqVars, type McqInput } from "@/lib/mcq/schema";
import { MistakeCardsSchema, mistakeVars, type MistakeInput } from "@/lib/flashcards/mistakes";
import { PaperGuidesSchema, paperGuideVars, type PaperGuideInput } from "@/lib/papers/schema";
import { mixedVars, type MixedInput } from "@/lib/mixed/schema";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ZodType } from "zod";

import { CloudError } from "@/lib/llm/base";
import { JobCancelled, killOnCancel } from "@/lib/llm/cancel";
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
import {
  AnswerSchema,
  DigestSchema,
  FolderSortSchema,
  MarkingSchema,
  PaperItemsSchema,
  QuestionSetSchema,
} from "@/lib/llm/schemas";
import type {
  AskInput,
  DigestInput,
  GenerateQuestionsInput,
  LlmProvider,
  MarkInput,
  ParsePastPaperInput,
  SortFilesInput,
} from "@/lib/llm/provider";


export class ClaudeCliError extends CloudError {
  constructor(
    message: string,
    readonly detail?: { stderr?: string; stdout?: string; code?: number | null },
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export interface ClaudeCliConfig {
  /** Path to the standalone CLI. The desktop app ships its own copy that is not on PATH. */
  binary: string;
  model: string;
  /** For sorting a folder: a quick look at file openings, so a small fast model. */
  sortModel: string;
  /** For questions asked from a lecture page while the student waits: quick, but
   *  answering about the content, so not the smallest model. */
  askModel: string;
  /** How hard the model thinks before preparing or marking a lecture (Claude Code's
   *  --effort). Left to the CLI, a big model thinks at length about work that is
   *  mostly careful reading and writing, and a lecture takes minutes longer. Null
   *  leaves it to the CLI's own default. */
  effort: string | null;
  timeoutMs: number;
  /** Extra flags, space-separated, from LOCKIN_CLI_FLAGS. Lets flag drift be fixed
   *  without a code change. */
  extraArgs: string[];
}

export function cliConfigFromEnv(): ClaudeCliConfig {
  return {
    binary: process.env.LOCKIN_CLAUDE_BIN ?? "claude",
    // Settings choose the model (lib/llm/index.ts); this is only the fallback.
    model: process.env.LOCKIN_MODEL ?? "sonnet",
    sortModel: process.env.LOCKIN_SORT_MODEL ?? "haiku",
    askModel: process.env.LOCKIN_ASK_MODEL ?? "sonnet",
    effort: process.env.LOCKIN_EFFORT === "default" ? null : (process.env.LOCKIN_EFFORT ?? "medium"),
    // One digest call now does what three used to, so a double lecture needs room.
    timeoutMs: Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000),
    extraArgs: (process.env.LOCKIN_CLI_FLAGS ?? "").split(" ").filter(Boolean),
  };
}

export interface RunOptions {
  model?: string;
  /** Folders the model may read files from — the slide decks, which it reads as pages
   *  it can see. Reading is the only tool it ever gets, and only for these. */
  readDirs?: string[];
  /** --effort for this call: "low" for quick sorting and questions. */
  effort?: string | null;
}

/** Runs `claude -p` with the prompt on stdin (transcripts blow past ARG_MAX). Gives back
 *  the reply, and the model that actually wrote it when the CLI says. */
function runClaude(
  prompt: string,
  cfg: ClaudeCliConfig,
  opts: RunOptions = {},
): Promise<{ text: string; model: string | null }> {
  const reads = opts.readDirs?.length ? opts.readDirs : null;
  const effort = opts.effort === undefined ? cfg.effort : opts.effort;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    opts.model ?? cfg.model,
    ...(effort ? ["--effort", effort] : []),
    // Text is inlined in the prompt; the only thing worth opening is a slide deck, so
    // Read is allowed only when there is one, and only in its folder. --allowed-tools
    // and --add-dir are variadic, so each is followed by another flag, and "none" is
    // said by denying rather than by an empty list.
    ...(reads ? ["--allowed-tools", "Read", "--add-dir", ...reads] : []),
    "--disallowed-tools",
    `Bash,${reads ? "" : "Read,"}Write,Edit,Glob,Grep,WebFetch,WebSearch,Task`,
    ...cfg.extraArgs,
  ];

  return new Promise((resolve, reject) => {
    // Run from a neutral directory. From the repo, the CLI would load this project's
    // CLAUDE.md, settings and hooks into every call — tokens and startup time spent
    // on context the prompt does not need.
    const child = spawn(cfg.binary, args, { stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ClaudeCliError(`claude timed out after ${cfg.timeoutMs}ms`));
    }, cfg.timeoutMs);
    const unhook = killOnCancel(child, () => reject(new JobCancelled()));
    child.on("close", unhook);

    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new ClaudeCliError(
          `could not run "${cfg.binary}" (${err.message}). Install it with ` +
            `\`npm i -g @anthropic-ai/claude-code\` and run \`claude\` once to log in.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        // Parse before checking the exit code: the CLI still prints a result
        // envelope on failure, and its message ("Not logged in", a rate limit,
        // a refusal) is far more useful than the status.
        resolve({ text: unwrapEnvelope(stdout), model: modelOf(stdout) });
      } catch (err) {
        if (code !== 0 && !(err instanceof ClaudeCliError && /claude reported/.test(err.message))) {
          reject(
            new ClaudeCliError(
              `claude exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
              { stderr, stdout, code },
            ),
          );
          return;
        }
        reject(err);
      }
    });

    child.stdin.end(prompt);
  });
}

/** `--output-format json` wraps the reply in a result envelope. Be tolerant about its shape. */
export function unwrapEnvelope(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new ClaudeCliError("claude returned nothing on stdout");
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      if (o.is_error) {
        throw new ClaudeCliError(`claude reported an error: ${String(o.result ?? o.error ?? "")}`);
      }
      if (typeof o.result === "string") return o.result;
      if (Array.isArray(o.content)) {
        return o.content
          .filter((b): b is { type: string; text: string } => {
            const blk = b as { type?: unknown; text?: unknown };
            return blk?.type === "text" && typeof blk.text === "string";
          })
          .map((b) => b.text)
          .join("");
      }
    }
  } catch (err) {
    if (err instanceof ClaudeCliError) throw err;
    // Not an envelope — some flag combinations print the bare reply.
  }
  return trimmed;
}

/**
 * The model that did most of the writing, from the envelope's per-model usage. A call
 * can touch more than one (a small model for housekeeping), so the one that wrote the
 * most output is the one that answered.
 */
export function modelOf(stdout: string): string | null {
  try {
    const usage = (JSON.parse(stdout.trim()) as { modelUsage?: Record<string, { outputTokens?: number }> }).modelUsage;
    if (!usage || typeof usage !== "object") return null;
    const ranked = Object.entries(usage).sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0));
    return ranked[0]?.[0] ?? null;
  } catch {
    return null;
  }
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
  if (start === -1) throw new ClaudeCliError(`no JSON found in reply: ${text.slice(0, 300)}`);
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) throw new ClaudeCliError(`unbalanced JSON in reply: ${text.slice(0, 300)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-code-cli";
  readonly seesSlides = true;
  /** Set to the prompt version used by the most recent call, for stamping rows. */
  lastPromptVersion = "";
  lastModel: string;

  constructor(private readonly cfg: ClaudeCliConfig = cliConfigFromEnv()) {
    this.lastModel = `Claude Code · ${cfg.model}`;
  }

  private async call<T>(
    promptName: PromptName,
    vars: Record<string, string>,
    schema: ZodType<T>,
    opts: RunOptions & { append?: string } = {},
  ) {
    const rendered = await renderPrompt(promptName, vars);
    const prompt = rendered.text + (opts.append ?? "");
    this.lastPromptVersion = rendered.version;

    const attempt = async (extra = "") => {
      const reply = await runClaude(prompt + extra, this.cfg, opts);
      this.lastModel = `Claude Code · ${reply.model ?? opts.model ?? this.cfg.model}`;
      return schema.parse(extractJson(reply.text));
    };

    try {
      return await attempt();
    } catch (first) {
      // One repair pass, then the job fails loudly rather than writing junk.
      const why = first instanceof Error ? first.message : String(first);
      return attempt(
        `\n\nYour previous reply could not be used: ${why}\n` +
          `Reply again with valid JSON matching the schema exactly. No prose, no code fences.`,
      );
    }
  }

  /**
   * With PDF slides, Claude reads the decks itself, as pages it can see: text inside
   * pictures, diagrams and photos never reaches the extracted text. It writes notes
   * on each slide as it goes, for the later steps that only read text.
   */
  digest(input: DigestInput) {
    const pdfs = input.slides?.decks.filter((d) => d.pdf && d.pages > 0) ?? [];
    if (pdfs.length === 0) return this.call("digest-lecture", digestVars(input), DigestSchema);
    const list = pdfs
      .map((d) => `- ${d.file} — ${d.pages} page${d.pages === 1 ? "" : "s"}, slides ${d.first}–${d.first + d.pages - 1}`)
      .join("\n");
    const append =
      `\n\n---\n\nThe slide decks are attached as PDF files you can open with the Read tool. The slide text ` +
      `above was extracted from them and misses everything inside pictures, diagrams, tables and photos, so ` +
      `look at every page yourself before writing anything — up to 20 pages per Read call (pages "1-20", then ` +
      `"21-40", and so on):\n\n${list}\n\nSlides are numbered across the decks as listed: use those numbers for ` +
      `slide pictures and slideNotes. Read nothing else. Then reply with the JSON described above.`;
    return this.call("digest-lecture", digestVars(input, { visual: true }), DigestSchema, {
      readDirs: [...new Set(pdfs.map((d) => path.dirname(d.file)))],
      append,
    });
  }

  generateFlashcards(input: FlashcardsInput) {
    return this.call("generate-flashcards", flashcardVars(input), FlashcardSetSchema);
  }

  generateMcqs(input: McqInput) {
    return this.call("generate-mcqs", mcqVars(input), McqSetSchema);
  }

  writeMistakeCards(input: MistakeInput) {
    return this.call("mistake-cards", mistakeVars(input), MistakeCardsSchema);
  }

  writePaperGuides(input: PaperGuideInput) {
    return this.call("paper-guides", paperGuideVars(input), PaperGuidesSchema);
  }

  generateQuestions(input: GenerateQuestionsInput) {
    return this.call("generate-questions", generateVars(input), QuestionSetSchema);
  }

  writeMixedQuestions(input: MixedInput) {
    return this.call("mixed-questions", mixedVars(input), QuestionSetSchema);
  }

  mark(input: MarkInput) {
    return this.call("mark", markVars(input), MarkingSchema);
  }

  parsePastPaper(input: ParsePastPaperInput) {
    return this.call("parse-past-paper", paperVars(input), PaperItemsSchema);
  }

  sortFiles(input: SortFilesInput) {
    return this.call("sort-files", sortVars(input), FolderSortSchema, { model: this.cfg.sortModel, effort: "low" });
  }

  ask(input: AskInput) {
    const { prompt, vars } = askVars(input);
    // Someone chose Haiku to be quick: questions stay on it too.
    return this.call(prompt, vars, AnswerSchema, {
      model: this.cfg.model === "haiku" ? "haiku" : this.cfg.askModel,
      effort: "low",
    });
  }
}
