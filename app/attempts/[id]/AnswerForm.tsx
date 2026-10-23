"use client";

import "./attempt.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { saveAnswerDraft, submitAttempt, type Result } from "@/app/actions";
import "@/app/ui/desktop";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { HandwritingButton, HandwritingNote, selectIn, withHandwriting, type HandwritingResult } from "@/app/ui/Handwriting";
import { Markdown } from "@/app/ui/render";

/** How long typing pauses before an answer is saved to Lockin. */
const SAVE_AFTER_MS = 1000;

type SaveState = "saving" | "saved" | "local";

/**
 * One answer as kept in this browser: written on every keystroke, so it survives a
 * reload or a crash even when the save to Lockin does not. `savedAt` is set once
 * Lockin has this exact text; until then this copy is the newer one.
 */
interface Kept {
  text: string;
  at: number;
  savedAt?: number;
}

const keptKey = (responseId: string) => `lockin.answer.${responseId}`;
/** Before answers were kept one by one: every answer of a sitting under one key. */
const oldKey = (attemptId: string) => `lockin.draft.${attemptId}`;

/**
 * Closed-book answering. Every answer is kept twice as it is typed: in this browser
 * straight away, and in Lockin a second after typing pauses (or on leaving the box),
 * so it is there on coming back — even on another day, or after the window closed.
 * Background refreshes are held off while this is open.
 */
export function AnswerForm({
  attemptId,
  questions,
}: {
  attemptId: string;
  questions: Array<{
    responseId: string;
    questionId: string;
    number: number;
    stem: string;
    /** What Lockin already has for this answer (Response.draftText). */
    draft?: string | null;
  }>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.responseId, q.draft ?? ""])),
  );
  const [status, setStatus] = useState<Record<string, SaveState>>(() =>
    Object.fromEntries(questions.filter((q) => q.draft).map((q) => [q.responseId, "saved" as const])),
  );

  // For saves that finish after more typing: what is on screen and what Lockin has.
  const latest = useRef(answers);
  const onServer = useRef(new Map(questions.map((q) => [q.responseId, q.draft ?? ""])));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  /** Submitting or submitted: the answers themselves go in, so drafts stop. */
  const done = useRef(false);
  /** Answers typed out from photos, until the student dismisses the note. */
  const [reads, setReads] = useState<Record<string, HandwritingResult>>({});
  const boxes = useRef(new Map<string, HTMLTextAreaElement>());

  const mark = useCallback((id: string, s: SaveState) => {
    if (!done.current) setStatus((all) => (all[id] === s ? all : { ...all, [id]: s }));
  }, []);

  const save = useCallback(
    async (id: string) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      if (done.current) return;
      // One save per answer at a time, so an older text can never land after a newer
      // one; anything typed meanwhile goes in the next round of the loop.
      if (inFlight.current.has(id)) {
        again.current.add(id);
        return;
      }
      inFlight.current.add(id);
      let ok = true;
      try {
        do {
          again.current.delete(id);
          const text = latest.current[id] ?? "";
          if (text === onServer.current.get(id)) {
            ok = true;
            markKeptSaved(id, text);
            break;
          }
          mark(id, "saving");
          ok = false;
          try {
            ok = (await saveAnswerDraft(id, text)).ok;
          } catch {
            // Lockin unreachable: the browser's copy stands, and the next keystroke tries again.
          }
          if (ok) {
            onServer.current.set(id, text);
            markKeptSaved(id, text);
          }
        } while (ok && again.current.has(id) && !done.current);
      } finally {
        inFlight.current.delete(id);
      }
      if (timers.current.has(id)) return; // more typing; its own save follows
      mark(id, ok ? "saved" : "local");
    },
    [mark],
  );

  useEffect(() => {
    window.__lockinHoldRefresh = true;

    // This browser's copy wins when Lockin never got it — typed offline, or the window
    // closed before the save went out. Otherwise Lockin's is the newer one.
    let old: Record<string, unknown> = {};
    try {
      old = JSON.parse(localStorage.getItem(oldKey(attemptId)) ?? "{}") ?? {};
    } catch {
      // Nothing from before, or unreadable.
    }
    const restored: Record<string, string> = {};
    for (const [id, server] of onServer.current) {
      const kept = readKept(id) ?? (typeof old[id] === "string" ? { text: old[id] as string, at: 0 } : null);
      if (!kept || kept.text === server) continue;
      if (kept.savedAt === undefined || kept.savedAt < kept.at) {
        restored[id] = kept.text;
        writeKept(id, kept);
      } else {
        removeKept(id);
      }
    }
    try {
      localStorage.removeItem(oldKey(attemptId));
    } catch {}

    const ids = Object.keys(restored);
    if (ids.length) {
      latest.current = { ...latest.current, ...restored };
      // The browser's copy is readable only after mount.
      setAnswers(latest.current);
      for (const id of ids) void save(id);
    }

    // Leaving: whatever is waiting on a pause in typing goes now.
    const timersNow = timers.current;
    const flush = () => {
      for (const id of [...timersNow.keys()]) void save(id);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
      window.__lockinHoldRefresh = false;
    };
    // The answers this sitting started from are read once; later renders only follow typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  // Drafts are forgotten as the submit returns: it swaps this page for the results,
  // which can unmount the form before any success callback gets to run.
  const submit = useCallback(
    async (prev: Result, fd: FormData): Promise<Result> => {
      done.current = true;
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
      let result: Result = null;
      try {
        result = await submitAttempt(prev, fd);
        return result;
      } finally {
        if (result?.ok) {
          for (const id of onServer.current.keys()) removeKept(id);
          try {
            localStorage.removeItem(oldKey(attemptId));
          } catch {}
        } else {
          // Not submitted after all: carry on saving whatever Lockin doesn't have yet.
          done.current = false;
          for (const id of Object.keys(latest.current)) void save(id);
        }
      }
    },
    [attemptId, save],
  );

  function change(id: string, text: string) {
    latest.current = { ...latest.current, [id]: text };
    setAnswers(latest.current);
    keepTyped(id, text);
    clearTimeout(timers.current.get(id));
    if (text === onServer.current.get(id) && !inFlight.current.has(id)) {
      timers.current.delete(id);
      return mark(id, "saved");
    }
    mark(id, "saving");
    timers.current.set(
      id,
      setTimeout(() => void save(id), SAVE_AFTER_MS),
    );
  }

  const blank = questions.filter((q) => !(answers[q.responseId] ?? "").trim()).length;
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

  return (
    <ActionForm
      action={submit}
      onSuccess={() => {
        window.__lockinHoldRefresh = false;
      }}
    >
      <input type="hidden" name="attemptId" value={attemptId} />
      {questions.map((q) => {
        const text = answers[q.responseId] ?? "";
        const s = status[q.responseId];
        return (
          <div key={q.responseId} className="answer">
            <div className="laq-num" id={`af-label-${q.responseId}`}>
              LAQ {q.number}
            </div>
            <Markdown md={q.stem} className="laq-stem" />
            <textarea
              ref={(el) => {
                if (el) boxes.current.set(q.responseId, el);
                else boxes.current.delete(q.responseId);
              }}
              name={`answer.${q.responseId}`}
              value={text}
              onChange={(e) => change(q.responseId, e.target.value)}
              onBlur={() => void save(q.responseId)}
              placeholder="Answer from memory. Dot points are fine — so is dictation."
              aria-labelledby={`af-label-${q.responseId}`}
              aria-describedby={`af-meta-${q.responseId}`}
            />
            <div className="af-meta small faint" id={`af-meta-${q.responseId}`}>
              <span>
                {words(text)} word{words(text) === 1 ? "" : "s"}
              </span>
              {s && (text || s !== "saved") && <SaveStatus state={s} />}
              <HandwritingButton
                questionId={q.questionId}
                onRead={(read) => {
                  change(q.responseId, withHandwriting(latest.current[q.responseId] ?? "", read.text));
                  setReads((all) => ({ ...all, [q.responseId]: read }));
                }}
              />
            </div>
            {reads[q.responseId] && (
              <HandwritingNote
                read={reads[q.responseId]}
                onFind={(word) => selectIn(boxes.current.get(q.responseId) ?? null, word)}
                onClose={() => setReads(({ [q.responseId]: _gone, ...rest }) => rest)}
              />
            )}
          </div>
        );
      })}
      <div className="sticky-foot">
        <Submit
          className="btn primary lg"
          pending="Submitting…"
          confirm={
            blank > 0
              ? `${blank} question${blank === 1 ? " is" : "s are"} blank and will score 0 — which makes this sitting's geometric mean 0. Submit anyway?`
              : undefined
          }
        >
          Submit for marking
        </Submit>
        <span className="small muted">
          {blank === 0 ? "All answered." : `${blank} of ${questions.length} still blank.`}
        </span>
        <FormResult />
      </div>
    </ActionForm>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state === "saving") return <span className="af-status">Saving…</span>;
  if (state === "saved") {
    return (
      <span className="af-status af-saved">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
          <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Saved
      </span>
    );
  }
  return (
    <span
      className="af-status af-local"
      role="status"
      title="Lockin couldn't be reached, so this answer is kept in this browser for now. It is saved to Lockin as soon as it can be — keep typing, or come back later."
    >
      Saved on this computer only
    </span>
  );
}

function readKept(id: string): Kept | null {
  try {
    const raw = localStorage.getItem(keptKey(id));
    if (!raw) return null;
    const kept = JSON.parse(raw) as Partial<Kept>;
    return typeof kept?.text === "string" ? { text: kept.text, at: Number(kept.at) || 0, savedAt: kept.savedAt } : null;
  } catch {
    return null;
  }
}

function writeKept(id: string, kept: Kept): void {
  try {
    localStorage.setItem(keptKey(id), JSON.stringify(kept));
  } catch {
    // Full or blocked: the save to Lockin still keeps it.
  }
}

/** Typed just now, so newer than whatever Lockin has. */
function keepTyped(id: string, text: string): void {
  writeKept(id, { text, at: Date.now() });
}

/** Lockin has this exact text now, so this browser's copy is no longer the newer one. */
function markKeptSaved(id: string, text: string): void {
  const kept = readKept(id);
  if (kept && kept.text === text) writeKept(id, { ...kept, savedAt: Math.max(Date.now(), kept.at) });
}

function removeKept(id: string): void {
  try {
    localStorage.removeItem(keptKey(id));
  } catch {}
}
