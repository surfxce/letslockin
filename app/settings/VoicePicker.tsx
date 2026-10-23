"use client";

import { useEffect, useState, useTransition } from "react";

import { setVivaVoice } from "@/app/actions";
import { goodVoices, NATURAL_VOICES, readChoice, type VoiceChoice } from "@/lib/voice/choice";
import { say, stopSaying } from "@/lib/voice/say";
import type { NaturalStatus } from "@/lib/voice/natural";

const SAMPLE = "Explain how galactose-deficient IgA1 leads to mesangial injury, and what you'd expect to see in the urine.";

/** Who reads the viva examiner's lines: the natural voice, or one of this computer's own. */
export function VoicePicker({ initial, status }: { initial: string; status: NaturalStatus }) {
  const [choice, setChoice] = useState<VoiceChoice>(readChoice(initial));
  const [natural, setNatural] = useState(status);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [, start] = useTransition();

  // The browser lists its voices late, and says so with an event.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(goodVoices(window.speechSynthesis.getVoices(), navigator.language));
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      stopSaying();
    };
  }, []);

  // While the natural voice downloads, follow it.
  useEffect(() => {
    if (!natural.downloading?.running) return;
    const timer = setInterval(async () => {
      const res = await fetch("/api/voice", { cache: "no-store" }).catch(() => null);
      if (res?.ok) setNatural((await res.json()) as NaturalStatus);
    }, 1500);
    return () => clearInterval(timer);
  }, [natural.downloading?.running]);

  const pick = (next: VoiceChoice) => {
    setChoice(next);
    start(() => setVivaVoice(next));
  };

  async function download() {
    const res = await fetch("/api/voice", { method: "POST" });
    const body = (await res.json()) as NaturalStatus & { error?: string };
    setNatural(body.error ? { ...natural, downloading: { progress: 0, error: body.error, running: false } } : body);
  }

  const d = natural.downloading;
  return (
    <>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">Examiner&apos;s voice</div>
          <div className="sd">
            Reads the viva examiner&apos;s questions aloud. Automatic uses the natural voice once it&apos;s downloaded, otherwise the best of
            this Mac&apos;s own voices.
          </div>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <select value={choice} onChange={(e) => pick(readChoice(e.target.value))} aria-label="Examiner's voice" style={{ width: 220 }}>
            <option value="auto">Automatic</option>
            <optgroup label={natural.ready ? "Natural voice" : "Natural voice (download below)"}>
              {NATURAL_VOICES.map((v) => (
                <option key={v.id} value={`natural:${v.id}`} disabled={!natural.ready}>
                  {v.label} — {v.about}
                </option>
              ))}
            </optgroup>
            {voices.length > 0 && (
              <optgroup label="This computer's voices">
                {voices.map((v) => (
                  <option key={v.voiceURI} value={`system:${v.voiceURI}`}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" className="btn sm" onClick={() => void say(SAMPLE, choice, natural.ready)}>
            Test
          </button>
        </div>
      </div>
      <div className="setting">
        <div>
          <div className="st">Natural voice</div>
          <div className="sd">
            {natural.ready
              ? "Downloaded. A neural voice that runs on this Mac, offline — far more natural than the built-in ones. The first line after a while takes a few seconds to start."
              : !natural.helper
                ? "Comes with the Mac app: install the latest Lockin.dmg to download it."
                : d?.running
                  ? `Downloading… ${Math.round((d.progress ?? 0) * 100)}%`
                  : d?.error
                    ? `The download stopped: ${d.error}`
                    : "A neural voice (Qwen3-TTS) that runs on this Mac, offline. About 1 GB, downloaded once. Needs macOS 15 or later."}
          </div>
          {!natural.ready && (
            <div className="sd faint" style={{ marginTop: 4 }}>
              Or download Apple&apos;s better voices for free: System Settings → Accessibility → Spoken Content → System voice → Manage Voices, and
              pick a (Premium) English voice. They then show in the list above.
            </div>
          )}
        </div>
        {natural.helper && !natural.ready && (
          <button type="button" className="btn sm" disabled={!!d?.running} onClick={download}>
            {d?.running ? "Downloading…" : "Download"}
          </button>
        )}
      </div>
    </>
  );
}
