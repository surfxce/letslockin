"use client";

import "./summary-tools.css";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { addGlossaryTerm, type GlossaryEntry } from "@/app/study-actions";
import { addToLectureSummary, useAsk, type AskState } from "@/app/ui/ask";
import { CopyButton } from "@/app/ui/CopyButton";
import { floatAt, noteGlossaryAdded } from "@/app/ui/Glossary";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import { cleanTerm, MAX_TERM } from "@/lib/glossary";
import type { SlideImages } from "@/lib/markdown";
import type { Mode } from "@/lib/modes";
import {
  elapsed,
  oneLine,
  readPastes,
  rememberPaste,
  SELECTION_LIMIT,
  shorten,
  type Rect,
  type Side,
} from "@/lib/summary-tools";

/**
 * Select any part of a summary and a small "Break this down" button appears above it;
 * the explanation that comes back can be kept in the glossary (the words are then
 * underlined, with the explanation on hover) or added to the summary under the line
 * it explains. In copy & paste mode the passage becomes a prompt for any AI chat.
 */

/** How much of a long selection the card quotes. */
const QUOTE = 220;
/** What a selection is measured from once the words in it have been re-wrapped. */
const LINE = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt";

const toRect = (r: DOMRect): Rect => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
const blank = (r: DOMRect) => r.width === 0 && r.height === 0;

/**
 * Where the passage being broken down is on screen. Its range stops meaning anything
 * once glossary underlining re-wraps the words in it, or the summary's HTML is set
 * again, so its place is also kept relative to the line it starts on — found again by
 * its position and words if that line is replaced — and failing that, where it last was.
 */
class SelectionAnchor {
  private readonly range: Range;
  private readonly root: Element;
  private line: Element | null;
  private readonly lineAt: number;
  private readonly lineText: string;
  private offset: Rect | null = null;
  private last: Rect;

  constructor(root: Element, range: Range) {
    this.root = root;
    this.range = range;
    const start = range.startContainer;
    const el = start instanceof Element ? start : start.parentElement;
    this.line = el?.closest(LINE) ?? el;
    this.lineAt = this.line ? [...root.querySelectorAll(LINE)].indexOf(this.line) : -1;
    this.lineText = this.line?.textContent ?? "";
    this.last = toRect(range.getBoundingClientRect());
    this.rect();
  }

  rect(): Rect {
    const r = this.range.getBoundingClientRect();
    if (!this.range.collapsed && !blank(r)) {
      this.last = toRect(r);
      if (this.line?.isConnected) {
        const l = this.line.getBoundingClientRect();
        this.offset = { top: r.top - l.top, bottom: r.bottom - l.top, left: r.left - l.left, right: r.right - l.left };
      }
      return this.last;
    }
    if (!this.line?.isConnected && this.lineAt >= 0) {
      const again = this.root.querySelectorAll(LINE)[this.lineAt];
      if (again?.textContent === this.lineText) this.line = again;
    }
    if (this.line?.isConnected && this.offset) {
      const l = this.line.getBoundingClientRect();
      return {
        top: l.top + this.offset.top,
        bottom: l.top + this.offset.bottom,
        left: l.left + this.offset.left,
        right: l.left + this.offset.right,
      };
    }
    return this.last;
  }
}

/**
 * The selection as a range inside `root`, or null when it takes in text outside it. A
 * triple-click on the last paragraph runs on past the summary's end without picking up
 * any more words; that still counts as inside.
 */
function within(root: Element, range: Range): Range | null {
  const r = range.cloneRange();
  if (!root.contains(r.startContainer)) r.setStart(root, 0);
  if (!root.contains(r.endContainer)) r.setEnd(root, root.childNodes.length);
  return oneLine(r.toString()) === oneLine(range.toString()) ? r : null;
}

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// A pasted explanation is kept for the passage it explains, so leaving the page loses nothing.
const pasteKey = (lectureId: string) => `lockin.breakdownPastes.${lectureId}`;

function storedPaste(lectureId: string, passage: string): string {
  try {
    return readPastes(localStorage.getItem(pasteKey(lectureId))).find(([p]) => p === passage)?.[1] ?? "";
  } catch {
    return "";
  }
}

function storePaste(lectureId: string, passage: string, text: string) {
  try {
    const next = rememberPaste(readPastes(localStorage.getItem(pasteKey(lectureId))), passage, text);
    if (next.length > 0) localStorage.setItem(pasteKey(lectureId), JSON.stringify(next));
    else localStorage.removeItem(pasteKey(lectureId));
  } catch {
    // Storage full or blocked: the paste still works, it just isn't kept.
  }
}

interface PillState {
  rect: Rect;
  prefer: Side;
}

interface CardState {
  key: number;
  selection: string;
  anchor: SelectionAnchor;
}

export function SelectionTools({
  lectureId,
  mode,
  containerId,
  slides,
  onAdded,
}: {
  lectureId: string;
  mode: Mode;
  /** The element the summary is rendered in. */
  containerId: string;
  slides: SlideImages;
  /** Called once a term is in the glossary. It is underlined already; this is for anything else to update. */
  onAdded?: (entry: GlossaryEntry) => void;
}) {
  const [pill, setPill] = useState<PillState | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  const { state, ask, reset } = useAsk();
  const manual = mode === "manual";

  // What the listeners below need between renders.
  const picked = useRef<{ text: string; range: Range } | null>(null);
  const openCard = useRef<CardState | null>(null);
  const pillShown = useRef(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef("mouse");
  const returnFocus = useRef<HTMLElement | null>(null);
  const count = useRef(0);

  useEffect(() => {
    pillShown.current = !!pill;
  }, [pill]);

  const open = useCallback(() => {
    const p = picked.current;
    const root = document.getElementById(containerId);
    if (!p || !root) return;
    const active = document.activeElement;
    if (!cardRef.current?.contains(active)) {
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    count.current += 1;
    const next = { key: count.current, selection: p.text, anchor: new SelectionAnchor(root, p.range) };
    openCard.current = next;
    picked.current = null;
    setCard(next);
    setPill(null);
    if (manual) reset();
    else void ask({ lectureId, kind: "breakdown", selection: p.text });
  }, [ask, reset, lectureId, manual, containerId]);

  const close = useCallback(() => {
    reset();
    openCard.current = null;
    setCard(null);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, [reset]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dragging = false;
    let settling = false;

    const hidePill = () => {
      picked.current = null;
      setPill(null);
    };

    /** Shows the button for the current selection, if it is something to break down. */
    const check = () => {
      settling = false;
      const root = document.getElementById(containerId);
      const sel = document.getSelection();
      if (!root || root.isContentEditable || !sel || sel.rangeCount === 0 || sel.isCollapsed) return hidePill();
      const range = within(root, sel.getRangeAt(0));
      const text = oneLine(sel.toString());
      if (!range || cleanTerm(text).length < 2 || text.length > SELECTION_LIMIT) return hidePill();
      // Already being broken down in the card.
      if (openCard.current?.selection === text) return hidePill();
      const rect = range.getBoundingClientRect();
      if (blank(rect)) return hidePill();
      picked.current = { text, range };
      // On a touchscreen the system's own copy menu sits above a selection.
      setPill({ rect: toRect(rect), prefer: lastPointer.current === "touch" ? "below" : "above" });
    };
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(check, ms);
    };
    const inCard = (t: EventTarget | null) => t instanceof Node && !!cardRef.current?.contains(t);

    const onSelection = () => {
      // Not while the mouse is still dragging out the selection.
      if (dragging) {
        clearTimeout(timer);
        if (pillShown.current) hidePill();
        return;
      }
      later(150);
    };
    const onDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType;
      if (pillRef.current?.contains(e.target as Node)) return;
      // A long press on a touchscreen may never send its pointerup, so only a mouse or pen drags.
      dragging = e.pointerType !== "touch";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      later(10);
    };
    const onCancel = () => {
      dragging = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Escape") later(60);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        const t = e.target;
        const onPage = t === document.body || t === document.documentElement || !!document.getElementById(containerId)?.contains(t as Node);
        if (openCard.current && (inCard(t) || onPage)) {
          e.preventDefault();
          close();
        } else if (pillShown.current) {
          e.preventDefault();
          hidePill();
        }
        return;
      }
      // "?" opens the card from the keyboard, as the button says.
      if (e.key === "?" && pillShown.current && picked.current && !editable(e.target)) {
        e.preventDefault();
        open();
      }
    };
    // The button would be left behind by a scroll; it comes back once the page is still.
    const onMove = (e: Event) => {
      if (inCard(e.target)) return;
      if (pillShown.current || settling) {
        settling = true;
        if (pillShown.current) setPill(null);
        later(200);
      }
    };

    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onMove, { capture: true, passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
    };
  }, [containerId, open, close]);

  return (
    <>
      {pill && createPortal(<Pill ref={pillRef} rect={pill.rect} prefer={pill.prefer} onOpen={open} />, document.body)}
      {card &&
        createPortal(
          <BreakdownCard
            key={card.key}
            ref={cardRef}
            lectureId={lectureId}
            manual={manual}
            selection={card.selection}
            anchor={card.anchor}
            state={state}
            slides={slides}
            onRetry={() => void ask({ lectureId, kind: "breakdown", selection: card.selection })}
            onClose={close}
            onAdded={onAdded}
          />,
          document.body,
        )}
    </>
  );
}

function Pill({
  ref,
  rect,
  prefer,
  onOpen,
}: {
  ref: React.RefObject<HTMLButtonElement | null>;
  rect: Rect;
  prefer: Side;
  onOpen: () => void;
}) {
  useLayoutEffect(() => {
    if (ref.current) floatAt(ref.current, rect, prefer);
  }, [ref, rect, prefer]);

  return (
    <button
      ref={ref}
      type="button"
      className="st-pill"
      // Keeps the selection: a click would otherwise clear it before it is read.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      title="Break this down (?)"
      aria-keyshortcuts="?"
    >
      <span className="st-q" aria-hidden="true">
        ?
      </span>
      Break this down
    </button>
  );
}

function BreakdownCard({
  ref,
  lectureId,
  manual,
  selection,
  anchor,
  state,
  slides,
  onRetry,
  onClose,
  onAdded,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  lectureId: string;
  manual: boolean;
  selection: string;
  anchor: SelectionAnchor;
  state: AskState;
  slides: SlideImages;
  onRetry: () => void;
  onClose: () => void;
  onAdded?: (entry: GlossaryEntry) => void;
}) {
  const titleId = useId();
  const pasteId = useId();
  const [now, setNow] = useState(0);
  // Rendered only after a click, never on the server, so storage can be read straight away.
  const [pasted, setPasted] = useState(() => (manual ? storedPaste(lectureId, selection) : ""));
  const waiting = state.status === "waiting";

  // Beside the selection, and kept there as the page scrolls or the card grows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const place = () => floatAt(el, anchor.rect(), el.dataset.side === "above" ? "above" : "below");
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const resized = new ResizeObserver(soon);
    resized.observe(el);
    window.addEventListener("scroll", soon, { capture: true, passive: true });
    window.addEventListener("resize", soon);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      window.removeEventListener("scroll", soon, { capture: true });
      window.removeEventListener("resize", soon);
    };
  }, [ref, anchor]);

  // Focus comes into the card, so Escape and Tab work at once.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [ref]);

  // A ticking clock while the answer comes.
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

  const answer = manual ? pasted.trim() : state.status === "done" ? state.result.answer.trim() : "";
  const announce = manual
    ? ""
    : state.status === "waiting"
      ? "Breaking it down…"
      : state.status === "done"
        ? "Explanation ready"
        : state.status === "error"
          ? "Couldn't break that down"
          : "";

  let body: React.ReactNode;
  if (manual) {
    body = (
      <>
        <div className="st-step">
          <span className="st-step-n">1</span>
          <span>Copy the prompt into any AI chat</span>
        </div>
        <div className="row">
          <CopyButton
            url={`/api/lectures/${lectureId}/prompt?kind=breakdown&text=${encodeURIComponent(selection)}`}
            label="Copy prompt"
            className="btn sm"
          />
        </div>
        <div className="st-step">
          <span className="st-step-n">2</span>
          <label htmlFor={pasteId}>Paste the explanation from your AI chat</label>
        </div>
        <textarea
          id={pasteId}
          className="st-paste"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            storePaste(lectureId, selection, e.target.value);
          }}
          placeholder="Paste it here…"
          rows={4}
          spellCheck={false}
        />
        {answer && (
          <div className="st-preview">
            <div className="st-label">Preview</div>
            <Markdown md={answer} slides={slides} className="prose st-answer" />
          </div>
        )}
      </>
    );
  } else if (state.status === "waiting") {
    body = (
      <>
        <div className="st-wait">
          <span className="st-spin" aria-hidden="true" />
          <span>
            Breaking it down… <span className="st-time">{elapsed(now - state.startedAt)}</span>
          </span>
        </div>
        {!state.workerAlive && (
          <p className="st-note">
            The AI worker isn&apos;t running, so nothing will answer yet. The desktop app starts it for you; from the
            repository run <code>npm run worker</code>.
          </p>
        )}
      </>
    );
  } else if (state.status === "error") {
    body = (
      <>
        <p className="result err st-error">{state.message}</p>
        <div className="st-actions">
          <button type="button" className="btn sm" onClick={onRetry}>
            <Icon name="refresh" size={13} /> Try again
          </button>
          <button type="button" className="btn quiet sm" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );
  } else if (state.status === "done") {
    body = (
      <>
        <Markdown md={state.result.answer} slides={slides} className="prose st-answer" />
        {state.result.model && <div className="st-meta">Explained by {state.result.model}</div>}
      </>
    );
  } else {
    body = (
      <div className="st-actions">
        <button type="button" className="btn primary sm" onClick={onRetry}>
          <Icon name="sparkles" size={13} /> Break it down
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="st-card" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      <div className="st-card-head">
        <span className="st-q" aria-hidden="true">
          ?
        </span>
        <span className="st-card-title" id={titleId}>
          Break this down
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <div className="st-card-body">
        <blockquote className="st-quote" title={selection.length > QUOTE ? selection : undefined}>
          {shorten(selection, QUOTE)}
        </blockquote>
        {body}
        {answer && (
          <Keep
            lectureId={lectureId}
            selection={selection}
            explanation={answer}
            onClose={onClose}
            onKept={(entry) => {
              // Kept somewhere now: nothing left to hold on to for next time.
              if (manual) storePaste(lectureId, selection, "");
              if (entry) onAdded?.(entry);
            }}
          />
        )}
      </div>
    </div>
  );
}

interface Outcome {
  /** The explanation it was for: an edited paste can be kept again. */
  text: string;
  ok: boolean;
  message: string;
}

/** Add to glossary, Add to summary, Close. */
function Keep({
  lectureId,
  selection,
  explanation,
  onClose,
  onKept,
}: {
  lectureId: string;
  selection: string;
  explanation: string;
  onClose: () => void;
  onKept: (entry?: GlossaryEntry) => void;
}) {
  const [busy, setBusy] = useState<"glossary" | "summary" | null>(null);
  const [glossary, setGlossary] = useState<Outcome | null>(null);
  const [summary, setSummary] = useState<Outcome | null>(null);
  const inGlossary = glossary?.text === explanation ? glossary : null;
  const inSummary = summary?.text === explanation ? summary : null;
  // A term is a word or a phrase; a whole passage can still go in the summary.
  const tooLong = selection.length > MAX_TERM;

  async function toGlossary() {
    if (busy || inGlossary?.ok || tooLong) return;
    setBusy("glossary");
    let outcome: Outcome;
    try {
      const res = await addGlossaryTerm({ lectureId, term: selection, explanation });
      if (res.ok) {
        noteGlossaryAdded(res.entry);
        onKept(res.entry);
        // Let go of the selection so the new underline shows, rather than the highlight over it.
        const sel = document.getSelection();
        if (sel && oneLine(sel.toString()) === selection) sel.removeAllRanges();
        outcome = { text: explanation, ok: true, message: "Added — hover the underlined words to see this again" };
      } else {
        outcome = { text: explanation, ok: false, message: res.message };
      }
    } catch (err) {
      outcome = { text: explanation, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    setBusy(null);
    setGlossary(outcome);
  }

  async function toSummary() {
    if (busy || inSummary?.ok) return;
    setBusy("summary");
    const res = await addToLectureSummary(lectureId, explanation, { under: selection });
    setBusy(null);
    setSummary({ text: explanation, ok: res.ok, message: res.message });
    if (res.ok) onKept();
  }

  return (
    <div className="st-keep">
      <div className="st-actions">
        <button
          type="button"
          className="btn primary sm"
          onClick={toGlossary}
          aria-disabled={!!busy || !!inGlossary?.ok || tooLong}
        >
          {inGlossary?.ok ? (
            <>
              <Icon name="check" size={13} /> In glossary
            </>
          ) : busy === "glossary" ? (
            "Adding…"
          ) : (
            <>
              <Icon name="book" size={13} /> Add to glossary
            </>
          )}
        </button>
        <button type="button" className="btn sm" onClick={toSummary} aria-disabled={!!busy || !!inSummary?.ok}>
          {inSummary?.ok ? (
            <>
              <Icon name="check" size={13} /> In summary
            </>
          ) : busy === "summary" ? (
            "Adding…"
          ) : (
            <>
              <Icon name="plus" size={13} /> Add to summary
            </>
          )}
        </button>
        <button type="button" className="btn quiet sm" onClick={onClose}>
          Close
        </button>
      </div>
      {tooLong && <p className="st-note">Too long for the glossary — select a word or a short phrase to keep it there.</p>}
      {inGlossary && (
        <p className={`result ${inGlossary.ok ? "ok" : "err"} st-msg`} role="status">
          {inGlossary.message}
        </p>
      )}
      {inSummary && (
        <p className={`result ${inSummary.ok ? "ok" : "err"} st-msg`} role="status">
          {inSummary.message}
        </p>
      )}
    </div>
  );
}
