/**
 * Who reads the viva examiner's lines: a Qwen3-TTS voice, run on this Mac (through the
 * speech helper, TTSKit). Nothing else — the Mac's own voices are never used. Client-safe.
 */

/** Qwen3-TTS CustomVoice's speakers. Aiden and Ryan are native English speakers; the
 *  others speak English with their own accent. */
export const QWEN_VOICES = [
  { id: "aiden", label: "Aiden", about: "sunny, clear American man" },
  { id: "ryan", label: "Ryan", about: "lively man with a strong rhythm" },
  { id: "serena", label: "Serena", about: "warm, gentle woman" },
  { id: "vivian", label: "Vivian", about: "bright young woman" },
  { id: "sohee", label: "Sohee", about: "warm woman, full of feeling" },
  { id: "ono-anna", label: "Ono Anna", about: "playful, light woman" },
  { id: "eric", label: "Eric", about: "lively man, slightly husky" },
  { id: "dylan", label: "Dylan", about: "young man, clear and natural" },
  { id: "uncle-fu", label: "Uncle Fu", about: "older man, low and mellow" },
] as const;
export type QwenVoice = (typeof QWEN_VOICES)[number]["id"];

/** The two sizes of Qwen3-TTS CustomVoice the helper runs. */
export const QWEN_MODELS = [
  {
    id: "1.7b",
    label: "Qwen3-TTS 1.7B",
    size: "about 2.2 GB",
    about: "The most natural, and speaks in the style you describe. Takes a moment longer per line.",
  },
  { id: "0.6b", label: "Qwen3-TTS 0.6B", size: "about 1 GB", about: "Quicker, a little less expressive. No speaking style." },
] as const;
export type QwenModel = (typeof QWEN_MODELS)[number]["id"];

export const DEFAULT_STYLE = "Calm, clear and friendly, like a kind examiner, at a natural conversational pace.";
/** The first default, whose "unhurried" made the 1.7B drag lines out until they were cut off. */
const OLD_DEFAULT_STYLE = "Calm, clear and friendly, like a kind examiner, at an unhurried pace.";

export function readVoice(raw: unknown): QwenVoice {
  // Before only Qwen was offered, choices were stored as "natural:<id>", "system:…" or "auto".
  const id = typeof raw === "string" ? raw.replace(/^natural:/, "") : "";
  return QWEN_VOICES.find((v) => v.id === id)?.id ?? "aiden";
}

export function readModel(raw: unknown): QwenModel {
  return raw === "0.6b" ? "0.6b" : "1.7b";
}

export function readStyle(raw: unknown): string {
  const style = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return style && style !== OLD_DEFAULT_STYLE ? style : DEFAULT_STYLE;
}

/**
 * The model a line is said with: the one chosen when it's downloaded, else the other
 * one if that is, else none.
 */
export function usableModel(chosen: QwenModel, ready: Record<QwenModel, boolean>): QwenModel | null {
  if (ready[chosen]) return chosen;
  return QWEN_MODELS.find((m) => ready[m.id])?.id ?? null;
}
