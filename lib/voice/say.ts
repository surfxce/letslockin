"use client";

import type { QwenModel, QwenVoice } from "@/lib/voice/choice";

/**
 * Speaks a line in a Qwen voice, fetched from this computer as audio. Saying something
 * new stops what was being said. There is no other voice: if Qwen can't say it, the
 * reason comes back to be shown.
 */

let audio: HTMLAudioElement | null = null;
let token = 0;

export function stopSaying() {
  token++;
  audio?.pause();
  audio = null;
}

/** Null once it's playing; otherwise why it couldn't. Unset options come from Settings. */
export async function say(text: string, opts: { voice?: QwenVoice; model?: QwenModel; style?: string } = {}): Promise<string | null> {
  stopSaying();
  const mine = ++token;
  try {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...opts }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `the computer answered ${res.status}`);
    }
    const url = URL.createObjectURL(await res.blob());
    if (mine !== token) {
      URL.revokeObjectURL(url);
      return null;
    }
    audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    return null;
  } catch (err) {
    return mine === token ? (err instanceof Error ? err.message : String(err)) : null;
  }
}
