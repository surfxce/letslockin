import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";

import { jobSignal, timeoutOrCancel } from "@/lib/llm/cancel";
import {
  CloudError,
  decksNote,
  isQuick,
  picturesNote,
  PromptProvider,
  slidePictures,
  type CallOptions,
  type Reply,
} from "@/lib/llm/base";
import type { CloudModel } from "@/lib/modes";

const TIMEOUT_MS = Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000);

/** Claude on the API, by the same names Settings uses for Claude Code. */
export const API_CLAUDE_MODELS: Record<CloudModel, string> = {
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
};

/** A request is limited to 32 MB; past this the decks go as their text alone. */
const MAX_PDF_BYTES = 24 * 1024 * 1024;

/**
 * Claude through the Anthropic API with the student's own key, billed per use. The
 * slide decks are attached as PDFs, which Claude reads page by page, pictures and all.
 */
export class AnthropicApiProvider extends PromptProvider {
  readonly name = "anthropic-api";
  readonly seesSlides = true;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    super();
    this.client = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
    this.lastModel = this.label();
  }

  protected label(model?: string | null) {
    return `Anthropic API · ${model || this.model}`;
  }

  protected async complete(prompt: string, opts: CallOptions): Promise<Reply> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    let note = "";
    if (opts.slides) {
      const pdfs = opts.slides.decks.filter((d) => d.pdf && d.pages > 0);
      const files = await Promise.all(pdfs.map((d) => readFile(d.file)));
      if (files.reduce((n, f) => n + f.length, 0) <= MAX_PDF_BYTES) {
        for (const f of files) {
          content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.toString("base64") } });
        }
        note = decksNote(opts.slides);
      }
    }
    content.push({ type: "text", text: prompt + note });

    // Haiku has no server-side refusal fallback; Sonnet and Opus fall back to another
    // model on a policy decline rather than stopping the job.
    const fallback = this.model !== API_CLAUDE_MODELS.haiku;
    try {
      const message = await this.client.beta.messages
        .stream(
          {
            model: this.model,
            max_tokens: isQuick(opts.task) ? 8000 : 64000,
            output_config: { effort: isQuick(opts.task) ? "low" : "medium" },
            messages: [{ role: "user", content }],
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: jobSignal() },
        )
        .finalMessage();
      if (message.stop_reason === "refusal") {
        throw new CloudError(`Claude declined this: ${message.stop_details?.explanation ?? "no reason given"}`);
      }
      if (message.stop_reason === "max_tokens") throw new CloudError("Claude's reply was cut off before it finished");
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, model: message.model };
    } catch (err) {
      if (err instanceof CloudError) throw err;
      if (err instanceof Anthropic.AuthenticationError) {
        throw new CloudError("The Anthropic API key was refused — check it in Settings");
      }
      if (err instanceof Anthropic.PermissionDeniedError) {
        throw new CloudError("This Anthropic API key isn't allowed to use that model");
      }
      if (err instanceof Anthropic.RateLimitError) throw new CloudError("The Anthropic API is rate limiting this key — try again shortly");
      if (err instanceof Anthropic.APIError) {
        throw new CloudError(`The Anthropic API said ${err.status ?? "no status"}: ${err.message}`);
      }
      throw new CloudError(`Couldn't reach the Anthropic API: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Any service that speaks OpenAI's chat format — OpenAI itself, Google Gemini,
 * OpenRouter, Groq, or one running on this computer — with the student's key. A model
 * that takes images gets the slides as pictures.
 */
export class OpenAiCompatibleProvider extends PromptProvider {
  readonly name = "openai-compatible";

  constructor(
    private readonly service: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    readonly seesSlides: boolean,
  ) {
    super();
    this.lastModel = this.label();
  }

  protected label(model?: string | null) {
    return `${this.service} · ${model || this.model}`;
  }

  protected async complete(prompt: string, opts: CallOptions): Promise<Reply> {
    if (!this.model) throw new CloudError(`Choose which ${this.service} model to use, in Settings`);
    const pictures = opts.slides && this.seesSlides ? await slidePictures(opts.slides) : [];
    const total = opts.slides?.decks.reduce((n, d) => n + (d.pdf ? d.pages : 0), 0) ?? 0;
    const content = pictures.length
      ? [
          { type: "text", text: prompt + picturesNote(pictures, total) },
          ...(await Promise.all(
            pictures.map(async (p) => ({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${(await readFile(p.file)).toString("base64")}` },
            })),
          )),
        ]
      : prompt;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content }] }),
        signal: timeoutOrCancel(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudError(`Couldn't reach ${this.service}: ${err instanceof Error ? err.message : err}`);
    }
    const body = (await res.json().catch(() => null)) as {
      model?: string;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
      error?: { message?: string } | string;
    } | null;
    if (!res.ok || !body) {
      const why = typeof body?.error === "string" ? body.error : (body?.error?.message ?? res.statusText);
      const hint = res.status === 401 || res.status === 403 ? " — check the API key in Settings" : "";
      throw new CloudError(`${this.service} said ${res.status}: ${why}${hint}`);
    }
    const choice = body.choices?.[0];
    const raw = choice?.message?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => (p as { text?: string }).text ?? "").join("") : "";
    if (!text.trim()) throw new CloudError(`${this.service} sent back an empty reply`);
    if (choice?.finish_reason === "length") throw new CloudError(`${this.service}'s reply was cut off before it finished`);
    return { text, model: body.model ?? null };
  }
}
