"use client";

import { useEffect, useRef, useState } from "react";

import { submitAttempt } from "@/app/actions";
import "@/app/ui/desktop";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Markdown } from "@/app/ui/render";

/**
 * Closed-book answering. Drafts are kept in this browser as you type, so a reload or
 * a closed window does not lose an answer; background refreshes are held off while
 * this is open.
 */
export function AnswerForm({
  attemptId,
  questions,
}: {
  attemptId: string;
  questions: Array<{ responseId: string; number: number; stem: string }>;
}) {
  const key = `lockin.draft.${attemptId}`;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const loaded = useRef(false);

  useEffect(() => {
    window.__lockinHoldRefresh = true;
    try {
      const saved = localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- drafts live in localStorage, readable only after mount
      if (saved) setAnswers(JSON.parse(saved));
    } catch {
      // No drafts available; start blank.
    }
    loaded.current = true;
    return () => {
      window.__lockinHoldRefresh = false;
    };
  }, [key]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(answers));
    } catch {
      // Storage full or blocked: answers still submit, they just are not kept as drafts.
    }
  }, [answers, key]);

  const blank = questions.filter((q) => !(answers[q.responseId] ?? "").trim()).length;
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

  return (
    <ActionForm
      action={submitAttempt}
      onSuccess={() => {
        try {
          localStorage.removeItem(key);
        } catch {}
        window.__lockinHoldRefresh = false;
      }}
    >
      <input type="hidden" name="attemptId" value={attemptId} />
      {questions.map((q) => (
        <div key={q.responseId} className="answer">
          <div className="laq-num">LAQ {q.number}</div>
          <Markdown md={q.stem} className="laq-stem" />
          <textarea
            name={`answer.${q.responseId}`}
            value={answers[q.responseId] ?? ""}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.responseId]: e.target.value }))}
            placeholder="Answer from memory. Dot points are fine — so is dictation."
          />
          <div className="small faint" style={{ marginTop: 4 }}>
            {words(answers[q.responseId] ?? "")} words
          </div>
        </div>
      ))}
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
