"use client";

import "./handwriting.css";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/app/ui/Icon";

export interface HandwritingResult {
  text: string;
  unclear: string[];
  model: string | null;
  photos: number;
}

type State = { step: "idle" } | { step: "reading"; photos: number; since: number } | { step: "failed"; error: string };

/**
 * Photos of an answer written on paper, typed out by the AI in Settings — not the
 * computer's own text recognition, which handwriting defeats. The text lands in the
 * answer box to be checked against the page before it is submitted.
 */
export function HandwritingButton({ questionId, onRead }: { questionId: string; onRead: (read: HandwritingResult) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: "idle" });
  const [now, setNow] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.step !== "reading") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.step]);

  async function send(files: File[]) {
    if (!files.length) return;
    setState({ step: "reading", photos: files.length, since: Date.now() });
    setNow(Date.now());
    try {
      const form = new FormData();
      form.set("questionId", questionId);
      // In the order chosen, which is page order when they were taken in order.
      for (const f of [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name))) form.append("photo", f);
      const sent = await fetch("/api/handwriting", { method: "POST", body: form });
      const body = (await sent.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!sent.ok || !body.jobId) throw new Error(body.error ?? "Couldn't send those photos.");
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!alive.current) return;
        const res = await fetch(`/api/handwriting?job=${encodeURIComponent(body.jobId)}`, { cache: "no-store" });
        const st = (await res.json()) as { status: string; text?: string; unclear?: string[]; model?: string | null; error?: string };
        if (st.status === "failed") throw new Error(st.error ?? "The AI couldn't read it.");
        if (st.status === "done") {
          setState({ step: "idle" });
          onRead({ text: st.text ?? "", unclear: st.unclear ?? [], model: st.model ?? null, photos: files.length });
          return;
        }
      }
    } catch (err) {
      if (alive.current) setState({ step: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const reading = state.step === "reading";
  return (
    <span className="hw">
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void send(files);
        }}
      />
      <button
        type="button"
        className="btn sm quiet"
        disabled={reading}
        onClick={() => input.current?.click()}
        title="Wrote it on paper? Add a photo of each page and the AI types it out here for you to check."
      >
        <Icon name="upload" size={13} />{" "}
        {reading
          ? `Reading your handwriting… ${Math.max(0, Math.round((now - state.since) / 1000))}s`
          : "Add photos of a handwritten answer"}
      </button>
      {state.step === "failed" && (
        <span className="hw-error small" role="alert">
          {state.error}
        </span>
      )}
    </span>
  );
}

/** Under the box once the AI has typed it out: who read it, and the words to check. */
export function HandwritingNote({ read, onFind, onClose }: { read: HandwritingResult; onFind: (word: string) => void; onClose: () => void }) {
  return (
    <div className="hw-note small" role="status">
      <div>
        Typed out from {read.photos === 1 ? "your photo" : `your ${read.photos} photos`}
        {read.model ? ` by ${read.model}` : ""}. Check it against your page and fix anything misread before you submit — it&apos;s marked as it
        stands.
      </div>
      {read.unclear.length > 0 && (
        <div className="hw-unclear">
          <span className="muted">Not sure of:</span>
          {read.unclear.map((w) => (
            <button key={w} type="button" className="hw-word" onClick={() => onFind(w)} title="Show it in the answer">
              {w}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="hw-close" onClick={onClose} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** Selects a word in an answer box, so a misreading can be seen and typed over. */
export function selectIn(box: HTMLTextAreaElement | null, word: string) {
  if (!box) return;
  const at = box.value.indexOf(word);
  if (at < 0) return;
  box.focus();
  box.setSelectionRange(at, at + word.length);
}

/** Where typed-out handwriting goes: the box, or after what's already in it. */
export function withHandwriting(current: string, read: string): string {
  return current.trim() ? `${current.replace(/\s+$/, "")}\n\n${read}` : read;
}
