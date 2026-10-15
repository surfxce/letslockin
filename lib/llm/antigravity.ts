import path from "node:path";

import { CloudError, decksNote, PromptProvider, type CallOptions, type Reply } from "@/lib/llm/base";
import { lastLine, runTool } from "@/lib/llm/process";

/**
 * Google's Antigravity CLI (`agy`), signed in with a Google account — or the Gemini CLI
 * it replaced (`gemini`), which takes the same headless flags. Gemini reads PDFs
 * itself, so the slide decks are attached as they are, with "@path".
 */
export class AntigravityCliProvider extends PromptProvider {
  readonly name = "antigravity-cli";
  readonly seesSlides = true;

  constructor(
    private readonly binary: string,
    /** Empty for the CLI's own choice. */
    private readonly model: string,
    private readonly timeoutMs = Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000),
  ) {
    super();
    this.lastModel = this.label();
  }

  protected label(model?: string | null) {
    const tool = path.basename(this.binary).startsWith("gemini") ? "Gemini CLI" : "Antigravity";
    return `${tool} · ${model || this.model || "auto"}`;
  }

  protected async complete(prompt: string, opts: CallOptions): Promise<Reply> {
    const pdfs = opts.slides?.decks.filter((d) => d.pdf && d.pages > 0) ?? [];
    const dirs = [...new Set(pdfs.map((d) => path.dirname(d.file)))];
    // The long prompt goes in on stdin; the short instruction on -p is where "@file"
    // attachments are read, and stdin comes before it.
    const instruction = pdfs.length
      ? `The slide decks: ${pdfs.map((d) => `@${d.file}`).join(" ")} — read every page, then follow the instructions above.`
      : "Follow the instructions above.";
    const args = [
      "--output-format",
      "json",
      "--skip-trust",
      ...(this.model ? ["--model", this.model] : []),
      ...dirs.flatMap((d) => ["--include-directories", d]),
      "--prompt",
      instruction,
    ];
    const run = await runTool(this.binary, args, prompt + (opts.slides ? decksNote(opts.slides) : ""), {
      timeoutMs: this.timeoutMs,
      what: "Antigravity",
      install: "Install the Antigravity CLI (antigravity.google/cli) and run `agy` once to sign in.",
    });
    let parsed: { response?: unknown; error?: { message?: string } | string; stats?: { models?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(run.stdout.trim());
    } catch {
      const why = lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.code}`;
      throw new CloudError(`Antigravity couldn't answer: ${why}`);
    }
    if (parsed.error || typeof parsed.response !== "string") {
      const why = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "no reply");
      throw new CloudError(`Antigravity couldn't answer: ${why}`);
    }
    // Usage is reported per model; the one listed is the one that answered.
    const model = Object.keys(parsed.stats?.models ?? {})[0] ?? null;
    return { text: parsed.response, model };
  }
}
