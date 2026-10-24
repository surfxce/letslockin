"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import "@/app/ui/desktop";
import { Icon } from "@/app/ui/Icon";
import { sayAnswer, skipQuestion, stopViva } from "@/app/viva/actions";
import type { VivaTurn } from "@/lib/viva/schema";
import { say, stopSaying } from "@/lib/voice/say";
import { downsample, encodeWav, joinChunks } from "@/lib/viva/wav";

interface State {
  waitingOn: string;
  current: number;
  total: number;
  turns: VivaTurn[];
  error: string | null;
}

const READ_ALOUD = "lockin.viva.readAloud";


/** Records from the microphone as plain samples, so the answer can go out as WAV. */
function useRecorder() {
  const parts = useRef<{ stream: MediaStream; context: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[] } | null>(null);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const started = useRef(0);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i] * data[i];
      setLevel(Math.min(1, Math.sqrt(sum / (data.length / 16)) * 6));
      setSeconds(Math.floor((Date.now() - started.current) / 1000));
    };
    source.connect(node);
    node.connect(context.destination);
    started.current = Date.now();
    setSeconds(0);
    parts.current = { stream, context, node, chunks };
  }, []);

  const stop = useCallback(async (): Promise<ArrayBuffer | null> => {
    const p = parts.current;
    parts.current = null;
    setLevel(0);
    if (!p) return null;
    p.node.disconnect();
    p.stream.getTracks().forEach((t) => t.stop());
    const rate = p.context.sampleRate;
    await p.context.close();
    const samples = joinChunks(p.chunks);
    return samples.length > rate / 2 ? encodeWav(downsample(samples, rate)) : null;
  }, []);

  useEffect(() => () => void stop(), [stop]);
  return { start, stop, level, seconds };
}

/** The viva itself: the examiner's lines, read aloud, and your answers, spoken or typed. */
export function VivaRoom({
  vivaId,
  title,
  initial,
  speech,
  canSpeak,
  stageLabels,
}: {
  vivaId: string;
  title: string;
  /** A clinical case: what each stage is about ("History", "Investigations"…). */
  stageLabels?: string[];
  initial: State;
  speech: string | null;
  /** A Qwen voice is downloaded to read the examiner's lines (Settings → Viva voice). */
  canSpeak: boolean;
}) {
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // Said in the Qwen voice from Settings; if it can't, why is shown once — there's no other voice.
  const speak = useCallback(
    (text: string) => {
      if (!canSpeak) {
        setVoiceNote((before) => before ?? "no Qwen voice is downloaded yet — get one in Settings → Viva voice.");
        return;
      }
      void say(text).then((failed) => {
        if (failed) setVoiceNote((before) => before ?? failed);
      });
    },
    [canSpeak],
  );
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<"sending" | "hearing" | null>(null);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [readAloud, setReadAloud] = useState(true);
  const recorder = useRecorder();
  const spoken = useRef(initial.turns.length - 1);
  const end = useRef<HTMLDivElement>(null);

  // Background refreshes must never disturb an answer being typed.
  useEffect(() => {
    window.__lockinHoldRefresh = true;
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- storage only exists after mount
      setReadAloud(localStorage.getItem(READ_ALOUD) !== "off");
    } catch {
      // Storage may be unavailable; reading aloud stays on.
    }
    return () => {
      window.__lockinHoldRefresh = false;
      stopSaying();
    };
  }, []);

  // Each new line from the examiner is read out, once — all of them when several come at
  // once, as a case's findings and then its next question do.
  useEffect(() => {
    const last = state.turns.length - 1;
    const turn = state.turns[last];
    if (last > spoken.current && turn?.role === "examiner") {
      const fresh = state.turns.slice(spoken.current + 1);
      const from = fresh.findLastIndex((t) => t.role === "student") + 1;
      spoken.current = last;
      if (readAloud) speak(fresh.slice(from).map((t) => t.text).join(" "));
    }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.turns, readAloud, speak]);

  // Read the first question once the page is open.
  useEffect(() => {
    const first = initial.turns.at(-1);
    if (first?.role === "examiner" && initial.waitingOn === "student") {
      const t = setTimeout(() => {
        try {
          if (localStorage.getItem(READ_ALOUD) === "off") return;
        } catch {
          // Read it anyway.
        }
        speak(first.text);
      }, 400);
      return () => clearTimeout(t);
    }
  }, [initial, speak]);

  // While the examiner thinks, keep looking.
  useEffect(() => {
    if (state.waitingOn !== "examiner") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/viva/${vivaId}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const next = (await res.json()) as State;
      setState(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [state.waitingOn, vivaId]);

  useEffect(() => {
    if (state.waitingOn === "done") {
      const t = setTimeout(() => router.refresh(), 2500);
      return () => clearTimeout(t);
    }
  }, [state.waitingOn, router]);

  async function refresh() {
    const res = await fetch(`/api/viva/${vivaId}`, { cache: "no-store" });
    if (res.ok) setState((await res.json()) as State);
  }

  async function send() {
    setNote(null);
    setBusy("sending");
    const result = await sayAnswer(vivaId, answer);
    setBusy(null);
    if (!result.ok) {
      setNote(result.message);
      return;
    }
    setAnswer("");
    await refresh();
  }

  async function toggleRecording() {
    setNote(null);
    if (recording) {
      setRecording(false);
      const wav = await recorder.stop();
      if (!wav) {
        setNote("That was too short to hear — try again.");
        return;
      }
      setBusy("hearing");
      const res = await fetch(`/api/viva/${vivaId}/listen`, { method: "POST", body: wav }).catch(() => null);
      const body = (await res?.json().catch(() => ({}))) as { text?: string; error?: string };
      setBusy(null);
      if (!res?.ok || !body.text) {
        setNote(body.error ?? "Nothing was heard — try again, or type it.");
        return;
      }
      setAnswer((prev) => (prev.trim() ? `${prev.trim()} ${body.text}` : body.text!));
      return;
    }
    stopSaying();
    if (window.lockin?.microphone) {
      const access = await window.lockin.microphone();
      if (access === "unavailable") {
        setNote("Answering out loud needs the latest Lockin.dmg (Settings → Updates). You can type for now.");
        return;
      }
      if (access === "denied") {
        setNote("Lockin isn't allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.");
        return;
      }
    }
    try {
      await recorder.start();
      setRecording(true);
    } catch {
      setNote("The microphone couldn't be opened. You can type your answer instead.");
    }
  }

  const done = state.waitingOn === "done";
  const thinking = state.waitingOn === "examiner";
  const number = Math.min(state.current + 1, state.total);

  return (
    <div className="viva-room">
      <div className="viva-head">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>
            {title}
          </h1>
          <div className="small muted">
            {done
              ? "Finished"
              : stageLabels
                ? `Stage ${number} of ${state.total}${stageLabels[number - 1] ? ` · ${stageLabels[number - 1]}` : ""}`
                : `Question ${number} of ${state.total}`}
          </div>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className={`btn sm${readAloud ? "" : " quiet"}`}
          aria-pressed={readAloud}
          title="Read the examiner's questions aloud"
          onClick={() => {
            const next = !readAloud;
            setReadAloud(next);
            if (!next) stopSaying();
            try {
              localStorage.setItem(READ_ALOUD, next ? "on" : "off");
            } catch {
              // Not remembered; fine.
            }
          }}
        >
          <Icon name="volume" size={14} /> {readAloud ? "Reading aloud" : "Read aloud off"}
        </button>
        {!done && (
          <button
            type="button"
            className="btn sm quiet"
            onClick={async () => {
              if (!confirm(`End the ${stageLabels ? "case" : "viva"} now? What you've answered is marked.`)) return;
              await stopViva(vivaId, state.waitingOn === "student" ? answer : "");
              setAnswer("");
              await refresh();
            }}
          >
            {stageLabels ? "End case" : "End viva"}
          </button>
        )}
      </div>
      {voiceNote && (
        <p className="small muted" role="status" style={{ margin: "-6px 0 0" }}>
          The examiner can&apos;t be read aloud: {voiceNote}
        </p>
      )}

      <div className="viva-turns">
        {state.turns.map((t, i) => (
          <div key={i} className={`viva-turn ${t.role}`}>
            <div className="viva-who">{t.role === "examiner" ? "Examiner" : "You"}</div>
            <div className="viva-said">
              {t.text}
              {t.role === "examiner" && (
                <button type="button" className="viva-replay" title="Hear it again" onClick={() => speak(t.text)}>
                  <Icon name="volume" size={13} />
                </button>
              )}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="viva-turn examiner">
            <div className="viva-who">Examiner</div>
            <div className="viva-said viva-thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {state.error && thinking && <p className="small error-text">The examiner couldn&apos;t answer: {state.error}</p>}
        <div ref={end} className="viva-end" />
      </div>

      {done ? (
        <div className="callout blue">Done — your answers are being marked. The results appear here in a moment.</div>
      ) : (
        <div className="viva-compose">
          <div className="viva-controls">
            {speech && (
              <button
                type="button"
                className={`viva-mic${recording ? " on" : ""}`}
                disabled={thinking || busy !== null}
                onClick={toggleRecording}
                aria-label={recording ? "Stop and hear my answer" : "Answer out loud"}
                style={recording ? { boxShadow: `0 0 0 ${4 + recorder.level * 14}px var(--t-red-bg)` } : undefined}
              >
                <Icon name={recording ? "square" : "mic"} size={22} />
              </button>
            )}
            <div className="small muted viva-hint">
              {recording
                ? `Listening… ${recorder.seconds}s — press again when you're done`
                : busy === "hearing"
                  ? `Turning what you said into text (${speech})…`
                  : thinking
                    ? "The examiner is thinking…"
                    : speech
                      ? "Press the microphone and answer out loud, or type below. Check the words before you send."
                      : "Type your answer. (Answering out loud needs Whisper, which comes with the latest Lockin.dmg, or Gemini as your AI.)"}
            </div>
          </div>
          <textarea
            className="viva-answer"
            rows={4}
            value={answer}
            disabled={thinking}
            placeholder={thinking ? "" : "Your answer…"}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && answer.trim()) void send();
            }}
          />
          <div className="row">
            <button type="button" className="btn primary" disabled={thinking || busy !== null || recording || !answer.trim()} onClick={send}>
              {busy === "sending" ? "Sending…" : "Send answer"}
            </button>
            <button
              type="button"
              className="btn quiet"
              disabled={thinking || busy !== null || recording}
              onClick={async () => {
                setAnswer("");
                await skipQuestion(vivaId);
                await refresh();
              }}
            >
              {state.turns.some((t) => t.role === "student" && t.questionId === state.turns.at(-1)?.questionId) ? "Move on" : "I don't know — skip"}
            </button>
            <span className="small faint">⌘ Enter sends</span>
          </div>
          {note && <p className="small error-text">{note}</p>}
        </div>
      )}
    </div>
  );
}
