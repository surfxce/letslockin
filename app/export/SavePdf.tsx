"use client";

import { useEffect, useState } from "react";

import "@/app/ui/desktop";
import { Icon } from "@/app/ui/Icon";
import type { ExportScope } from "@/lib/export-data";

type State =
  | { kind: "idle" }
  | { kind: "loading"; done: number; total: number }
  | { kind: "saving" }
  | { kind: "saved"; path: string; name: string }
  | { kind: "error"; message: string };

/** Resolves once every picture in the document has loaded or failed. */
function picturesReady(onProgress: (done: number, total: number) => void): Promise<void> {
  const imgs = [...document.querySelectorAll<HTMLImageElement>(".export-doc img")];
  let done = 0;
  onProgress(0, imgs.length);
  return Promise.all(
    imgs.map((img) =>
      (img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          })
      ).then(() => onProgress(++done, imgs.length)),
    ),
  ).then(() => undefined);
}

/**
 * Saves the document below as a PDF. The desktop app prints it to a file itself —
 * with page numbers and bookmarks for each lecture; a browser opens its print
 * window, where "Save as PDF" is one of the printers.
 */
export function SavePdf({
  title,
  count,
  leftOut,
  href,
  scope,
  pending,
}: {
  title: string;
  count: number;
  leftOut: number;
  /** The export page's address for what the document below shows. */
  href: string;
  scope: ExportScope;
  /** A changed option is still on its way to the preview: saving now would save the old one. */
  pending: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [desktop, setDesktop] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- window only exists after mount
  useEffect(() => setDesktop(!!window.lockin?.savePdf), []);

  const busy = state.kind === "loading" || state.kind === "saving";
  // A different export starts afresh — once a save under way has finished.
  const [stateFor, setStateFor] = useState(href);
  if (stateFor !== href && !busy) {
    setStateFor(href);
    setState({ kind: "idle" });
  }

  const open = async (file: string, how: "open" | "show") => {
    const problem = await (how === "open" ? window.lockin?.openFile?.(file) : window.lockin?.showFile?.(file));
    if (problem) setState({ kind: "error", message: problem });
  };

  const save = async () => {
    if (window.lockin?.savePdf) {
      setState({ kind: "saving" });
      const result = await window.lockin
        .savePdf(href, title)
        .catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }));
      if (!result) setState({ kind: "idle" });
      else if (result.ok) setState({ kind: "saved", path: result.path, name: result.name });
      else setState({ kind: "error", message: result.message });
      return;
    }
    await picturesReady((done, total) => setState({ kind: "loading", done, total }));
    setState({ kind: "idle" });
    window.print();
  };

  const nothing =
    scope === "lectures" ? "Choose at least one lecture with a summary." : "None of these lectures has a summary yet.";

  return (
    <div className="export-save">
      <div className="row" style={{ gap: 10 }}>
        <button
          type="button"
          className="btn primary lg"
          disabled={count === 0 || busy || pending}
          onClick={() => void save()}
        >
          <Icon name="download" /> {state.kind === "saving" ? "Making the PDF…" : pending ? "Updating…" : "Save as PDF"}
        </button>
        <span className="small muted">
          {count === 0 ? nothing : `${count === 1 ? "1 lecture" : `${count} lectures`}`}
          {leftOut > 0 && ` · ${leftOut} more ${leftOut === 1 ? "has" : "have"} no summary yet, so ${leftOut === 1 ? "it's" : "they're"} left out`}
        </span>
      </div>

      {state.kind === "loading" && state.total > 0 && (
        <p className="small muted" role="status">
          Loading slide pictures… {state.done} of {state.total}
        </p>
      )}
      {state.kind === "saving" && (
        <p className="small muted" role="status">
          Drawing every slide picture and laying out the pages — a whole course can take a minute.
        </p>
      )}
      {state.kind === "saved" && (
        <p className="small" role="status">
          <span className="result ok">Saved {state.name}.</span>{" "}
          <button type="button" className="btn sm" onClick={() => void open(state.path, "open")}>
            Open it
          </button>{" "}
          <button type="button" className="btn sm quiet" onClick={() => void open(state.path, "show")}>
            Show in folder
          </button>
        </p>
      )}
      {state.kind === "error" && (
        <p className="small result err" role="alert">
          Couldn&apos;t save the PDF: {state.message}
        </p>
      )}
      {!desktop && count > 0 && (
        <p className="small faint" style={{ margin: "6px 0 0" }}>
          Your browser&apos;s print window opens: choose <strong>Save as PDF</strong> as the printer. Tick{" "}
          <strong>Background graphics</strong> to keep the coloured tags.
        </p>
      )}
    </div>
  );
}
