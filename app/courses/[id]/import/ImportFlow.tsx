"use client";

import { useActionState, useRef, useState } from "react";

import { importLectures, scanFolderAction, type ScanState } from "@/app/actions";
import { FolderPicker } from "@/app/ui/FolderPicker";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import type { Mode } from "@/lib/modes";
import { usesAi } from "@/lib/modes";

export function ImportFlow({ courseId, modules, mode }: { courseId: string; modules: string[]; mode: Mode }) {
  const [scan, scanAction, scanning] = useActionState(scanFolderAction, {} as ScanState);
  const scanForm = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={scanForm} action={scanAction} className="form" style={{ maxWidth: 720 }}>
        <input type="hidden" name="courseId" value={courseId} />
        <FolderPicker defaultValue={scan.root ?? ""} onPicked={() => scanForm.current?.requestSubmit()} />
        <div className="row">
          <button type="submit" className={scan.lectures ? "btn" : "btn primary"} disabled={scanning}>
            <Icon name={scan.lectures ? "refresh" : "search"} />
            {scanning ? "Reading files…" : scan.lectures ? "Scan again" : "Scan folder"}
          </button>
          {scanning && <span className="small muted">Reading every file and pairing them up — a few seconds.</span>}
        </div>
      </form>

      {scan.error && (
        <div className="callout red" style={{ marginTop: 18 }}>
          <span className="callout-icon">
            <Icon name="alert" />
          </span>
          <p>{scan.error}</p>
        </div>
      )}

      {scan.lectures && scan.files && (
        <Review key={scan.scannedAt} scan={scan} courseId={courseId} modules={modules} mode={mode} />
      )}
    </>
  );
}

function Review({
  scan,
  courseId,
  modules,
  mode,
}: {
  scan: ScanState;
  courseId: string;
  modules: string[];
  mode: Mode;
}) {
  const files = scan.files!;
  const lectures = scan.lectures!;
  const known = new Set(scan.alreadyImported ?? []);
  const isKnown = (idx: number[]) => idx.length > 0 && idx.every((i) => known.has(i));

  const [included, setIncluded] = useState(
    () => new Set(lectures.flatMap((l, i) => (l.setAside || isKnown(l.fileIndexes) ? [] : [i]))),
  );
  const moduleOptions = [...new Set([...modules, ...lectures.map((l) => l.moduleTitle).filter((m): m is string => !!m)])];
  const fresh = lectures.filter((l) => !l.setAside && !isKnown(l.fileIndexes)).length;

  return (
    <ActionForm action={importLectures}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="root" value={scan.root} />

      <h2>
        {lectures.length - lectures.filter((l) => l.setAside).length} lectures in {files.length} files
        {fresh < lectures.length && <span className="muted" style={{ fontWeight: 400 }}> · {fresh} new</span>}
      </h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        Untick anything you don&apos;t want. Titles made from filenames are placeholders — when each lecture is
        prepared, its title is rewritten from what it actually covers. Edit any of it now or later.
      </p>

      <div className="db-wrap">
        <table className="db" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={included.size === lectures.length}
                  onChange={(e) => setIncluded(new Set(e.target.checked ? lectures.map((_, i) => i) : []))}
                />
              </th>
              <th>Lecture</th>
              <th style={{ width: 200 }}>Module</th>
              <th style={{ width: 150 }}>Date</th>
              <th style={{ width: 80 }}>Hours</th>
            </tr>
          </thead>
          <tbody>
            {lectures.map((l, i) => {
              const on = included.has(i);
              const seen = isKnown(l.fileIndexes);
              const measured = l.fileIndexes.some((n) => files[n]?.measuredHours);
              return (
                <tr key={i} style={{ cursor: "default", opacity: on ? 1 : 0.55, verticalAlign: "top" }}>
                  <td style={{ paddingTop: 10, verticalAlign: "top" }}>
                    <input
                      type="checkbox"
                      name="include"
                      value={String(i)}
                      checked={on}
                      aria-label={`Import ${l.title}`}
                      onChange={(e) =>
                        setIncluded((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td style={{ whiteSpace: "normal", padding: "6px 9px" }}>
                    <input type="hidden" name={`proposed.${i}`} value={l.title} />
                    {l.fileIndexes.map((n) => (
                      <input key={n} type="hidden" name={`paths.${i}`} value={files[n].relativePath} />
                    ))}
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      {l.number && <span className="faint small nowrap">L{l.number}</span>}
                      <input
                        name={`title.${i}`}
                        defaultValue={l.title}
                        style={{ flex: 1, fontWeight: 500, background: "transparent", borderColor: "transparent" }}
                        aria-label="Title"
                      />
                      {seen && <span className="tag t-gray">already imported</span>}
                      {l.setAside && <span className="tag t-yellow">{l.setAside}</span>}
                    </div>
                    <div className="small muted" style={{ padding: "2px 9px 4px" }}>
                      {l.fileIndexes.map((n) => (
                        <div key={n} className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <span className={`tag ${files[n].kind === "TRANSCRIPT" ? "t-blue" : "t-gray"}`}>
                            {files[n].kind === "TRANSCRIPT" ? "transcript" : files[n].kind.toLowerCase()}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{files[n].relativePath}</span>
                          {files[n].warnings.length > 0 && (
                            <span style={{ color: "var(--s-orange)" }} title={files[n].warnings.join(" ")}>
                              <Icon name="alert" size={13} />
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input
                      name={`module.${i}`}
                      defaultValue={l.moduleTitle ?? ""}
                      list="module-options"
                      placeholder="No module"
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input type="date" name={`date.${i}`} defaultValue={l.deliveredOn} style={{ width: "100%" }} />
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input
                      type="number"
                      name={`hours.${i}`}
                      step="0.5"
                      min="0.5"
                      defaultValue={l.durationHours}
                      title={measured ? "Read from the transcript's timestamps" : "Default — change if it ran longer"}
                      style={{ width: "100%" }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <datalist id="module-options">
        {moduleOptions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      {scan.skipped && scan.skipped.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            {scan.skipped.length} file{scan.skipped.length === 1 ? "" : "s"} not read
          </summary>
          <ul className="small muted">
            {scan.skipped.map((s) => (
              <li key={s.path}>
                {s.path} — {s.why}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="sticky-foot">
        {usesAi(mode) ? (
          <label className="check">
            <input type="checkbox" name="prepare" defaultChecked />
            <span>
              Then prepare them with AI, <strong>one lecture at a time</strong> — summary and LAQs for each, in order
            </span>
          </label>
        ) : (
          <span className="small muted">You&apos;re in copy & paste mode: each lecture gets a Copy prompt button.</span>
        )}
        <span style={{ flex: 1 }} />
        <FormResult />
        <Submit className="btn primary lg" disabled={included.size === 0} pending="Importing…">
          Import {included.size} lecture{included.size === 1 ? "" : "s"}
        </Submit>
      </div>
    </ActionForm>
  );
}
