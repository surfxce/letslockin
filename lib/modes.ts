/**
 * How Lockin gets its summaries, LAQs and marks. Client-safe.
 *  - auto: Claude Code on this computer, through the worker.
 *  - local: a model downloaded to this computer, through the worker. Fully offline.
 *  - manual: copy a prompt into any AI chat and paste the reply back. Nothing runs here.
 */
export type Mode = "auto" | "local" | "manual";

export const MODE_LABEL: Record<Mode, string> = {
  auto: "Claude Code",
  local: "On this computer",
  manual: "Copy & paste",
};

/** Whether the worker does the AI part, so "Prepare with AI" and marking apply. */
export function usesAi(mode: Mode): boolean {
  return mode !== "manual";
}

/**
 * Which Claude does the work in "auto" mode, by Claude Code's own names for the
 * latest of each — so a new release is picked up without a change here.
 */
export type CloudModel = "sonnet" | "opus" | "haiku";

export const CLOUD_MODELS: CloudModel[] = ["sonnet", "opus", "haiku"];

export const CLOUD_MODEL_LABEL: Record<CloudModel, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

/**
 * How LAQs are written. "story" sets each question in a short scenario ("Jane eats
 * porridge at 7am, skips lunch…"); "facts" asks straight out; "mixed" leaves it to
 * the examiner's judgement, as the prompts always have.
 */
export type LaqStyle = "mixed" | "story" | "facts";

export const LAQ_STYLES: LaqStyle[] = ["mixed", "story", "facts"];

export const LAQ_STYLE_LABEL: Record<LaqStyle, string> = {
  mixed: "Mixed",
  story: "Story",
  facts: "Facts",
};

/** The most LAQs per lecture hour either setting allows. */
export const MAX_PER_HOUR = 8;

/** A per-hour count from a form or a hand-edited setting: a whole number, 1 to MAX_PER_HOUR. */
export function perHour(raw: unknown, fallback = 2): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_PER_HOUR, n) : fallback;
}

/** What the LAQ prompts say about style, in Claude's prompt and in the copy-and-paste one. */
export function laqStyleNote(style: LaqStyle | undefined): string {
  if (style === "story") {
    return (
      "\nSet every question in a short scenario: a named person in a concrete situation, such as what they " +
      "eat and when, a run, a night without sleep, a symptom or a patient presenting. For example: \"Jane eats " +
      "porridge at 7am, skips lunch and runs 5 km at 5pm. Explain how insulin and glucagon coordinate her energy " +
      "storage and release across liver, muscle and adipose tissue.\" One or two sentences of scenario, then an " +
      "ask that still needs the lecture's mechanisms to answer well.\n"
    );
  }
  if (style === "facts") {
    return (
      "\nAsk straight out, with no scenario or story: name the topic and say exactly what to describe, explain, " +
      "compare or evaluate. For example: \"Describe how insulin is synthesised and how it promotes glucose uptake " +
      "into skeletal muscle. Compare GLUT4 with GLUT1 and GLUT3, and explain the role of GLUT2 in pancreatic " +
      "beta-cells.\" Several linked parts in one question are good.\n"
    );
  }
  return "";
}

/**
 * Which cloud AI does the work in "auto" mode: a command-line tool signed in with the
 * student's own plan, or an API key.
 */
export type CloudEngine = "claude" | "codex" | "antigravity" | "api";

export const CLOUD_ENGINES: CloudEngine[] = ["claude", "codex", "antigravity", "api"];

export const CLOUD_ENGINE_LABEL: Record<CloudEngine, string> = {
  claude: "Claude Code",
  codex: "ChatGPT Codex",
  antigravity: "Google Antigravity",
  api: "API key",
};

/** Services an API key can be for. All but Anthropic speak OpenAI's chat format. */
export type ApiService = "anthropic" | "openai" | "gemini" | "openrouter" | "groq" | "custom";

export const API_SERVICES: Record<
  ApiService,
  { label: string; baseUrl: string; keys: string; modelHint: string }
> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "", keys: "console.anthropic.com", modelHint: "" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keys: "platform.openai.com/api-keys", modelHint: "a GPT model name from OpenAI's model list" },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keys: "aistudio.google.com/apikey",
    modelHint: "a Gemini model name from Google AI Studio",
  },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keys: "openrouter.ai/keys", modelHint: "a model id from openrouter.ai/models, such as provider/model" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keys: "console.groq.com/keys", modelHint: "a model id from console.groq.com" },
  custom: { label: "Another service", baseUrl: "", keys: "", modelHint: "the model name the service expects" },
};

export const API_SERVICE_LIST = Object.keys(API_SERVICES) as ApiService[];
