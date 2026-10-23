"use client";

import { useState, useTransition } from "react";

import { setWhisperModel } from "@/app/actions";
import { WHISPER_MODELS, type WhisperChoice } from "@/lib/modes";

/** How lecture recordings become transcripts, and which Whisper model does it. */
export function RecordingSettings({ model, gemini, helper }: { model: WhisperChoice; gemini: string | null; helper: boolean }) {
  const [choice, setChoice] = useState(model);
  const [, start] = useTransition();
  return (
    <>
      <div className="setting">
        <div>
          <div className="st">How recordings are transcribed</div>
          <div className="sd">
            {gemini
              ? `Your AI is ${gemini}, so a recording goes straight to Gemini, which listens and writes the transcript. If that fails, Whisper does it here.`
              : "Whisper transcribes recordings on this Mac — free and offline. Then your AI reads the transcript beside the slides and corrects the technical words Whisper misheard."}
          </div>
          {!helper && (
            <div className="sd" style={{ marginTop: 4 }}>
              Whisper comes with the Mac app: install the latest Lockin.dmg (Settings → Updates) to transcribe here.
            </div>
          )}
        </div>
      </div>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">Whisper model</div>
          <div className="sd">
            {choice === "accurate"
              ? `Gets more technical words right; about 5 minutes for an hour's lecture on a recent Mac. Downloads ${WHISPER_MODELS.accurate.size} the first time.`
              : `About twice as fast, with more misheard words for the AI to fix. Downloads ${WHISPER_MODELS.fast.size} the first time.`}
          </div>
        </div>
        <div className="seg" role="radiogroup" aria-label="Whisper model">
          {(Object.keys(WHISPER_MODELS) as WhisperChoice[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={choice === m}
              className={choice === m ? "on" : undefined}
              onClick={() => {
                setChoice(m);
                start(() => setWhisperModel(m));
              }}
            >
              {WHISPER_MODELS[m].label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
