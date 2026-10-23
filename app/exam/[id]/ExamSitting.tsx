"use client";

import "../exam.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { handInExam, saveExamChoice, saveExamDraft } from "@/app/exam/actions";
import "@/app/ui/desktop";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { HandwritingButton, HandwritingNote, selectIn, withHandwriting, type HandwritingResult } from "@/app/ui/Handwriting";
import { Markdown } from "@/app/ui/render";
import { LETTERS } from "@/lib/exam/pick";

const SAVE_AFTER_MS = 1000;

export interface SittingItem {
  id: string;
  kind: "MCQ" | "LAQ";
  /** The LAQ asked, for reading a handwritten answer to it. */
  questionId: string | null;
  number: number;
  stem: string;
  options: string[];
  choice: number | null;
  draft: string | null;
}

function clock(ms: number) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Time left, or time taken when untimed; over time it counts up in red rather than taking the paper away. */
function Timer({ startedAt, limitMin }: { startedAt: string; limitMin: number | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Read the clock only in the browser: the server's render would never match it.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  if (now === null) return <span className="exam-timer">—</span>;
  const elapsed = now - new Date(startedAt).getTime();
  if (!limitMin) return <span className="exam-timer" title="Time taken">{clock(elapsed)}</span>;
  const left = limitMin * 60_000 - elapsed;
  if (left < 0) {
    return (
      <span className="exam-timer over" role="timer">
        Time&apos;s up · {clock(left)} over
      </span>
    );
  }
  return (
    <span className={`exam-timer${left < 5 * 60_000 ? " low" : ""}`} role="timer" title={`${limitMin} minutes in all`}>
      {clock(left)} left
    </span>
  );
}

/**
 * Sitting an exam: multiple choice, then long answers, closed book. Every choice is
 * saved as it is made and every answer a second after typing pauses, so the exam can
 * be left and picked up again.
 */
export function ExamSitting({
  examId,
  title,
  startedAt,
  timeLimitMin,
  items,
}: {
  examId: string;
  title: string;
  startedAt: string;
  timeLimitMin: number | null;
  items: SittingItem[];
}) {
  const [choices, setChoices] = useState<Record<string, number | null>>(() => Object.fromEntries(items.map((i) => [i.id, i.choice])));
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(items.map((i) => [i.id, i.draft ?? ""])));
  const [failed, setFailed] = useState(false);
  const latest = useRef(texts);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const done = useRef(false);
  const [reads, setReads] = useState<Record<string, HandwritingResult>>({});
  const boxes = useRef(new Map<string, HTMLTextAreaElement>());

  const saveText = useCallback(async (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    if (done.current) return;
    try {
      const { ok } = await saveExamDraft(id, latest.current[id] ?? "");
      setFailed(!ok);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    window.__lockinHoldRefresh = true;
    const pending = timers.current;
    const flush = () => {
      for (const id of [...pending.keys()]) void saveText(id);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      window.__lockinHoldRefresh = false;
    };
  }, [saveText]);

  function choose(id: string, choice: number | null) {
    setChoices((all) => ({ ...all, [id]: choice }));
    saveExamChoice(id, choice).then(
      ({ ok }) => setFailed(!ok),
      () => setFailed(true),
    );
  }

  function type(id: string, text: string) {
    latest.current = { ...latest.current, [id]: text };
    setTexts(latest.current);
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => void saveText(id), SAVE_AFTER_MS),
    );
  }

  const submit = useCallback(async (prev: Parameters<typeof handInExam>[0], fd: FormData) => {
    done.current = true;
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    const result = await handInExam(prev, fd);
    if (!result?.ok) done.current = false;
    else window.__lockinHoldRefresh = false;
    return result;
  }, []);

  const mcqs = items.filter((i) => i.kind === "MCQ");
  const laqs = items.filter((i) => i.kind === "LAQ");
  const mcqLeft = mcqs.filter((i) => choices[i.id] === null || choices[i.id] === undefined).length;
  const laqLeft = laqs.filter((i) => !(texts[i.id] ?? "").trim()).length;
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const warn = [
    mcqLeft ? `${mcqLeft} multiple choice unanswered (marked wrong)` : "",
    laqLeft ? `${laqLeft} long answer${laqLeft === 1 ? "" : "s"} blank (scored 0)` : "",
  ].filter(Boolean);

  return (
    <ActionForm action={submit}>
      <input type="hidden" name="examId" value={examId} />
      <div className="exam-bar">
        <b>{title}</b>
        <span className="small muted">
          {mcqs.length ? `${mcqs.length - mcqLeft}/${mcqs.length} MCQs` : ""}
          {mcqs.length && laqs.length ? " · " : ""}
          {laqs.length ? `${laqs.length - laqLeft}/${laqs.length} long answers` : ""}
        </span>
        <span className="spacer" />
        {failed && <span className="small af-local">Not saved — Lockin couldn&apos;t be reached</span>}
        <Timer startedAt={startedAt} limitMin={timeLimitMin} />
      </div>

      {mcqs.length > 0 && (
        <section>
          <h2 className="exam-section">Section A · Multiple choice</h2>
          <p className="small muted">One best answer each.</p>
          {mcqs.map((q) => (
            <fieldset key={q.id} className="exam-mcq">
              <legend className="laq-num">Question {q.number}</legend>
              <Markdown md={q.stem} className="laq-stem" />
              <div className="exam-options-list">
                {q.options.map((option, i) => (
                  <label key={i} className={choices[q.id] === i ? "on" : undefined}>
                    <input type="radio" name={`choice.${q.id}`} value={i} checked={choices[q.id] === i} onChange={() => choose(q.id, i)} />
                    <span className="exam-letter">{LETTERS[i]}</span>
                    <span>{option}</span>
                  </label>
                ))}
              </div>
              {choices[q.id] !== null && choices[q.id] !== undefined && (
                <button type="button" className="btn quiet sm" onClick={() => choose(q.id, null)}>
                  Clear choice
                </button>
              )}
            </fieldset>
          ))}
        </section>
      )}

      {laqs.length > 0 && (
        <section>
          <h2 className="exam-section">Section {mcqs.length ? "B" : "A"} · Long answers</h2>
          <p className="small muted">Answer from memory. Marking credits the substance, not the grammar.</p>
          {laqs.map((q) => (
            <div key={q.id} className="answer">
              <div className="laq-num" id={`ex-label-${q.id}`}>
                Question {q.number}
              </div>
              <Markdown md={q.stem} className="laq-stem" />
              <textarea
                ref={(el) => {
                  if (el) boxes.current.set(q.id, el);
                  else boxes.current.delete(q.id);
                }}
                name={`answer.${q.id}`}
                value={texts[q.id] ?? ""}
                onChange={(e) => type(q.id, e.target.value)}
                onBlur={() => void saveText(q.id)}
                placeholder="Dot points are fine — so is dictation."
                aria-labelledby={`ex-label-${q.id}`}
              />
              <div className="af-meta small faint">
                {words(texts[q.id] ?? "")} words
                {q.questionId && (
                  <HandwritingButton
                    questionId={q.questionId}
                    onRead={(read) => {
                      type(q.id, withHandwriting(latest.current[q.id] ?? "", read.text));
                      setReads((all) => ({ ...all, [q.id]: read }));
                    }}
                  />
                )}
              </div>
              {reads[q.id] && (
                <HandwritingNote
                  read={reads[q.id]}
                  onFind={(word) => selectIn(boxes.current.get(q.id) ?? null, word)}
                  onClose={() => setReads(({ [q.id]: _gone, ...rest }) => rest)}
                />
              )}
            </div>
          ))}
        </section>
      )}

      <div className="sticky-foot">
        <Submit className="btn primary lg" pending="Handing in…" confirm={warn.length ? `${warn.join(" and ")}. Hand in anyway?` : "Hand in your exam?"}>
          Hand in
        </Submit>
        <span className="small muted">{warn.length ? `${warn.join(" · ")}.` : "Everything answered."}</span>
        <FormResult />
      </div>
    </ActionForm>
  );
}
