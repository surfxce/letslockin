"use client";

import "./ask-button.css";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { CopyButton } from "@/app/ui/CopyButton";
import { addToLectureSummary, useAsk, type AskState } from "@/app/ui/ask";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import {
  ASK_LIMIT,
  askDraftKey,
  askPasteKey,
  chosenSection,
  END_OF_SUMMARY,
  formatWait,
  mergeHistory,
  type AskHistoryItem,
} from "@/lib/ask-history";
import type { SlideImages } from "@/lib/markdown";
import type { Mode } from "@/lib/modes";
import { formatAnswer } from "@/lib/summary-edit";

export type { AskHistoryItem } from "@/lib/ask-history";

export interface AskButtonProps {
  lectureId: string;
  mode: Mode;
  hasSummary: boolean;
  /** The summary's headings, in order, for the "under …" picker. */
  headings: string[];
  /** Questions answered before, newest first. */
  history: AskHistoryItem[];
  slides: SlideImages;
}

/** How many earlier questions show before "Show more". */
const FIRST_FEW = 5;

/**
 * The round "?" in the corner of a lecture page: ask anything about the lecture, get
 * an answer from its summary, and file the answer in the summary with one click. In
 * copy & paste mode the question becomes a prompt for any AI chat instead.
 */
export function AskButton(props: AskButtonProps) {
  // Another lecture starts afresh: an answer about the last one never carries over.
  return <AskWidget key={props.lectureId} {...props} />;
}

function AskWidget({ lectureId, mode, hasSummary, headings, history, slides }: AskButtonProps) {
  const [open, setOpen] = useState(false);
  const { state, ask, reset } = useAsk();
  const [draft, setDraft, forgetDraft] = useStoredText(askDraftKey(lectureId));
  const [pasted, setPasted, forgetPasted] = useStoredText(askPasteKey(lectureId));
  const [asked, setAsked] = useState("");
  const [session, setSession] = useState<AskHistoryItem[]>([]);
  // The state last shown in the open panel, so an answer arriving while it is closed gets a dot.
  const [seen, setSeen] = useState<AskState | null>(null);
  const [now, setNow] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  const manual = mode === "manual";
  const waiting = state.status === "waiting";
  const current = state.status === "done" ? { question: asked || state.result.question || "", answer: state.result.answer } : null;
  const earlier = mergeHistory([session, history], current);

  const close = useCallback(() => {
    setOpen(false);
    setSeen(state);
    fabRef.current?.focus();
  }, [state]);

  function toggle() {
    if (open) return close();
    setOpen(true);
    setSeen(state);
  }

  // On opening, focus goes into the panel: the question box takes it itself when there
  // is one (its effect runs first), else the panel does, so Escape and Tab work at once.
  useEffect(() => {
    const panel = panelRef.current;
    if (open && panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open]);

  // Escape closes the panel from inside it, or when nothing else has focus. A click
  // outside does not: the student may be reading or selecting the summary beside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as Node | null;
      const inside = !!target && !!rootRef.current?.contains(target);
      if (!inside && target !== document.body && target !== document.documentElement) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // A ticking clock while waiting; kept here so reopening the panel shows the real time.
  useEffect(() => {
    if (!waiting) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [waiting]);

  const tooLong = draft.trim().length > ASK_LIMIT;

  function send() {
    const question = draft.trim();
    if (!question || tooLong || waiting) return;
    setAsked(question);
    // Sent, so no longer a draft: if the student leaves now, the answer still arrives in Earlier questions.
    setDraft("");
    // The box is about to go; keep focus in the panel so Escape and Tab still work.
    panelRef.current?.focus();
    void ask({ lectureId, kind: "question", question });
  }

  function editQuestion() {
    reset();
    setDraft(asked);
  }

  function askAnother() {
    if (state.status === "done") {
      const { result } = state;
      setSession((s) => [
        {
          id: `visit-${Date.now()}`,
          question: asked || result.question || "",
          answer: result.answer,
          section: result.section,
          at: new Date().toISOString(),
          model: result.model,
        },
        ...s,
      ]);
    }
    reset();
    if (manual) {
      setDraft("");
      setPasted("");
    }
  }

  const unseen = !open && (state.status === "done" || state.status === "error") && state !== seen;
  const badge = waiting && !open ? "wait" : unseen ? (state.status === "error" ? "err" : "ready") : null;
  const announce =
    state.status === "waiting" ? "Thinking…" : state.status === "done" ? "Answer ready" : state.status === "error" ? "Couldn't answer that" : "";

  const questionBox = (
    <QuestionBox
      id={`${panelId}-q`}
      value={draft}
      onChange={setDraft}
      // In copy & paste mode there is nothing to send: Enter is just a new line.
      onEnter={manual ? undefined : send}
      placeholder={manual ? "Type your question…" : "Ask anything about this lecture…"}
    />
  );
  const shownQuestion = asked || (state.status === "done" ? (state.result.question ?? "") : "");

  let body: React.ReactNode;
  if (!hasSummary) {
    body = <p className="ask-empty">This lecture has no summary yet — prepare it first, then ask about it.</p>;
  } else if (manual) {
    const question = draft.trim();
    const answer = pasted.trim();
    body = (
      <>
        <div className="ask-step">
          <span className="ask-step-n">1</span>
          <span>Type your question</span>
        </div>
        {questionBox}
        <div className="ask-step">
          <span className="ask-step-n">2</span>
          <span>Copy the prompt into any AI chat</span>
        </div>
        <div className="row">
          {question && !tooLong ? (
            <CopyButton
              url={`/api/lectures/${lectureId}/prompt?kind=ask&q=${encodeURIComponent(question)}`}
              label="Copy prompt"
              className="btn sm"
            />
          ) : (
            <button type="button" className="btn sm" aria-disabled="true" title="Type a question first">
              <Icon name="copy" size={13} /> Copy prompt
            </button>
          )}
        </div>
        <div className="ask-step">
          <span className="ask-step-n">3</span>
          <label htmlFor={`${panelId}-paste`}>Paste the answer from your AI chat</label>
        </div>
        <textarea
          id={`${panelId}-paste`}
          className="ask-paste"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste the answer here…"
          rows={4}
          spellCheck={false}
        />
        {answer && (
          <>
            <div className="ask-preview">
              <div className="ask-label">Preview</div>
              <Markdown md={answer} slides={slides} className="prose ask-answer" />
            </div>
            <div className="ask-actions">
              <AddToSummary
                lectureId={lectureId}
                markdown={question ? formatAnswer(question, answer) : ""}
                headings={headings}
                suggested={null}
                // Added: nothing left to keep for next time, though it stays on screen.
                onAdded={() => {
                  forgetDraft();
                  forgetPasted();
                }}
                why={question ? undefined : "Type the question above first"}
              />
              <button type="button" className="btn quiet sm" onClick={askAnother}>
                Ask another
              </button>
            </div>
          </>
        )}
      </>
    );
  } else if (state.status === "idle") {
    body = (
      <>
        {questionBox}
        <div className="ask-send">
          <span className="ask-hint">Enter to ask · Shift+Enter for a new line</span>
          <button type="button" className="btn primary sm" onClick={send} disabled={!draft.trim() || tooLong}>
            Ask
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        {shownQuestion && <div className="ask-q">{shownQuestion}</div>}
        {state.status === "waiting" && (
          <>
            <div className="ask-wait">
              <span className="ask-spin" aria-hidden="true" />
              <span>Thinking… {formatWait(now - state.startedAt)}</span>
              <span className="ask-spacer" />
              <button type="button" className="btn quiet sm" onClick={editQuestion}>
                Stop waiting
              </button>
            </div>
            {!state.workerAlive && (
              <p className="ask-note">
                The AI worker isn&apos;t running, so nothing will answer yet. The desktop app starts it for you; from the
                repository run <code>npm run worker</code>.
              </p>
            )}
          </>
        )}
        {state.status === "error" && (
          <>
            <p className="result err ask-error">{state.message}</p>
            <div className="ask-actions">
              <button type="button" className="btn sm" onClick={() => void ask({ lectureId, kind: "question", question: asked })}>
                <Icon name="refresh" size={13} /> Try again
              </button>
              <button type="button" className="btn quiet sm" onClick={editQuestion}>
                Edit question
              </button>
            </div>
          </>
        )}
        {state.status === "done" && (
          <>
            <Markdown md={state.result.answer} slides={slides} className="prose ask-answer" />
            {state.result.model && <div className="ask-meta">Answered by {state.result.model}</div>}
            <div className="ask-actions">
              <AddToSummary
                lectureId={lectureId}
                markdown={formatAnswer(current?.question ?? "", state.result.answer)}
                headings={headings}
                suggested={state.result.section}
              />
              <CopyAnswer text={state.result.answer} />
              <button type="button" className="btn quiet sm" onClick={askAnother}>
                Ask another
              </button>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className="ask-root" ref={rootRef}>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {open && (
        <div
          className="ask-panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="ask-head">
            <div className="ask-head-text">
              <div className="ask-title" id={titleId}>
                Ask a question
              </div>
              <div className="ask-sub">Answered from this lecture&apos;s summary</div>
            </div>
            <button type="button" className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)">
              <Icon name="x" />
            </button>
          </div>
          <div className="ask-body">
            {body}
            {hasSummary && earlier.length > 0 && (
              <Earlier items={earlier} lectureId={lectureId} headings={headings} slides={slides} />
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        ref={fabRef}
        className="ask-fab"
        onClick={toggle}
        aria-label="Ask a question"
        title="Ask a question"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <span aria-hidden="true">?</span>
        {badge && <span className={`ask-badge ask-badge-${badge}`} aria-hidden="true" />}
      </button>
    </div>
  );
}

/**
 * The question box. Takes focus whenever it appears (opening the panel, Ask another,
 * Edit question), with the caret after any draft. Enter sends when `onEnter` is given;
 * Shift+Enter is always a new line.
 */
function QuestionBox({
  id,
  value,
  onChange,
  onEnter,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  const length = value.trim().length;
  return (
    <div className="ask-input">
      <label htmlFor={id} className="sr-only">
        Your question
      </label>
      <textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onEnter && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        rows={3}
      />
      {length > ASK_LIMIT - 150 && (
        <div className={`ask-count${length > ASK_LIMIT ? " over" : ""}`}>
          {length.toLocaleString("en")} / {ASK_LIMIT.toLocaleString("en")}
          {length > ASK_LIMIT && " — too long to ask"}
        </div>
      )}
    </div>
  );
}

/** The questions asked before, each folded to its question until opened. */
function Earlier({
  items,
  lectureId,
  headings,
  slides,
}: {
  items: AskHistoryItem[];
  lectureId: string;
  headings: string[];
  slides: SlideImages;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FIRST_FEW);
  return (
    <div className="ask-history">
      <div className="ask-label">Earlier questions</div>
      <ul className="ask-list">
        {shown.map((item) => (
          <EarlierItem key={item.id} item={item} lectureId={lectureId} headings={headings} slides={slides} />
        ))}
      </ul>
      {!all && items.length > FIRST_FEW && (
        <button type="button" className="btn quiet sm" onClick={() => setAll(true)}>
          Show {items.length - FIRST_FEW} more
        </button>
      )}
    </div>
  );
}

function EarlierItem({
  item,
  lectureId,
  headings,
  slides,
}: {
  item: AskHistoryItem;
  lectureId: string;
  headings: string[];
  slides: SlideImages;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const when = answeredOn(item.at);
  return (
    <li className="ask-item">
      <button
        type="button"
        className="ask-item-head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="ask-item-chev" />
        <span className="ask-item-q">{item.question}</span>
      </button>
      {open && (
        <div className="ask-item-body" id={bodyId}>
          <Markdown md={item.answer} slides={slides} className="prose ask-answer" />
          {(when || item.model) && <div className="ask-meta">{[when, item.model].filter(Boolean).join(" · ")}</div>}
          <div className="ask-actions">
            <AddToSummary
              lectureId={lectureId}
              markdown={formatAnswer(item.question, item.answer)}
              headings={headings}
              suggested={item.section}
            />
            <CopyAnswer text={item.answer} />
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * "Add to summary" and where to: under a heading (the AI's suggestion first) or at the
 * end. Goes into the summary editor instead when it is open, so neither overwrites the other.
 */
function AddToSummary({
  lectureId,
  markdown,
  headings,
  suggested,
  onAdded,
  why,
}: {
  lectureId: string;
  markdown: string;
  headings: string[];
  suggested: string | null;
  onAdded?: () => void;
  /** Why there is nothing to add yet, shown as the button's tooltip. */
  why?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Tied to the text added, so an edited paste can be added again.
  const [outcome, setOutcome] = useState<{ markdown: string; ok: boolean; message: string } | null>(null);
  const selectId = useId();
  const section = chosenSection(headings, suggested, picked);
  const result = outcome?.markdown === markdown ? outcome : null;
  const added = !!result?.ok;
  const unavailable = busy || added || !markdown.trim();

  async function add() {
    if (unavailable) return;
    setBusy(true);
    const res = await addToLectureSummary(lectureId, markdown, { section: section || null });
    setBusy(false);
    setOutcome({ markdown, ok: res.ok, message: res.message });
    if (res.ok) onAdded?.();
  }

  return (
    <div className="ask-add">
      <button
        type="button"
        className="btn primary sm"
        onClick={add}
        aria-disabled={unavailable}
        title={!markdown.trim() ? why : undefined}
      >
        {added ? (
          "Added ✓"
        ) : busy ? (
          "Adding…"
        ) : (
          <>
            <Icon name="plus" size={13} /> Add to summary
          </>
        )}
      </button>
      {headings.length > 0 && !added && (
        <span className="ask-under">
          <label htmlFor={selectId}>under</label>
          <select id={selectId} value={section} onChange={(e) => setPicked(e.target.value)} disabled={busy}>
            {headings.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
            <option value={END_OF_SUMMARY}>End of summary</option>
          </select>
        </span>
      )}
      {result && (
        <span className={`result ${result.ok ? "ok" : "err"} ask-add-msg`} role="status">
          {result.message}
        </span>
      )}
    </div>
  );
}

/** Copies an answer's Markdown, with the old way as a fallback when the clipboard is blocked. */
function CopyAnswer({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "blocked">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(e: React.MouseEvent<HTMLButtonElement>) {
    const ok = await copyText(text, e.currentTarget);
    setStatus(ok ? "copied" : "blocked");
    clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <>
      <button type="button" className="btn sm" onClick={copy}>
        <Icon name={status === "copied" ? "check" : "copy"} size={13} />
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      {status === "blocked" && (
        <span className="result err ask-add-msg" role="status">
          Your browser blocked the clipboard — select the answer and copy it.</span>
      )}
    </>
  );
}

async function copyText(text: string, returnFocus: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API, or permission refused: try the older copy command below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  returnFocus.focus();
  return ok;
}

/** "14 Oct, 09:30" — only ever rendered after a click, so the server's clock never shows. */
function answeredOn(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * A text box's contents kept in this browser as they are typed, so leaving the page
 * doesn't lose them. Returns the text, a setter that saves, and a way to drop the
 * saved copy while leaving the text on screen.
 */
function useStoredText(key: string): [string, (value: string) => void, () => void] {
  const [text, setText] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
      if (saved) setText(saved);
    } catch {
      // Storage blocked: start blank.
    }
  }, [key]);

  const save = useCallback(
    (value: string) => {
      setText(value);
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        // Storage full or blocked: the text still works, it just isn't kept.
      }
    },
    [key],
  );

  const forget = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to forget.
    }
  }, [key]);

  return [text, save, forget];
}
