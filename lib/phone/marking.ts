import { API_CLAUDE_MODELS } from "@/lib/llm/api";
import { loadPrompt } from "@/lib/llm/prompts";
import { API_SERVICES } from "@/lib/modes";
import { phoneMayMarkWithKey } from "@/lib/phone/pairing";
import { getApiKey, getSettings } from "@/lib/settings";

/**
 * How the phone may mark an answer itself, away from the computer: only when Lockin
 * marks with an API key (a command-line tool or a model on this computer can't run on
 * a phone), and only while Settings allow the key to go to the phone.
 *
 * The phone is handed the marking prompt (the same file, so the same version) and a
 * ready request to the same service and model, with {{LOCKIN_PROMPT}} where the
 * filled-in prompt goes. Its marks are checked again here before they are saved.
 */
export interface PhoneMarkingTemplate {
  /** How to read the reply. */
  kind: "anthropic" | "openai";
  /** For the phone to show: "Anthropic API · claude-sonnet-5-5". */
  label: string;
  /** e.g. "mark@1.0.0", stamped on the marks as the computer's would be. */
  promptVersion: string;
  /** The marking prompt with {{questionStem}}, {{rubric}}, {{answerText}}, {{concepts}}. */
  prompt: string;
  request: { url: string; headers: Record<string, string>; body: unknown };
}

export const PROMPT_SLOT = "{{LOCKIN_PROMPT}}";

/** Addresses only this computer can reach: a phone asking them would reach itself. */
function onThisComputer(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.") || host === "0.0.0.0";
  } catch {
    return true;
  }
}

export async function phoneMarkingTemplate(): Promise<PhoneMarkingTemplate | null> {
  const s = await getSettings();
  if (s.mode !== "auto" || s.cloudEngine !== "api" || !(await phoneMayMarkWithKey())) return null;
  const key = await getApiKey();
  const { text, version } = await loadPrompt("mark");
  const promptVersion = `mark@${version}`;

  if (s.apiService === "anthropic") {
    if (!key) return null;
    const model = API_CLAUDE_MODELS[s.cloudModel];
    // As lib/llm/api.ts asks, but without streaming: a mark is short, and a phone can
    // wait for one reply. Haiku has no refusal fallback.
    const fallback = model !== API_CLAUDE_MODELS.haiku;
    return {
      kind: "anthropic",
      label: `Anthropic API · ${model}`,
      promptVersion,
      prompt: text,
      request: {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        },
        body: {
          model,
          max_tokens: 16000,
          output_config: { effort: "medium" },
          messages: [{ role: "user", content: [{ type: "text", text: PROMPT_SLOT }] }],
          ...(fallback ? { fallbacks: "default" } : {}),
        },
      },
    };
  }

  const service = API_SERVICES[s.apiService];
  const base = (s.apiService === "custom" ? s.apiBaseUrl : service.baseUrl).trim().replace(/\/+$/, "");
  const model = s.apiModel.trim();
  if (!base || !model || onThisComputer(base)) return null;
  if (!key && s.apiService !== "custom") return null;
  let name = service.label;
  if (s.apiService === "custom") {
    try {
      name = new URL(base).host;
    } catch {
      name = "API";
    }
  }
  return {
    kind: "openai",
    label: `${name} · ${model}`,
    promptVersion,
    prompt: text,
    request: {
      url: `${base}/chat/completions`,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: { model, messages: [{ role: "user", content: PROMPT_SLOT }] },
    },
  };
}
