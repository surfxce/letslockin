"use client";

import { useState } from "react";

import { Icon } from "@/app/ui/Icon";

/**
 * Copies a prompt that is built on the server (it carries the whole transcript, so
 * it is fetched on click rather than embedded in the page). If the clipboard is
 * unavailable, the text is shown to select by hand instead of failing quietly.
 */
export function CopyButton({
  url,
  label,
  className = "btn",
}: {
  url: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setState("copying");
    setError(null);
    const textPromise = fetch(url, { cache: "no-store" }).then(async (r) => {
      const body = await r.text();
      if (!r.ok) throw new Error(body || `HTTP ${r.status}`);
      return body;
    });
    try {
      // Safari only lets a clipboard write that starts inside the click; handing it
      // a promise keeps the gesture while the prompt is still being fetched.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": textPromise.then((t) => new Blob([t], { type: "text/plain" })) }),
        ]);
      } else {
        await navigator.clipboard.writeText(await textPromise);
      }
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      let text: string;
      try {
        text = await textPromise;
      } catch (fetchErr) {
        setError(fetchErr instanceof Error ? fetchErr.message : String(err));
        setState("error");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        setState("copied");
        setTimeout(() => setState("idle"), 2500);
      } catch {
        setFallback(text);
        setState("idle");
      }
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={copy} disabled={state === "copying"}>
        <Icon name={state === "copied" ? "check" : "copy"} />
        {state === "copied" ? "Copied — paste it into your AI chat" : state === "copying" ? "Copying…" : label}
      </button>
      {state === "error" && <span className="result err">{error}</span>}
      {fallback && (
        <div className="modal-backdrop" onClick={() => setFallback(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h2>Copy this prompt</h2>
              <p>Your browser blocked the clipboard. Select all of it, copy, and paste it into your AI chat.</p>
              <textarea
                readOnly
                value={fallback}
                rows={14}
                style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12 }}
                onFocus={(e) => e.currentTarget.select()}
                autoFocus
              />
            </div>
            <div className="modal-foot">
              <span className="spacer" />
              <button className="btn" onClick={() => setFallback(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
