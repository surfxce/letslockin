import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CloudError, isQuick, picturesNote, PromptProvider, slidePictures, type CallOptions, type Reply } from "@/lib/llm/base";
import { lastLine, runTool } from "@/lib/llm/process";

/**
 * ChatGPT's Codex CLI, signed in with a ChatGPT plan (`codex login`). It reads the
 * slides as pictures: each PDF page is drawn once and attached with --image.
 *
 * Codex is an agent that can run commands; here it only ever answers. It runs in a
 * read-only sandbox, outside any repository, with nothing saved between calls.
 */
export class CodexCliProvider extends PromptProvider {
  readonly name = "codex-cli";
  readonly seesSlides = true;

  constructor(
    private readonly binary: string,
    /** Empty for whatever Codex is set to use. */
    private readonly model: string,
    private readonly timeoutMs = Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000),
  ) {
    super();
    this.lastModel = this.label();
  }

  protected label(model?: string | null) {
    return `ChatGPT Codex · ${model || this.model || "default model"}`;
  }

  /** When the sign-in was last confirmed. Codex signed out waits rather than failing,
   *  so it is asked first — it answers in a moment. */
  private signedInAt = 0;

  private async checkSignedIn() {
    if (Date.now() - this.signedInAt < 5 * 60_000) return;
    const status = await runTool(this.binary, ["login", "status"], "", {
      timeoutMs: 20_000,
      what: "Codex",
      install: "Install it with `npm i -g @openai/codex` and run `codex login` once.",
    });
    if (status.code !== 0) {
      throw new CloudError("Codex isn't signed in — run `codex login` in a terminal, then try again");
    }
    this.signedInAt = Date.now();
  }

  protected async complete(prompt: string, opts: CallOptions): Promise<Reply> {
    await this.checkSignedIn();
    const work = await mkdtemp(path.join(tmpdir(), "lockin-codex-"));
    try {
      const pictures = opts.slides ? await slidePictures(opts.slides) : [];
      const total = opts.slides?.decks.reduce((n, d) => n + (d.pdf ? d.pages : 0), 0) ?? 0;
      const out = path.join(work, "reply.txt");
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--cd",
        work,
        "--output-last-message",
        out,
        "-c",
        `model_reasoning_effort="${isQuick(opts.task) ? "low" : "medium"}"`,
        ...(this.model ? ["--model", this.model] : []),
        ...pictures.flatMap((p) => ["--image", p.file]),
        "-",
      ];
      const instructions =
        "Answer from the text below alone: do not run any commands or open any files.\n\n" +
        prompt +
        picturesNote(pictures, total);
      const run = await runTool(this.binary, args, instructions, {
        timeoutMs: this.timeoutMs,
        what: "Codex",
        install: "Install it with `npm i -g @openai/codex` and run `codex login` once.",
      });
      const text = await readFile(out, "utf8").catch(() => "");
      if (run.code !== 0 || !text.trim()) {
        const why = lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.code}`;
        throw new CloudError(`Codex couldn't answer: ${why}`);
      }
      return { text };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
