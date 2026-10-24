"use client";

import { useEffect, useState, useTransition } from "react";

import { setVivaVoice, setVoiceModel, setVoiceStyle } from "@/app/actions";
import { QWEN_MODELS, QWEN_VOICES, readStyle, readVoice, usableModel, type QwenModel, type QwenVoice } from "@/lib/voice/choice";
import { say, stopSaying } from "@/lib/voice/say";
import type { NaturalStatus } from "@/lib/voice/natural";

/** Something any examiner might ask, whatever the subject. */
const SAMPLE = "Take me through your reasoning. What's the central idea here, and how would you explain it to someone hearing it for the first time?";

/** Who reads the viva examiner's lines: a Qwen3-TTS voice, which model, and how it speaks. */
export function VoicePicker({
  initial,
  status,
}: {
  initial: { voice: QwenVoice; model: QwenModel; style: string };
  status: NaturalStatus;
}) {
  const [voice, setVoice] = useState(initial.voice);
  const [model, setModel] = useState(initial.model);
  const [style, setStyle] = useState(initial.style);
  const [natural, setNatural] = useState(status);
  const [testing, setTesting] = useState<"saying" | { failed: string } | null>(null);
  const [, start] = useTransition();

  useEffect(() => () => stopSaying(), []);

  // While a model downloads, follow it.
  const downloading = QWEN_MODELS.some((m) => natural.downloading[m.id]?.running);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(async () => {
      const res = await fetch("/api/voice", { cache: "no-store" }).catch(() => null);
      if (res?.ok) setNatural((await res.json()) as NaturalStatus);
    }, 1500);
    return () => clearInterval(timer);
  }, [downloading]);

  async function download(id: QwenModel) {
    const res = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: id }) });
    const body = (await res.json()) as NaturalStatus & { error?: string };
    setNatural(body.error ? { ...natural, downloading: { ...natural.downloading, [id]: { progress: 0, error: body.error, running: false } } } : body);
  }

  async function test() {
    setTesting("saying");
    const failed = await say(SAMPLE, { voice, model, style });
    setTesting(failed ? { failed } : null);
  }

  const using = usableModel(model, natural.ready);
  const usingLabel = QWEN_MODELS.find((m) => m.id === using)?.label;

  if (!natural.helper) {
    return (
      <div className="setting">
        <div>
          <div className="st">Examiner&apos;s voice</div>
          <div className="sd">Qwen3-TTS voices run on this Mac and come with the Mac app: install the latest Lockin.dmg, then download one here.</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="st">Examiner&apos;s voice</div>
          <div className="sd">
            {using
              ? `Read by Qwen3-TTS on this Mac${using !== model ? ` (${usingLabel}, until the one you chose is downloaded)` : ""}. `
              : "Download a model below to hear the examiner. "}
            Aiden and Ryan are native English speakers; the others speak English with their own accent.
          </div>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <select
            value={voice}
            onChange={(e) => {
              const next = readVoice(e.target.value);
              setVoice(next);
              start(() => setVivaVoice(next));
            }}
            aria-label="Examiner's voice"
            style={{ width: 260 }}
          >
            {QWEN_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} — {v.about}
              </option>
            ))}
          </select>
          <button type="button" className="btn sm" disabled={!using || testing === "saying"} onClick={() => void test()}>
            {testing === "saying" ? "Starting…" : "Test"}
          </button>
        </div>
      </div>
      {testing === "saying" && (
        <p className="small muted" style={{ margin: "-6px 0 10px" }}>
          Starting the voice — the first line after it&apos;s been idle can take up to a minute while the model loads.
        </p>
      )}
      {testing && testing !== "saying" && (
        <p className="small error-text" role="alert" style={{ margin: "-6px 0 10px" }}>
          The voice didn&apos;t work: {testing.failed}
        </p>
      )}

      {QWEN_MODELS.map((m) => {
        const d = natural.downloading[m.id];
        const ready = natural.ready[m.id];
        return (
          <div key={m.id} className="setting">
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="radio"
                name="voice-model"
                checked={model === m.id}
                onChange={() => {
                  setModel(m.id);
                  start(() => setVoiceModel(m.id));
                }}
                style={{ marginTop: 3 }}
              />
              <div>
                <div className="st">
                  {m.label} <span className="small muted">· {m.size}</span>
                </div>
                <div className="sd">
                  {m.about}{" "}
                  {ready
                    ? "Downloaded."
                    : d?.running
                      ? `Downloading… ${Math.round((d.progress ?? 0) * 100)}%`
                      : d?.error
                        ? `The download stopped: ${d.error}`
                        : "Downloaded once, then it works offline."}
                </div>
              </div>
            </label>
            {!ready && (
              <button type="button" className="btn sm" disabled={!!d?.running} onClick={() => void download(m.id)}>
                {d?.running ? "Downloading…" : "Download"}
              </button>
            )}
          </div>
        );
      })}

      <div className="setting" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div className="st">Speaking style</div>
          <div className="sd">How the examiner speaks, in plain words. The 1.7B model follows it; the 0.6B can&apos;t.</div>
          <textarea
            value={style}
            rows={2}
            maxLength={300}
            disabled={using !== "1.7b"}
            onChange={(e) => setStyle(e.target.value)}
            onBlur={() => {
              const next = readStyle(style);
              setStyle(next);
              start(() => setVoiceStyle(next));
            }}
            style={{ width: "100%", marginTop: 8, fontSize: 14 }}
          />
        </div>
      </div>
    </>
  );
}
