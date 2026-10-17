"use client";

import "./attempt.css";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/app/ui/Icon";
import { MISSED_MARK, PARTIAL_MARK, WRONG_MARK, type NotesSheet as Sheet } from "@/lib/notes-sheet";
import { plainInline } from "@/lib/summary-edit";

/**
 * After marking: what to write into your notes, from the marking itself — the facts
 * that were wrong (stated correctly) and the ones that were missed. Copies as
 * Markdown for a notes app, as plain text for anywhere else, or saves as a file.
 */
export function NotesSheet({
  sheet,
  pending = 0,
  manual = false,
  fileName,
}: {
  /** buildNotesSheet(…) from lib/notes-sheet.ts, built on the server. */
  sheet: Sheet;
  /** Answers not marked yet; their notes join the sheet once they are. */
  pending?: number;
  /** Copy & paste mode: marking arrives when it is pasted in, not by itself. */
  manual?: boolean;
  /** For "Download .md": notesFileName(…) from lib/notes-sheet.ts. */
  fileName: string;
}) {
  const [fallback, setFallback] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const has = sheet.count > 0;

  const later = manual ? "once the rest of the marking is pasted in" : "as marking finishes";

  function download() {
    const url = URL.createObjectURL(new Blob([sheet.markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="ns" aria-labelledby="ns-title">
      <div className="ns-head">
        <div className="ns-titles">
          <h2 id="ns-title" className="ns-title">
            Notes to copy down
          </h2>
          {has && (
            <span className="ns-count">
              {sheet.count} point{sheet.count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {has && (
          <div className="ns-actions">
            <CopyText
              text={sheet.markdown}
              label="Copy"
              title="Copy as Markdown — for Notion, Obsidian and other notes apps"
              onBlocked={(text, button) => {
                opener.current = button;
                setFallback(text);
              }}
            />
            <CopyText
              text={sheet.plain}
              label="Copy as plain text"
              onBlocked={(text, button) => {
                opener.current = button;
                setFallback(text);
              }}
            />
            <button type="button" className="btn sm quiet" onClick={download} title={`Save as ${fileName}`}>
              <Icon name="download" size={14} />
              Download .md
            </button>
          </div>
        )}
      </div>

      {has ? (
        <>
          {/* The markers explained; each point also says it in words for screen readers. */}
          <p className="ns-key" aria-hidden="true">
            <span>
              <span className="ns-mark ns-wrong">{WRONG_MARK}</span> had it wrong — the correct fact
            </span>
            <span>
              <span className="ns-mark ns-partial">{PARTIAL_MARK}</span> partly right — what was short
            </span>
            <span>
              <span className="ns-mark ns-missed">{MISSED_MARK}</span> missed — add it
            </span>
          </p>
          <div className="ns-sections">
            {sheet.sections.map((s, i) => (
              <div key={i} className="ns-section">
                <h3 className="ns-heading">
                  {plainInline(s.heading)}
                  {s.by === "concept" && <span className="ns-from">LAQ {s.from.join(", ")}</span>}
                </h3>
                <ul className="ns-points">
                  {s.wrong.map((t, j) => (
                    <li key={`w${j}`}>
                      <span className="ns-mark ns-wrong" aria-hidden="true">
                        {WRONG_MARK}
                      </span>
                      <span className="sr-only">Had it wrong: </span>
                      <span>{plainInline(t)}</span>
                    </li>
                  ))}
                  {s.partial.map((t, j) => (
                    <li key={`p${j}`}>
                      <span className="ns-mark ns-partial" aria-hidden="true">
                        {PARTIAL_MARK}
                      </span>
                      <span className="sr-only">Partly right: </span>
                      <span>{plainInline(t)}</span>
                    </li>
                  ))}
                  {s.missed.map((t, j) => (
                    <li key={`m${j}`}>
                      <span className="ns-mark ns-missed" aria-hidden="true">
                        {MISSED_MARK}
                      </span>
                      <span className="sr-only">Missed: </span>
                      <span>{plainInline(t)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {pending > 0 && <p className="ns-note">More will appear {later}.</p>}
        </>
      ) : pending > 0 ? (
        <p className="ns-note">What you missed and got wrong will appear here {later}.</p>
      ) : (
        <p className="ns-note ns-clear">
          <Icon name="check" size={14} />
          Nothing to copy down — you hit every marking point.
        </p>
      )}

      {fallback !== null && (
        <CopyFallback
          text={fallback}
          onClose={() => {
            setFallback(null);
            opener.current?.focus();
          }}
        />
      )}
    </section>
  );
}

/** A copy button that says it worked, and hands over to a select-all box when the clipboard is blocked. */
function CopyText({
  text,
  label,
  title,
  onBlocked,
}: {
  text: string;
  label: string;
  title?: string;
  onBlocked: (text: string, button: HTMLButtonElement | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      onBlocked(text, button.current);
    }
  }

  return (
    <button ref={button} type="button" className="btn sm" onClick={copy} title={title} aria-live="polite">
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? "Copied" : label}
    </button>
  );
}

function CopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-fallback-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-body">
          <h2 id="ns-fallback-title">Copy your notes</h2>
          <p>Your browser blocked the clipboard. Everything is selected below — copy it with ⌘C or Ctrl+C.</p>
          <textarea
            className="ns-fallback-text"
            readOnly
            value={text}
            rows={14}
            onFocus={(e) => e.currentTarget.select()}
            autoFocus
          />
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
