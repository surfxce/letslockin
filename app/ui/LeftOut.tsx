"use client";

import "./left-out.css";

import { useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { EditResult } from "@/app/study-actions";
import { addLeftOutPart, useAsk } from "@/app/ui/ask";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import {
  leftOutAction,
  leftOutButton,
  leftOutHint,
  partKeys,
  partsLabel,
  placeCard,
  waited,
  type LeftOutPart,
} from "@/lib/left-out";

export type { LeftOutPart } from "@/lib/left-out";

const OPEN_KEY = "lockin.leftOutOpen";
/** Long enough that sweeping the pointer across the list doesn't flash every card. */
const SHOW_MS = 280;
/** Focus is deliberate, so its card comes sooner. */
const FOCUS_MS = 80;
/** Time to cross the gap from a chip to its card. */
const HIDE_MS = 180;

const WHY = "Not lecture content, so not summarised or examined";

/**
 * The parts of a lecture left out of its summary — aims, objectives, housekeeping —
 * folded to one line. Opened, each part shows what it said on hover, and a click puts
 * it back into the summary (or first asks the AI what it said, if nobody has read it).
 */
export function LeftOut(props: { lectureId: string; items: LeftOutPart[]; canAsk: boolean }) {
  // Another lecture starts afresh: an answer about one part never carries over.
  return <LeftOutList key={props.lectureId} {...props} />;
}

/** Which part's card is showing; pinned by a click or tap, so leaving it doesn't close it. */
interface Shown {
  key: string;
  pinned: boolean;
  /** Opened by a tap: the card carries the button a click would otherwise be. */
  touch: boolean;
}

/** How a part's chip opens and closes its card. Stable for the life of the list. */
interface Card {
  enter(key: string, delay: number): void;
  /** The pointer or focus has gone. A pinned card stays unless `pinnedToo`. */
  leave(pinnedToo?: boolean): void;
  /** A click or tap on a chip. True when the click should also do the part's action. */
  press(key: string, touch: boolean): boolean;
  close(): void;
}

function LeftOutList({ lectureId, items, canAsk }: { lectureId: string; items: LeftOutPart[]; canAsk: boolean }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const timers = useRef<{ show?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout> }>({});
  const listId = useId();
  const keys = partKeys(items);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
      if (localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
    } catch {
      // Storage blocked: start folded.
    }
  }, []);

  const card = useMemo<Card>(() => {
    const clear = () => {
      clearTimeout(timers.current.show);
      clearTimeout(timers.current.hide);
    };
    return {
      enter(key, delay) {
        clear();
        timers.current.show = setTimeout(
          () => setShown((s) => (s?.key === key ? s : { key, pinned: false, touch: false })),
          delay,
        );
      },
      leave(pinnedToo = false) {
        clear();
        timers.current.hide = setTimeout(() => setShown((s) => (s && (pinnedToo || !s.pinned) ? null : s)), HIDE_MS);
      },
      press(key, touch) {
        clear();
        if (touch) {
          // First tap opens the card; a second tap on the chip closes it again.
          setShown((s) => (s?.key === key && s.pinned ? null : { key, pinned: true, touch: true }));
          return false;
        }
        setShown({ key, pinned: true, touch: false });
        return true;
      },
      close() {
        clear();
        setShown(null);
      },
    };
  }, []);

  useEffect(() => () => card.close(), [card]);

  if (items.length === 0) return null;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) card.close();
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Not remembered, but it still opens.
    }
  }

  return (
    <div className="lo" data-open={open || undefined}>
      <button
        type="button"
        className="lo-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={listId}
        title={WHY}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        {partsLabel(items.length)}
      </button>
      {/* Kept mounted while folded, so an answer being waited for still arrives. */}
      <ul className="lo-list" id={listId} hidden={!open} aria-label="Left out of the summary">
        {items.map((part, i) => (
          <Part
            key={keys[i]}
            partKey={keys[i]}
            part={part}
            lectureId={lectureId}
            canAsk={canAsk}
            shown={shown?.key === keys[i] ? shown : null}
            card={card}
          />
        ))}
      </ul>
    </div>
  );
}

function Part({
  partKey,
  part,
  lectureId,
  canAsk,
  shown,
  card,
}: {
  partKey: string;
  part: LeftOutPart;
  lectureId: string;
  canAsk: boolean;
  shown: Shown | null;
  card: Card;
}) {
  const router = useRouter();
  const { state: asked, ask } = useAsk();
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<EditResult | null>(null);
  const [now, setNow] = useState(0);
  // How the last press began, so a tap can open the card instead of acting at once.
  const lastPointer = useRef<string | null>(null);
  const itemRef = useRef<HTMLLIElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const hintId = useId();

  const isShown = !!shown;
  const waiting = asked.status === "waiting";
  const result = asked.status === "done" ? asked.result : null;
  const notFound = result?.found === false ? result.answer : null;
  // What it said: from the page once it knows, from the answer until then.
  const about = part.about ?? (result && result.found !== false ? result.answer : undefined);
  const added = !!part.added || !!outcome?.ok;
  const action = leftOutAction({ about, added }, { canAsk, busy: adding || waiting, notFound: !!notFound });
  const hint = leftOutHint(action, { canAsk, notFound: !!notFound });
  const button = shown?.touch ? leftOutButton(action) : null;
  // A failure only matters while the same thing can still be tried again.
  const error =
    action === "add" && outcome && !outcome.ok
      ? outcome.message
      : action === "ask" && asked.status === "error"
        ? asked.message
        : null;

  // The answer is saved on the lecture; refreshing brings it into the page's own list.
  useEffect(() => {
    if (!result || result.found === false) return;
    if (!window.__lockinHoldRefresh) router.refresh();
  }, [result, router]);

  // A ticking clock while the AI reads, for the card.
  useEffect(() => {
    if (!waiting || !isShown) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [waiting, isShown]);

  // The card sits beside its chip, inside the window, after every render that may resize it.
  useLayoutEffect(() => {
    if (isShown && cardRef.current && chipRef.current) placeAt(cardRef.current, chipRef.current);
  });

  useEffect(() => {
    if (!isShown) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const chip = chipRef.current;
        if (!chip || !cardRef.current) return;
        // Scrolled out of sight: a card floating over unrelated text would only confuse.
        const r = chip.getBoundingClientRect();
        if (r.bottom < 0 || r.top > document.documentElement.clientHeight) return card.close();
        placeAt(cardRef.current, chip);
      });
    };
    // Escape closes the card from the chip or the card, or when nothing else has focus.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as Node | null;
      const inside = !!target && !!itemRef.current?.contains(target);
      if (!inside && target !== document.body && target !== document.documentElement) return;
      if (target && cardRef.current?.contains(target)) chipRef.current?.focus();
      card.close();
    };
    const away = (e: PointerEvent) => {
      if (!itemRef.current?.contains(e.target as Node)) card.close();
    };
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", away);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", away);
    };
  }, [isShown, card]);

  async function add() {
    setAdding(true);
    setOutcome(null);
    // Just found out, before the page has refreshed: the worker has saved it already.
    const res: EditResult = about
      ? await addLeftOutPart(lectureId, { what: part.what, about })
      : { ok: false, message: "Lockin doesn't know what that part said yet." };
    setAdding(false);
    setOutcome(res);
  }

  function act() {
    if (action === "add") void add();
    else if (action === "ask") void ask({ lectureId, kind: "leftout", what: part.what });
    else if (action === "added") setOutcome({ ok: true, message: "It's already in your summary." });
  }

  function onChipClick() {
    const touch = lastPointer.current === "touch";
    lastPointer.current = null;
    if (card.press(partKey, touch)) act();
  }

  /** A button inside the card: the chip keeps focus, as the button may be gone once pressed. */
  function actFromCard() {
    chipRef.current?.focus();
    act();
  }

  const where = part.where.trim();
  const announce = adding
    ? ""
    : (outcome?.message ??
      (asked.status === "error"
        ? asked.message
        : result
          ? result.found === false
            ? "Lockin couldn't find what this part said."
            : `Found what ${part.what} said.`
          : ""));
  const srHint =
    action === "busy"
      ? adding
        ? "Adding…"
        : "Finding out what it said…"
      : (hint?.replace(/^✓\s*/, "") ?? (notFound ? "Lockin couldn't find what this part said." : ""));

  let body: React.ReactNode;
  if (about) {
    body = <Markdown md={about} className="prose lo-about" />;
  } else if (asked.status === "waiting") {
    body = (
      <>
        <div className="lo-wait">
          <span className="lo-spin" aria-hidden="true" />
          <span>Finding out what it said… {waited(now - asked.startedAt)}</span>
        </div>
        {!asked.workerAlive && (
          <p className="lo-note lo-warn">
            The AI worker isn&apos;t running, so nothing will answer yet. The desktop app starts it for you; from the
            repository run <code>npm run worker</code>.
          </p>
        )}
      </>
    );
  } else if (notFound) {
    body = <p className="lo-note">{notFound}</p>;
  } else {
    body = <p className="lo-unread">Lockin hasn&apos;t read this part yet.</p>;
  }

  let foot: React.ReactNode = null;
  if (adding) {
    foot = (
      <div className="lo-foot lo-wait">
        <span className="lo-spin" aria-hidden="true" />
        <span>Adding…</span>
      </div>
    );
  } else if (error) {
    foot = (
      <div className="lo-foot">
        <p className="result err lo-msg">{error}</p>
        <button type="button" className="btn sm" onClick={actFromCard}>
          <Icon name="refresh" size={13} /> Try again
        </button>
      </div>
    );
  } else if (outcome?.ok) {
    foot = (
      <div className="lo-foot result ok">
        <Icon name="check" size={13} /> {outcome.message}
      </div>
    );
  } else if (button) {
    foot = (
      <div className="lo-foot">
        <button type="button" className="btn primary sm" onClick={actFromCard}>
          <Icon name={action === "add" ? "plus" : "sparkles"} size={13} /> {button}
        </button>
      </div>
    );
  } else if (hint) {
    foot = <div className="lo-foot lo-hint">{hint}</div>;
  }

  return (
    <li
      ref={itemRef}
      className="lo-item"
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") card.enter(partKey, SHOW_MS);
      }}
      // The card stays while either the pointer or keyboard focus is on the part.
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch" && !itemRef.current?.querySelector(":focus-visible")) card.leave();
      }}
      onFocus={() => card.enter(partKey, FOCUS_MS)}
      onBlur={(e) => {
        const li = itemRef.current;
        // Clicking the card's text to select it moves focus away, but the pointer is still here.
        if (li && !li.contains(e.relatedTarget as Node | null) && !li.matches(":hover")) card.leave(true);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !isShown) return;
        // Handled here, so the document's listener doesn't close anything else too.
        e.preventDefault();
        if (cardRef.current?.contains(e.target as Node)) chipRef.current?.focus();
        card.close();
      }}
    >
      <button
        ref={chipRef}
        type="button"
        className={`tag ${added ? "t-green" : "t-gray"} lo-chip`}
        data-shown={isShown || undefined}
        aria-describedby={isShown ? cardId : hintId}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
        }}
        onClick={onChipClick}
      >
        {added && <Icon name="check" size={12} className="lo-check" />}
        {action === "busy" && <span className="dot pulse" aria-hidden="true" />}
        <span className="lo-label">
          {part.what}
          {where && <span className="lo-where"> · {where}</span>}
        </span>
      </button>
      <span id={hintId} className="sr-only">
        {srHint}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {isShown && (
        <div ref={cardRef} id={cardId} className="lo-card" data-touch={shown.touch || undefined}>
          {body}
          {foot}
        </div>
      )}
    </li>
  );
}

/** Puts a part's card beside its chip, inside the window. */
function placeAt(cardEl: HTMLElement, chip: HTMLElement) {
  const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  const { top, left, side } = placeCard(
    chip.getBoundingClientRect(),
    { width: cardEl.offsetWidth, height: cardEl.offsetHeight },
    viewport,
  );
  cardEl.style.top = `${top}px`;
  cardEl.style.left = `${left}px`;
  cardEl.dataset.side = side;
}
