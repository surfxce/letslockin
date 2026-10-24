"use client";

import "./summary-tools.css";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { removeGlossaryTerm, type GlossaryEntry } from "@/app/study-actions";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import { renderMarkdown } from "@/lib/markdown";
import { mergeGlossary, placeNear, termPieces, type Rect, type Side } from "@/lib/summary-tools";

/**
 * A lecture's glossary on its summary: every term underlined where it appears, its
 * explanation on hover or focus, and the whole list folded under the summary.
 */

// ---------------------------------------------------------------------------
// Terms added or removed in this window, shown at once rather than when the page
// next refreshes. The server's copy takes over as soon as it has caught up.

interface Local {
  added: GlossaryEntry[];
  removed: ReadonlySet<string>;
}

const NONE: Local = { added: [], removed: new Set() };
/** Long enough for any refresh to arrive; a term the server never confirms stops showing. */
const KEEP_MS = 60_000;

let local: Local = NONE;
const listeners = new Set<() => void>();

function update(next: Local) {
  local = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const sameTerm = (a: GlossaryEntry, b: GlossaryEntry) => a.id === b.id || a.term.toLowerCase() === b.term.toLowerCase();

/** A term just added from this window: underlined and listed straight away. */
export function noteGlossaryAdded(entry: GlossaryEntry) {
  const removed = new Set(local.removed);
  removed.delete(entry.id);
  update({ added: [...local.added.filter((e) => !sameTerm(e, entry)), entry], removed });
  setTimeout(() => {
    if (local.added.includes(entry)) update({ ...local, added: local.added.filter((e) => e !== entry) });
  }, KEEP_MS);
}

/** A term just removed from this window: gone from the page straight away. */
export function noteGlossaryRemoved(id: string) {
  update({ added: local.added.filter((e) => e.id !== id), removed: new Set(local.removed).add(id) });
}

/** The removal failed, so the term is back. */
function noteGlossaryKept(id: string) {
  const removed = new Set(local.removed);
  removed.delete(id);
  update({ ...local, removed });
}

/** Forgets what the server now knows: terms it has, and removals it has made. */
function settle(server: GlossaryEntry[]) {
  const added = local.added.filter((e) => !server.some((s) => sameTerm(s, e)));
  const removed = new Set([...local.removed].filter((id) => server.some((s) => s.id === id)));
  if (added.length !== local.added.length || removed.size !== local.removed.size) update({ added, removed });
}

/** The glossary as this window should show it. */
function useGlossary(server: GlossaryEntry[]): GlossaryEntry[] {
  const mine = useSyncExternalStore(
    subscribe,
    () => local,
    () => NONE,
  );
  useEffect(() => settle(server), [server]);
  return useMemo(() => mergeGlossary(server, mine.added, mine.removed), [server, mine]);
}

async function removeTerm(id: string) {
  noteGlossaryRemoved(id);
  try {
    await removeGlossaryTerm(id);
  } catch {
    noteGlossaryKept(id);
  }
}

// ---------------------------------------------------------------------------
// Floating cards, shared with SelectionTools

/** An element's place on screen; for words wrapped over two lines, centred on the first. */
export function rectOf(el: Element): Rect {
  const lines = el.getClientRects();
  if (lines.length === 0) {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }
  const first = lines[0];
  return { top: first.top, bottom: lines[lines.length - 1].bottom, left: first.left, right: first.right };
}

/** Puts a fixed-position card beside `anchor`, inside the window. */
export function floatAt(card: HTMLElement, anchor: Rect, prefer: Side) {
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const { top, left, side } = placeNear(anchor, { width: card.offsetWidth, height: card.offsetHeight }, viewport, { prefer });
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
  card.dataset.side = side;
}

// ---------------------------------------------------------------------------
// Underlining

/** Text never underlined: links, code, buttons, slide pictures and their captions. */
const SKIP = "a, code, pre, button, figure, script, style, textarea, input, select, svg, .gloss, .slide-error, [contenteditable]";
/** What a term can't run across. */
const BLOCK =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, caption, blockquote, dd, dt, div, section, article, ul, ol, dl, table, tr, details, summary";

function unwrapTerms(root: HTMLElement) {
  const spans = root.querySelectorAll("span.gloss");
  if (spans.length === 0) return;
  const parents = new Set<Node>();
  spans.forEach((span) => {
    if (!span.parentNode) return;
    parents.add(span.parentNode);
    span.replaceWith(...span.childNodes);
  });
  // Back to the text nodes the summary was rendered with, so wrapping again starts clean.
  parents.forEach((p) => p.normalize());
}

function wrapTerms(root: HTMLElement, terms: GlossaryEntry[]) {
  if (terms.length === 0) return;
  const texts: Text[] = [];
  const runs: number[] = [];
  let run = -1;
  let block: Element | null = null;
  let broken = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = node as Element;
      if (el.matches(SKIP)) return NodeFilter.FILTER_REJECT;
      return el.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // A line break ends a run of text as surely as a new paragraph does.
    if (node.nodeType !== Node.TEXT_NODE) {
      broken = true;
      continue;
    }
    const inside = node.parentElement?.closest(BLOCK) ?? root;
    if (inside !== block || broken) {
      run++;
      block = inside;
      broken = false;
    }
    texts.push(node as Text);
    runs.push(run);
  }

  const pieces = termPieces(
    texts.map((t) => t.data),
    runs,
    terms.map((t) => t.term),
  );
  // Back to front: splitting a text node then never moves a piece still to be wrapped.
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    const node = texts[p.node];
    if (p.end < node.length) node.splitText(p.end);
    const piece = p.start > 0 ? node.splitText(p.start) : node;
    const span = document.createElement("span");
    span.className = "gloss";
    span.dataset.gloss = terms[p.term].id;
    span.dataset.glossMatch = String(p.range);
    // One stop per term for Tab, even when formatting splits it into pieces.
    if (i === 0 || pieces[i - 1].range !== p.range) span.tabIndex = 0;
    piece.before(span);
    span.append(piece);
  }
}

const glossOf = (target: EventTarget | null, root: HTMLElement | null): HTMLElement | null => {
  if (!root || !(target instanceof Element)) return null;
  const span = target.closest<HTMLElement>("span.gloss");
  return span && root.contains(span) ? span : null;
};

/** The first piece of the term a span belongs to: where focus goes back to. */
const firstPiece = (root: HTMLElement | null, match: string) =>
  root?.querySelector<HTMLElement>(`span.gloss[data-gloss-match="${match}"]`) ?? null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SHOW_MS = 100;
const HIDE_MS = 150;

interface Tip {
  id: string;
  match: string;
  el: HTMLElement;
}

/**
 * Underlines the glossary's terms in the summary rendered in #containerId, and shows a
 * term's explanation when it is hovered, tapped or focused. The summary is static
 * HTML, so this wraps its words after each render; `watch` (the summary's Markdown)
 * says when it has been rendered afresh.
 */
export function GlossaryHighlights({
  containerId,
  terms,
  watch,
}: {
  containerId: string;
  terms: GlossaryEntry[];
  watch: string;
}) {
  const shown = useGlossary(terms);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<Tip | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tipId = useId();

  // Which words are terms is all the wrapping depends on: a page refresh that brings
  // the same glossary leaves the summary alone, and any selection in it with it.
  const words = shown.map((t) => `${t.id}\u0001${t.term}`).join("\u0002");
  const latest = useRef(shown);
  useEffect(() => {
    latest.current = shown;
    tipRef.current = tip;
  });

  useEffect(() => {
    const root = document.getElementById(containerId);
    if (!root) return;
    const apply = () => {
      unwrapTerms(root);
      wrapTerms(root, latest.current);
      // Our own wrapping is not a change to react to.
      observer.takeRecords();
      // The words a tip pointed at were wrapped afresh: it would point at nothing.
      if (tipRef.current && !tipRef.current.el.isConnected) {
        tipRef.current = null;
        setTip(null);
      }
    };
    // React sets a summary's HTML again whenever its Markdown component re-renders, even
    // with the same text, which takes the underlines with it: put them back each time.
    const observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList")) apply();
    });
    apply();
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      unwrapTerms(root);
    };
  }, [containerId, watch, words]);

  // The span a tip points at goes when the summary is rendered again or the term is removed.
  const entry = tip && tip.el.isConnected ? shown.find((t) => t.id === tip.id) : undefined;

  // Every piece of the shown term lights up together, and is described by the tip.
  useEffect(() => {
    if (!tip || !entry) return;
    const root = document.getElementById(containerId);
    const pieces = [...(root?.querySelectorAll<HTMLElement>(`span.gloss[data-gloss-match="${tip.match}"]`) ?? [])];
    pieces.forEach((p) => {
      p.classList.add("st-gloss-on");
      p.setAttribute("aria-describedby", tipId);
    });
    return () =>
      pieces.forEach((p) => {
        p.classList.remove("st-gloss-on");
        p.removeAttribute("aria-describedby");
      });
  }, [tip, entry, containerId, tipId]);

  useEffect(() => {
    const root = () => document.getElementById(containerId);
    const inTip = (n: EventTarget | null) => n instanceof Node && !!cardRef.current?.contains(n);
    const sameMatch = (span: HTMLElement | null) => !!span && span.dataset.glossMatch === tipRef.current?.match;
    let dismissed: string | null = null;
    const cancel = () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };
    const show = (span: HTMLElement) => {
      cancel();
      const id = span.dataset.gloss;
      const match = span.dataset.glossMatch;
      if (!id || !match) return;
      if (tipRef.current?.match === match && tipRef.current.el.isConnected) return;
      const next = { id, match, el: span };
      tipRef.current = next;
      setTip(next);
    };
    const hide = () => {
      cancel();
      tipRef.current = null;
      setTip(null);
    };
    const hideSoon = () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, HIDE_MS);
    };

    const onOver = (e: PointerEvent) => {
      const span = glossOf(e.target, root());
      if (!span) return;
      clearTimeout(hideTimer.current);
      if (sameMatch(span)) return;
      clearTimeout(showTimer.current);
      // Moving the mouse across a line shouldn't flash every term on the way; a tap, or
      // moving from one term to the next, shows at once.
      if (e.pointerType === "touch" || tipRef.current) show(span);
      else showTimer.current = setTimeout(() => show(span), SHOW_MS);
    };
    const onOut = (e: PointerEvent) => {
      const span = glossOf(e.target, root());
      if (!span) return;
      const to = e.relatedTarget;
      if (inTip(to)) return;
      const next = glossOf(to, root());
      if (next && next.dataset.glossMatch === span.dataset.glossMatch) return;
      hideSoon();
    };
    const onFocusIn = (e: FocusEvent) => {
      const span = glossOf(e.target, root());
      if (!span) return;
      // Focus handed back by Escape: the tip was just dismissed, so it stays away.
      if (dismissed === span.dataset.glossMatch) {
        dismissed = null;
        return;
      }
      show(span);
    };
    const onFocusOut = (e: FocusEvent) => {
      const span = glossOf(e.target, root());
      if (span && !inTip(e.relatedTarget) && !sameMatch(glossOf(e.relatedTarget, root()))) hideSoon();
    };
    const onClick = (e: MouseEvent) => {
      const span = glossOf(e.target, root());
      // A drag that ended on a term was selecting text, not asking about the term.
      if (span && document.getSelection()?.isCollapsed !== false) show(span);
    };
    const onDown = (e: PointerEvent) => {
      if (tipRef.current && !inTip(e.target) && !glossOf(e.target, root())) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      const current = tipRef.current;
      if (!current) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        const back = inTip(document.activeElement);
        hide();
        if (back) {
          dismissed = current.match;
          firstPiece(root(), current.match)?.focus();
          dismissed = null;
        }
        return;
      }
      // Tab from a term goes into its tip, so Remove can be reached from the keyboard.
      if (e.key === "Tab" && !e.shiftKey && sameMatch(glossOf(e.target, root()))) {
        const button = cardRef.current?.querySelector<HTMLElement>("button");
        if (button) {
          e.preventDefault();
          button.focus();
        }
      }
    };
    const onScroll = (e: Event) => {
      if (tipRef.current && !inTip(e.target)) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      cancel();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [containerId]);

  if (!tip || !entry) return null;

  const keepOpen = () => clearTimeout(hideTimer.current);
  const hideSoon = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      tipRef.current = null;
      setTip(null);
    }, HIDE_MS);
  };

  return createPortal(
    <GlossTip
      ref={cardRef}
      id={tipId}
      entry={entry}
      anchor={tip.el}
      onPointerEnter={keepOpen}
      onPointerLeave={(e) => {
        const next = glossOf(e.relatedTarget, document.getElementById(containerId));
        if (next?.dataset.glossMatch !== tip.match) hideSoon();
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && (e.currentTarget.contains(to) || tip.el.contains(to))) return;
        hideSoon();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const inside = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const at = inside.indexOf(document.activeElement as HTMLElement);
        const root = document.getElementById(containerId);
        if (e.shiftKey && at <= 0) {
          // Back to the term the tip is about.
          e.preventDefault();
          firstPiece(root, tip.match)?.focus();
        } else if (!e.shiftKey && at === inside.length - 1) {
          // On to whatever follows the term on the page.
          const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (el) => !e.currentTarget.contains(el) && el.getClientRects().length > 0,
          );
          const from = firstPiece(root, tip.match);
          const at = from ? all.indexOf(from) : -1;
          const next = at >= 0 ? all.slice(at + 1).find((el) => el.dataset.glossMatch !== tip.match) : null;
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }
      }}
      onRemove={() => {
        const focused = cardRef.current?.contains(document.activeElement);
        // The term's words stay; focus goes to the line they're on rather than nowhere.
        const line = tip.el.closest<HTMLElement>(BLOCK);
        tipRef.current = null;
        setTip(null);
        void removeTerm(entry.id);
        if (focused && line) {
          if (!line.hasAttribute("tabindex")) {
            line.tabIndex = -1;
            line.addEventListener("blur", () => line.removeAttribute("tabindex"), { once: true });
          }
          line.focus({ preventScroll: true });
        }
      }}
    />,
    document.body,
  );
}

function GlossTip({
  ref,
  id,
  entry,
  anchor,
  onRemove,
  ...handlers
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  id: string;
  entry: GlossaryEntry;
  anchor: HTMLElement;
  onRemove: () => void;
  onPointerEnter: () => void;
  onPointerLeave: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const html = useMemo(() => renderMarkdown(entry.explanation), [entry.explanation]);

  useLayoutEffect(() => {
    if (ref.current) floatAt(ref.current, rectOf(anchor), "below");
  }, [ref, anchor, html]);

  return (
    <div
      ref={ref}
      id={id}
      className="st-tip"
      role="dialog"
      aria-label={`${entry.term} — from your glossary`}
      {...handlers}
    >
      <div className="st-tip-term">{entry.term}</div>
      <div className="prose st-tip-text" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="st-tip-foot">
        <button type="button" className="btn quiet sm st-tip-remove" onClick={onRemove}>
          <Icon name="trash" size={13} /> Remove from glossary
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list

/** Every term in the lecture's glossary, folded away under the summary until wanted. */
export function GlossaryList({ terms }: { terms: GlossaryEntry[] }) {
  const shown = useGlossary(terms);
  const summaryRef = useRef<HTMLElement>(null);
  const sorted = useMemo(
    () => [...shown].sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" })),
    [shown],
  );
  if (sorted.length === 0) return null;

  return (
    <details className="st-glossary">
      <summary ref={summaryRef}>
        <Icon name="chevronRight" size={14} className="st-glossary-chev" />
        Glossary · {sorted.length}
      </summary>
      <ul className="st-gl-list">
        {sorted.map((t) => (
          <li key={t.id} className="st-gl-item">
            <div className="st-gl-head">
              <strong className="st-gl-term">{t.term}</strong>
              <button
                type="button"
                className="icon-btn st-gl-remove"
                aria-label={`Remove “${t.term}” from the glossary`}
                title="Remove from glossary"
                onClick={(e) => {
                  // Its row is about to go: keep focus in the list rather than losing it.
                  if (e.currentTarget === document.activeElement) summaryRef.current?.focus();
                  void removeTerm(t.id);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            <Markdown md={t.explanation} className="prose st-gl-text" />
          </li>
        ))}
      </ul>
    </details>
  );
}
