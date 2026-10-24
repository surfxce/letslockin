"use client";

import { useEffect, useMemo, useState } from "react";

import type { GlossaryEntry } from "@/app/study-actions";
import { GlossaryHighlights, GlossaryList, SelectionTools } from "@/app/ui/SummaryTools";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
import { SlideCropper } from "@/app/ui/SlideCropper";
import { SlideOccluder } from "@/app/ui/SlideOccluder";
import { SummaryEditor } from "@/app/ui/SummaryEditor";
import type { SlideImages } from "@/lib/markdown";
import type { Mode } from "@/lib/modes";

const CONTAINER = "lecture-summary";

function readDraft(lectureId: string, md: string): number | null {
  try {
    const raw = localStorage.getItem(`lockin.summaryDraft.${lectureId}`);
    if (!raw) return null;
    const draft = JSON.parse(raw) as { markdown?: string; base?: string; at?: number };
    return draft.base === md && draft.markdown !== md && typeof draft.at === "number" ? draft.at : null;
  } catch {
    return null;
  }
}

/** Where reading happens: just under the top bar. */
const READING_LINE = 64;

/**
 * Remembers how far down a summary the student had read, and takes them back there
 * next time. Kept as "this paragraph, this far in" rather than a pixel offset, so
 * slide pictures loading above it don't throw it off.
 */
function useReadingPlace(lectureId: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const key = `lockin.readAt.${lectureId}`;
    const blocks = () => [...(document.querySelector(`#${CONTAINER} .prose`)?.children ?? [])] as HTMLElement[];
    let saved: { block: number; offset: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      // Nothing remembered.
    }

    // Once the student scrolls themselves, their place wins over the remembered one.
    let moved = false;
    const mine = () => {
      moved = true;
    };
    const restore = () => {
      const el = saved && !moved ? blocks()[saved.block] : null;
      if (!el || !saved) return;
      window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - (READING_LINE - saved.offset) });
    };
    // After the page's own scroll to the top, and again once pictures above have loaded.
    const timers = saved ? [setTimeout(restore, 80), setTimeout(restore, 900)] : [];

    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      try {
        if (window.scrollY < 120) return localStorage.removeItem(key);
        const list = blocks();
        const i = list.findIndex((b) => b.getBoundingClientRect().bottom > READING_LINE);
        if (i === -1) return;
        const offset = READING_LINE - list[i].getBoundingClientRect().top;
        localStorage.setItem(key, JSON.stringify({ block: i, offset: Math.round(offset) }));
      } catch {
        // Storage unavailable: the place just isn't kept.
      }
    };
    const onScroll = () => {
      clearTimeout(timer);
      const wait = Date.now() - last > 400 ? 0 : 250;
      timer = setTimeout(() => {
        last = Date.now();
        save();
      }, wait);
    };
    const events = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    events.forEach((e) => window.addEventListener(e, mine, { passive: true }));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, mine));
      window.removeEventListener("scroll", onScroll);
    };
  }, [lectureId, active]);
}

/**
 * A lecture's summary as it is read — select any of it to have it broken down, hover
 * an underlined term for its explanation — and, on Edit, as it is written.
 */
export function SummaryView({
  lectureId,
  md,
  slides,
  mode,
  terms,
}: {
  lectureId: string;
  md: string;
  slides: SlideImages;
  mode: Mode;
  terms: GlossaryEntry[];
}) {
  const [editing, setEditing] = useState(false);
  // Unsaved edits left from an earlier visit, so leaving the page never loses them.
  const [draftAt, setDraftAt] = useState<number | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
  useEffect(() => setDraftAt(editing ? null : readDraft(lectureId, md)), [lectureId, md, editing]);

  // React sets dangerouslySetInnerHTML again whenever it gets a new object — on every
  // re-render, such as each background refresh — which would drop a selection the
  // student is making. The same element between renders leaves the summary alone.
  const slidesKey = JSON.stringify(slides);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- slides arrive as a new object on every refresh
  const body = useMemo(() => <Markdown md={md} slides={{ ...slides, croppable: true }} />, [md, slidesKey]);
  useReadingPlace(lectureId, !editing);

  if (editing) {
    return (
      <SummaryEditor key={lectureId} lectureId={lectureId} markdown={md} slides={slides} onDone={() => setEditing(false)} />
    );
  }

  return (
    <>
      <div className="summary-bar">
        {draftAt && (
          <span className="small muted">
            You have unsaved edits from {new Date(draftAt).toLocaleString()}.
          </span>
        )}
        <button type="button" className={draftAt ? "btn sm" : "btn quiet sm"} onClick={() => setEditing(true)}>
          <Icon name="pen" size={13} /> {draftAt ? "Continue editing" : "Edit"}
        </button>
      </div>
      <div id={CONTAINER}>{body}</div>
      <SelectionTools lectureId={lectureId} mode={mode} containerId={CONTAINER} slides={slides} />
      <SlideCropper lectureId={lectureId} containerId={CONTAINER} base={slides.base} />
      <SlideOccluder lectureId={lectureId} containerId={CONTAINER} base={slides.base} />
      <GlossaryHighlights containerId={CONTAINER} terms={terms} watch={md} />
      <GlossaryList terms={terms} />
    </>
  );
}
