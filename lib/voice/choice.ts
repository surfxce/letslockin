/**
 * Which voice reads the viva examiner's lines. Client-safe.
 *
 * "auto" uses the natural voice when it's downloaded, otherwise the best of this
 * computer's own voices — never one of the Mac's novelty voices ("Bad News", "Albert",
 * "Zarvox"…), which is what made the examiner sound possessed.
 */
export type VoiceChoice = "auto" | `natural:${string}` | `system:${string}`;

/** The natural voices that speak English natively (Qwen3-TTS). */
export const NATURAL_VOICES = [
  { id: "aiden", label: "Aiden", about: "warm, clear, American" },
  { id: "ryan", label: "Ryan", about: "lively, energetic" },
] as const;

/** macOS novelty and old-synthesiser voices: never chosen automatically, hidden from the list. */
const NOVELTY = new Set(
  [
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Deranged", "Good News", "Hysterical", "Jester",
    "Organ", "Pipe Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Kathy", "Ralph",
    "Agnes", "Bruce", "Princess", "Vicki", "Victoria", "Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley",
  ].map((n) => n.toLowerCase()),
);

const baseName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();

export function isNovelty(voice: { name: string }): boolean {
  return NOVELTY.has(baseName(voice.name));
}

/** How natural a system voice is likely to sound: higher is better. */
export function voiceScore(voice: { name: string; lang: string; localService?: boolean; default?: boolean }, locale = "en-GB"): number {
  if (!voice.lang.toLowerCase().startsWith("en") || isNovelty(voice)) return -1;
  let score = 0;
  if (/premium/i.test(voice.name)) score += 40;
  else if (/enhanced/i.test(voice.name)) score += 25;
  if (/google/i.test(voice.name)) score += 10;
  if (voice.lang.replace("_", "-").toLowerCase() === locale.toLowerCase()) score += 6;
  if (voice.default) score += 3;
  if (voice.localService) score += 1;
  return score;
}

/** English system voices worth offering, best first. */
export function goodVoices<T extends { name: string; lang: string; localService?: boolean; default?: boolean }>(voices: T[], locale?: string): T[] {
  return voices
    .map((v) => ({ v, s: voiceScore(v, locale) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

export function readChoice(raw: unknown): VoiceChoice {
  return typeof raw === "string" && (raw === "auto" || /^(natural|system):.+/.test(raw)) ? (raw as VoiceChoice) : "auto";
}
