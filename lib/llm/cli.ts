import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ZodType } from "zod";

import {
  digestVars,
  generateVars,
  markVars,
  paperVars,
  renderPrompt,
  type PromptName,
} from "@/lib/llm/prompts";
import { DigestSchema, MarkingSchema, PaperItemsSchema, QuestionSetSchema } from "@/lib/llm/schemas";
import type {
  DigestInput,
  GenerateQuestionsInput,
  LlmProvider,
  MarkInput,
  ParsePastPaperInput,
} from "@/lib/llm/provider";


export class ClaudeCliError extends Error {
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
  timeoutMs: number;
  /** Extra flags, space-separated, from LOCKIN_CLI_FLAGS. Lets flag drift be fixed
   *  without a code change. */
  extraArgs: string[];
}

export function cliConfigFromEnv(): ClaudeCliConfig {
  return {
    binary: process.env.LOCKIN_CLAUDE_BIN ?? "claude",
    model: process.env.LOCKIN_MODEL ?? "claude-opus-5",
    // One digest call now does what three used to, so a double lecture needs room.
    timeoutMs: Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000),
    extraArgs: (process.env.LOCKIN_CLI_FLAGS ?? "").split(" ").filter(Boolean),
  };
}

/** Runs `claude -p` with the prompt on stdin (transcripts blow past ARG_MAX). */
function runClaude(prompt: string, cfg: ClaudeCliConfig): Promise<string> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    cfg.model,
    // Every input is inlined in the prompt, so the model has no reason to touch
    // the filesystem, and a deterministic prompt is a cacheable one. --allowed-tools
    // is variadic, so an empty string is not a safe way to say "none" — deny instead.
    "--disallowed-tools",
    "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task",
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
        resolve(unwrapEnvelope(stdout));
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
  /** Set to the prompt version used by the most recent call, for stamping rows. */
  lastPromptVersion = "";

  constructor(private readonly cfg: ClaudeCliConfig = cliConfigFromEnv()) {}

  private async call<T>(promptName: PromptName, vars: Record<string, string>, schema: ZodType<T>) {
    const { text: prompt, version } = await renderPrompt(promptName, vars);
    this.lastPromptVersion = version;

    const attempt = async (extra = "") => {
      const reply = await runClaude(prompt + extra, this.cfg);
      return schema.parse(extractJson(reply));
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

  digest(input: DigestInput) {
    return this.call("digest-lecture", digestVars(input), DigestSchema);
  }

  generateQuestions(input: GenerateQuestionsInput) {
    return this.call("generate-questions", generateVars(input), QuestionSetSchema);
  }

  mark(input: MarkInput) {
    return this.call("mark", markVars(input), MarkingSchema);
  }

  parsePastPaper(input: ParsePastPaperInput) {
    return this.call("parse-past-paper", paperVars(input), PaperItemsSchema);
  }
}
