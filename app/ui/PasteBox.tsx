"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { Result } from "@/app/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { LaqCard, Markdown, QuestionScore } from "@/app/ui/render";
import { usePersistentText, writeText } from "@/app/ui/useDraft";
import { geometricMean } from "@/lib/engines/geomean";
import { formatScore, scoreTone } from "@/lib/format";
import type { SlideImages } from "@/lib/markdown";
import { parseLaqs, parseScores, parseSummary } from "@/lib/paste";

type Kind = "summary" | "laqs" | "scores";

const PLACEHOLDER: Record<Kind, string> = {
  summary: "Paste the summary from your AI chat here…",
  laqs: "Paste the LAQs from your AI chat here — questions, marking guides and model answers…",
  scores: "Paste the marking from your AI chat here, e.g.\n\nLAQ 1: 7/10\n- Good: …\n- Missed: …\n- Wrong: …",
};

/**
 * Where a reply from an AI chat comes back in. The preview underneath is exactly
 * what will be saved, so a paste that did not parse is obvious before it is kept.
 * What is pasted stays in this browser until it is saved, so leaving the page (or
 * a failed save) never means finding the reply in the chat again.
 */
export function PasteBox({
  kind,
  action,
  hidden,
  saveLabel,
  firstNumber = 1,
  autoFocus,
  slides,
}: {
  kind: Kind;
  action: (prev: Result, fd: FormData) => Promise<Result>;
  hidden: Record<string, string>;
  saveLabel: string;
  /** LAQs only: the number the first pasted question will be saved as. */
  firstNumber?: number;
  autoFocus?: boolean;
  /** Summary only: the lecture's slide pictures, for `![…](slide:N)` in the paste. */
  slides?: SlideImages;
}) {
  const key = `lockin.paste.${kind}.${Object.values(hidden).join(".")}`;
  const [text, setText, clear] = usePersistentText(key);
  // Saved means no longer kept — forgotten as the save returns, because a save that
  // changes the page can unmount this box before any success callback gets to run.
  const save = useCallback(
    async (prev: Result, fd: FormData) => {
      const result = await action(prev, fd);
      if (result?.ok) writeText(key, "");
      return result;
    },
    [action, key],
  );
  const box = useRef<HTMLTextAreaElement>(null);
  const shown = useRef(false);
  // A paste kept from last time is no use folded away: open the section it is in.
  useEffect(() => {
    if (!text || shown.current) return;
    shown.current = true;
    const details = box.current?.closest("details");
    if (details && !details.open) details.open = true;
  }, [text]);
  const preview = useMemo(
    () => (text.trim() ? <Preview kind={kind} text={text} firstNumber={firstNumber} slides={slides} /> : null),
    [kind, text, firstNumber, slides],
  );
  const usable = useMemo(() => {
    if (!text.trim()) return false;
    if (kind === "laqs") return parseLaqs(text).length > 0;
    if (kind === "scores") return parseScores(text).length > 0;
    return true;
  }, [kind, text]);

  return (
    <ActionForm action={save} className="paste" onSuccess={clear}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <textarea
        ref={box}
        name="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER[kind]}
        rows={7}
        autoFocus={autoFocus}
        spellCheck={false}
      />
      {preview}
      <div className="row">
        <Submit disabled={!usable} pending="Saving…">
          {saveLabel}
        </Submit>
        {text && (
          <button
            type="button"
            className="btn quiet sm"
            onClick={() => {
              clear();
              box.current?.focus();
            }}
          >
            Clear
          </button>
        )}
        <FormResult />
      </div>
    </ActionForm>
  );
}

function Preview({
  kind,
  text,
  firstNumber,
  slides,
}: {
  kind: Kind;
  text: string;
  firstNumber: number;
  slides?: SlideImages;
}) {
  if (kind === "summary") {
    const s = parseSummary(text);
    return (
      <div className="preview">
        <div className="preview-label">Preview</div>
        {s.title && (
          <p className="small muted" style={{ marginTop: 0 }}>
            Title found: <strong>{s.title}</strong> — used if this lecture still has a placeholder title.
          </p>
        )}
        <Markdown md={s.markdown} slides={slides} />
      </div>
    );
  }

  if (kind === "laqs") {
    const laqs = parseLaqs(text);
    if (laqs.length === 0) {
      return (
        <div className="preview">
          <p className="result err" style={{ margin: 0 }}>
            No questions found yet. Each one needs its own line starting “LAQ 1”, “Question 1” or “1.”.
          </p>
        </div>
      );
    }
    const renumbered = laqs.some((q, i) => q.number !== firstNumber + i);
    return (
      <div className="preview">
        <div className="preview-label">
          Preview · {laqs.length} LAQ{laqs.length === 1 ? "" : "s"}
          {renumbered && ` · saved as LAQ ${firstNumber}${laqs.length > 1 ? `–${firstNumber + laqs.length - 1}` : ""}`}
        </div>
        <div className="laqs">
          {laqs.map((q, i) => (
            <LaqCard
              key={i}
              laq={{ ...q, number: firstNumber + i }}
              extra={
                q.criteria.length === 0 ? (
                  <span className="faint">no marking guide found</span>
                ) : (
                  <span>{q.criteria.length} marking points</span>
                )
              }
            />
          ))}
        </div>
      </div>
    );
  }

  const scores = parseScores(text);
  if (scores.length === 0) {
    return (
      <div className="preview">
        <p className="result err" style={{ margin: 0 }}>
          No scores found yet. Each question needs a line like “LAQ 1: 7/10”.
        </p>
      </div>
    );
  }
  const gm = geometricMean(scores.map((s) => s.mark));
  return (
    <div className="preview">
      <div className="preview-label">Preview</div>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className={`big-score t-${scoreTone(gm)}`}>
          {formatScore(gm)}
          <small>/10</small>
        </span>
        <span className="small muted">geometric mean of {scores.length} — one weak answer drags it down, as in the exam</span>
      </div>
      <div className="q-scores">
        {scores.map((s, i) => (
          <QuestionScore key={i} label={`LAQ ${s.number}`} mark={s.mark} raw={s.raw} feedback={s.feedback} />
        ))}
      </div>
    </div>
  );
}
