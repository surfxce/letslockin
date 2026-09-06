import { ClaudeCliProvider } from "@/lib/llm/cli";
import type { LlmProvider } from "@/lib/llm/provider";

let cached: LlmProvider | undefined;

/**
 * The seam. Everything else in the app depends on LlmProvider, never on an adapter.
 * `cli` runs against a personal Claude subscription; `api` (metered Anthropic SDK)
 * is what this switches to the day it runs for anyone but its author.
 */
export function getProvider(): LlmProvider {
  if (cached) return cached;
  const kind = process.env.LOCKIN_PROVIDER ?? "cli";
  switch (kind) {
    case "cli":
      cached = new ClaudeCliProvider();
      return cached;
    case "api":
      throw new Error("the Anthropic SDK adapter is not built yet — set LOCKIN_PROVIDER=cli");
    default:
      throw new Error(`unknown LOCKIN_PROVIDER "${kind}"`);
  }
}

export type { LlmProvider } from "@/lib/llm/provider";
