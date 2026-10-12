import { ClaudeCliProvider } from "@/lib/llm/cli";
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

let claude: LlmProvider | undefined;
let local: LocalProvider | undefined;

export function isFake(): boolean {
  return process.env.LOCKIN_PROVIDER === "fake";
}

/** The Claude Code provider, or the fake one when the environment asks for it. */
export function getProvider(): LlmProvider {
  if (claude) return claude;
  const kind = process.env.LOCKIN_PROVIDER ?? "cli";
  switch (kind) {
    case "cli":
      claude = new ClaudeCliProvider();
      return claude;
    case "fake":
      claude = new FakeProvider();
      return claude;
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
