import { AntigravityCliProvider } from "@/lib/llm/antigravity";
import { AnthropicApiProvider, API_CLAUDE_MODELS, OpenAiCompatibleProvider } from "@/lib/llm/api";
import { MisconfiguredProvider } from "@/lib/llm/base";
import { ClaudeCliProvider, cliConfigFromEnv } from "@/lib/llm/cli";
import { CodexCliProvider } from "@/lib/llm/codex";
import { detectAntigravity } from "@/lib/llm/detect";
import { FakeProvider } from "@/lib/llm/fake";
import { LocalProvider } from "@/lib/llm/local";
import type { LlmProvider } from "@/lib/llm/provider";
import { API_SERVICES } from "@/lib/modes";
import { getApiKey, getSettings } from "@/lib/settings";

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

/**
 * The cloud AI Settings have chosen for "auto" mode: Claude Code, ChatGPT Codex, Google
 * Antigravity, or a service reached with an API key. Read at the start of each job, so
 * a change in Settings applies to the next one.
 */
export async function cloudProvider(): Promise<LlmProvider> {
  if (isFake()) return getProvider();
  const s = await getSettings();
  switch (s.cloudEngine) {
    case "codex":
      return new CodexCliProvider(process.env.LOCKIN_CODEX_BIN ?? "codex", s.codexModel.trim());
    case "antigravity":
      return new AntigravityCliProvider((await detectAntigravity()).binary, s.agyModel.trim());
    case "api": {
      const key = await getApiKey();
      const service = API_SERVICES[s.apiService];
      if (s.apiService === "anthropic") {
        return key
          ? new AnthropicApiProvider(key, API_CLAUDE_MODELS[s.cloudModel])
          : new MisconfiguredProvider("Anthropic API", "Add your Anthropic API key in Settings");
      }
      const base = s.apiService === "custom" ? s.apiBaseUrl.trim() : service.baseUrl;
      if (!base) return new MisconfiguredProvider(service.label, "Add the service's address in Settings");
      // A service on this computer (Ollama, LM Studio) may need no key.
      if (!key && s.apiService !== "custom") {
        return new MisconfiguredProvider(service.label, `Add your ${service.label} API key in Settings`);
      }
      const name = s.apiService === "custom" ? hostOf(base) : service.label;
      return new OpenAiCompatibleProvider(name, base, key ?? "", s.apiModel.trim(), s.apiVision);
    }
    default:
      return getProvider(s.cloudModel);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "API";
  }
}

/** A provider for a downloaded model. Kept while the same model stays selected, so it loads once. */
export function getLocalProvider(modelPath: string, modelName: string, modelId: string): LlmProvider {
  if (isFake()) return getProvider();
  if (!local || local.name !== `local:${modelName}`) local = new LocalProvider(modelPath, modelName, modelId);
  return local;
}

export type { LlmProvider } from "@/lib/llm/provider";
