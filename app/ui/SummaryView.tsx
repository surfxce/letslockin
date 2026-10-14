"use client";

import { useEffect, useMemo, useState } from "react";

import type { GlossaryEntry } from "@/app/study-actions";
import { GlossaryHighlights, GlossaryList, SelectionTools } from "@/app/ui/SummaryTools";
import { Icon } from "@/app/ui/Icon";
import { Markdown } from "@/app/ui/render";
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
  const body = useMemo(() => <Markdown md={md} slides={slides} />, [md, slidesKey]);

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
      <GlossaryHighlights containerId={CONTAINER} terms={terms} watch={md} />
      <GlossaryList terms={terms} />
    </>
  );
}
