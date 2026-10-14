import { ClaudeCliProvider, cliConfigFromEnv } from "@/lib/llm/cli";
import { FakeProvider } from "@/lib/llm/fake";
import { LocalProvider } from "@/lib/llm/local";
import type { LlmProvider } from "@/lib/llm/provider";

/**
 * The seam. Everything else in the app depends on LlmProvider, never on an adapter.
 * `cli` runs against a personal Claude subscription; `fake` returns canned output for
 * development (and stands in for every mode when LOCKIN_PROVIDER=fake); a local
 * provider runs a downloaded model; `api` (metered Anthropic SDK) is what this
 * switches to the day it runs for anyone but its author.
 */

/** One Claude Code provider per model, so a change in Settings takes effect at the next job. */
const claude = new Map<string, LlmProvider>();
let local: LocalProvider | undefined;

export function isFake(): boolean {
  return process.env.LOCKIN_PROVIDER === "fake";
}

/** The Claude Code provider for a model ("sonnet", "opus"…), or the fake one when the
 *  environment asks for it. */
export function getProvider(model?: string): LlmProvider {
  const kind = process.env.LOCKIN_PROVIDER ?? "cli";
  const key = kind === "fake" ? "fake" : (model ?? "");
  const cached = claude.get(key);
  if (cached) return cached;
  switch (kind) {
    case "cli": {
      const cfg = cliConfigFromEnv();
      const provider = new ClaudeCliProvider(model ? { ...cfg, model } : cfg);
      claude.set(key, provider);
      return provider;
    }
    case "fake": {
      const provider = new FakeProvider();
      claude.set(key, provider);
      return provider;
    }
    case "api":
      throw new Error("the Anthropic SDK adapter is not built yet — set LOCKIN_PROVIDER=cli");
    default:
      throw new Error(`unknown LOCKIN_PROVIDER "${kind}"`);
  }
}

/** A provider for a downloaded model. Kept while the same model stays selected, so it loads once. */
export function getLocalProvider(modelPath: string, modelName: string): LlmProvider {
  if (isFake()) return getProvider();
  if (!local || local.name !== `local:${modelName}`) local = new LocalProvider(modelPath, modelName);
  return local;
}

export type { LlmProvider } from "@/lib/llm/provider";
