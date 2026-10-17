"use client";

import { useEffect, useRef, useState } from "react";

/** Who wrote a lecture's summary and LAQs, and how its last AI run went. */
export interface ModelInfoData {
  /** Null when there is no summary; "" when it was written before Lockin kept track. */
  summary: string | null;
  laqs: Array<{ model: string; count: number }>;
  lastRun: {
    what: string;
    model: string | null;
    durationMs: number | null;
    finishedAt: string;
    /** Why Claude was passed over for the offline model, when it was. */
    fellBack: string | null;
  } | null;
}

function took(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * A small ⓘ beside the lecture's number. Hover or click shows which model wrote what —
 * worth knowing when a summary reads oddly, or after switching models in Settings.
 */
export function ModelInfo({ info }: { info: ModelInfoData }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pinned]);

  const nothing = info.summary === null && info.laqs.length === 0 && !info.lastRun;

  return (
    <span
      ref={wrap}
      className="menu-wrap model-info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => !pinned && setOpen(false)}
    >
      <button
        type="button"
        className="model-info-btn"
        aria-label="Which AI model wrote this lecture's summary and LAQs"
        aria-expanded={open}
        onClick={() => {
          setPinned((p) => !p);
          setOpen((o) => (pinned ? !o : true));
        }}
      >
        i
      </button>
      {open && (
        <div className="popover model-info-pop" role="dialog" aria-label="Models used">
          {nothing ? (
            <p>No AI has worked on this lecture yet.</p>
          ) : (
            <dl>
              {info.summary !== null && (
                <>
                  <dt>Summary</dt>
                  <dd>{info.summary || <span className="faint">written before Lockin recorded the model</span>}</dd>
                </>
              )}
              {info.laqs.length > 0 && (
                <>
                  <dt>LAQs</dt>
                  <dd>
                    {info.laqs.map((l) => (
                      <div key={l.model}>
                        {l.count} by {l.model}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {info.lastRun && (
                <>
                  <dt>Last run</dt>
                  <dd>
                    {info.lastRun.what}
                    {info.lastRun.model ? ` on ${info.lastRun.model}` : ""}
                    {info.lastRun.durationMs ? `, took ${took(info.lastRun.durationMs)}` : ""}
                    <div className="faint">{new Date(info.lastRun.finishedAt).toLocaleString()}</div>
                    {info.lastRun.fellBack && (
                      <div className="model-info-fell">The cloud AI failed, so the offline model did it: {info.lastRun.fellBack}</div>
                    )}
                  </dd>
                </>
              )}
            </dl>
          )}
          <p className="faint small">Choose the AI and its model in Settings.</p>
        </div>
      )}
    </span>
  );
}
