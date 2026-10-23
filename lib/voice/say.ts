"use client";

import { goodVoices, type VoiceChoice } from "@/lib/voice/choice";

/**
 * Speaks a line in the chosen voice: the natural voice (fetched from this computer as
 * audio), or one of the browser's own. Saying something new stops what was being said.
 */

let audio: HTMLAudioElement | null = null;
let token = 0;

export function stopSaying() {
  token++;
  audio?.pause();
  audio = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** The system voice for a choice: the one named, else the best English one. */
export function systemVoice(choice: VoiceChoice): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (choice.startsWith("system:")) {
    const named = voices.find((v) => v.voiceURI === choice.slice(7) || v.name === choice.slice(7));
    if (named) return named;
  }
  return goodVoices(voices, navigator.language)[0] ?? null;
}

function speakSystem(text: string, choice: VoiceChoice) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = systemVoice(choice);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    // No English voice to be sure of yet (they load late): let the system decide.
    utterance.lang = "en-GB";
  }
  window.speechSynthesis.speak(utterance);
}

/**
 * `natural` says whether the natural voice is downloaded; "auto" uses it then. If it
 * fails (still loading the first time, or gone), the system voice says it instead.
 */
export async function say(text: string, choice: VoiceChoice, natural: boolean): Promise<void> {
  stopSaying();
  const mine = ++token;
  const voice = choice.startsWith("natural:") ? choice.slice(8) : choice === "auto" && natural ? "aiden" : null;
  if (voice) {
    try {
      const res = await fetch("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }) });
      if (!res.ok) throw new Error(await res.text());
      const url = URL.createObjectURL(await res.blob());
      if (mine !== token) return URL.revokeObjectURL(url);
      audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      return;
    } catch {
      if (mine !== token) return;
    }
  }
  speakSystem(text, choice);
}
