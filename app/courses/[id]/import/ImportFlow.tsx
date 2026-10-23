"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { importLectures, scanFolderAction, startSort, type ScanState } from "@/app/actions";
import { FolderPicker } from "@/app/ui/FolderPicker";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import { duration } from "@/lib/format";
import { lecturesFromSort, type GroupInput, type ProposedLecture, type SortedFolder } from "@/lib/group";
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
          {scanning && <span className="small muted">Reading every file — a few seconds.</span>}
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
        <Grouping key={scan.scannedAt} scan={scan} courseId={courseId} modules={modules} mode={mode} />
      )}
    </>
  );
}

type Sorting =
  | { state: "idle" }
  | { state: "running"; jobId: string; since: number; workerAlive: boolean }
  | { state: "done"; lectures: ProposedLecture[]; seconds: number }
  | { state: "failed"; error: string };

/**
 * The step between scanning and importing: how the files become lectures. Files named
 * by lecture are grouped from their names, instantly. A messier folder can be sorted
 * by AI instead — it reads the start of every file. Either way the result is a list to
 * check and edit before anything is imported.
 */
function Grouping({ scan, courseId, modules, mode }: { scan: ScanState; courseId: string; modules: string[]; mode: Mode }) {
  const files = scan.files!;
  const [method, setMethod] = useState<"names" | "ai">("names");
  const [sorting, setSorting] = useState<Sorting>({ state: "idle" });
  const [now, setNow] = useState(0);
  const canSort = usesAi(mode);

  const inputs: GroupInput[] = files.map((f) => ({
    relativePath: f.relativePath,
    kind: f.kind,
    modifiedOn: new Date(f.modifiedOn),
    measuredHours: f.measuredHours,
  }));

  async function sortWithAi() {
    setMethod("ai");
    if (sorting.state === "running" || sorting.state === "done") return;
    setSorting({ state: "running", jobId: "", since: Date.now(), workerAlive: true });
    const res = await startSort({ root: scan.root!, paths: files.map((f) => f.relativePath) });
    if ("error" in res) setSorting({ state: "failed", error: res.error });
    else setSorting({ state: "running", jobId: res.jobId, since: Date.now(), workerAlive: true });
  }

  // Follow the sort until it finishes.
  const jobId = sorting.state === "running" ? sorting.jobId : "";
  useEffect(() => {
    if (!jobId) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const job = (await res.json()) as {
        status: string;
        error: string | null;
        result: SortedFolder | null;
        durationMs: number | null;
        workerAlive: boolean;
      };
      if (job.status === "DONE" && job.result) {
        setSorting({
          state: "done",
          lectures: lecturesFromSort(inputs, job.result),
          seconds: Math.round((job.durationMs ?? 0) / 1000),
        });
      } else if (job.status === "FAILED") {
        setSorting({ state: "failed", error: job.error ?? "The sort failed." });
      } else {
        setSorting((s) => (s.state === "running" ? { ...s, workerAlive: job.workerAlive } : s));
      }
    }, 1000);
    return () => clearInterval(t);
    // `inputs` is rebuilt every render from the same scan; the job id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const who = mode === "local" ? "Your offline model" : "Claude Haiku, a small fast model,";
  const lectures = method === "ai" && sorting.state === "done" ? sorting.lectures : scan.lectures!;
  const showTable = method === "names" || sorting.state === "done";

  return (
    <>
      <h2>How should these become lectures?</h2>
      <div className="sort-choice">
        <label className="choice">
          <input type="radio" name="sort-method" checked={method === "names"} onChange={() => setMethod("names")} />
          <span>
            <span className="ct">
              <Icon name="list" size={15} /> Sorted already
            </span>
            <span className="cd">
              The files say which lecture they belong to — L3, A4, Week 2, a date, or a folder each. Grouped from
              their names, instantly.
            </span>
          </span>
        </label>
        <label className={`choice${canSort ? "" : " disabled"}`}>
          <input
            type="radio"
            name="sort-method"
            checked={method === "ai"}
            disabled={!canSort}
            onChange={() => void sortWithAi()}
          />
          <span>
            <span className="ct">
              <Icon name="sparkles" size={15} /> Sort with AI
            </span>
            <span className="cd">
              {canSort
                ? `${who} reads the start of every file and works out what goes where — for messy folders. ${
                    mode === "local" ? "A few minutes." : "Usually under a minute."
                  }`
                : "Needs a cloud AI or an offline model — you're in copy & paste mode."}
            </span>
          </span>
        </label>
      </div>

      {method === "ai" && sorting.state === "running" && (
        <div className="progress" aria-live="polite">
          <div className="progress-head">
            <span className="dot pulse" style={{ color: "var(--accent)" }} />
            <span>Sorting {files.length} files…</span>
            <span className="small muted" style={{ fontWeight: 400 }}>
              {duration(Math.max(0, (now || sorting.since) - sorting.since))}
            </span>
          </div>
          {!sorting.workerAlive && (
            <p className="small" style={{ color: "var(--t-yellow)", margin: "6px 0 0" }}>
              The background worker isn&apos;t running, so the sort can&apos;t start. The desktop app runs it; from a
              terminal, run <code>npm run worker</code>.
            </p>
          )}
        </div>
      )}
      {method === "ai" && sorting.state === "failed" && (
        <div className="callout red">
          <span className="callout-icon">
            <Icon name="alert" />
          </span>
          <div className="stack" style={{ gap: 8 }}>
            <p>
              <strong>The AI sort didn&apos;t work.</strong> {sorting.error}
            </p>
            <div className="row">
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setSorting({ state: "idle" });
                  void sortWithAi();
                }}
              >
                <Icon name="refresh" size={13} /> Try again
              </button>
              <button type="button" className="btn quiet sm" onClick={() => setMethod("names")}>
                Use the names instead
              </button>
            </div>
          </div>
        </div>
      )}
      {method === "ai" && sorting.state === "done" && (
        <p className="small muted">
          Sorted by {mode === "local" ? "your offline model" : "Claude Haiku"}
          {sorting.seconds ? ` in ${duration(sorting.seconds * 1000)}` : ""}. Check it below — anything can be
          changed before you import.
        </p>
      )}

      {showTable && (
        <Review
          key={method}
          scan={scan}
          lectures={lectures}
          courseId={courseId}
          modules={modules}
          mode={mode}
        />
      )}
    </>
  );
}

function Review({
  scan,
  lectures,
  courseId,
  modules,
  mode,
}: {
  scan: ScanState;
  lectures: ProposedLecture[];
  courseId: string;
  modules: string[];
  mode: Mode;
}) {
  const files = scan.files!;
  const inLectures = scan.inLectures ?? {};

  // A file left out of one lecture ("3:6": file 6 in row 3), e.g. a shared deck that
  // only really belongs to one of them.
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const kept = (i: number) => lectures[i].fileIndexes.filter((n) => !dropped.has(`${i}:${n}`));

  /**
   * The lecture already in the course that a row's files come from, if any — the one
   * holding its transcript, else most of its files. New files in the row are added to
   * it rather than making a second copy of the lecture.
   */
  const homeOf = (l: ProposedLecture) => {
    const tally = new Map<string, { id: string; title: string; score: number }>();
    for (const n of l.fileIndexes) {
      for (const e of inLectures[n] ?? []) {
        const t = tally.get(e.id) ?? { ...e, score: 0 };
        t.score += files[n].kind === "TRANSCRIPT" ? 10 : 1;
        tally.set(e.id, t);
      }
    }
    return [...tally.values()].sort((a, b) => b.score - a.score)[0] ?? null;
  };
  const rows = lectures.map((l, i) => {
    const home = homeOf(l);
    const fresh = kept(i).filter((n) => !(inLectures[n] ?? []).some((e) => e.id === home?.id));
    const status: "new" | "adds" | "have" = !home ? "new" : fresh.length ? "adds" : "have";
    return { l, home, fresh, status };
  });

  const [included, setIncluded] = useState(
    () => new Set(rows.flatMap((r, i) => (r.l.setAside || r.status === "have" ? [] : [i]))),
  );
  const moduleOptions = [...new Set([...modules, ...lectures.map((l) => l.moduleTitle).filter((m): m is string => !!m)])];
  const lectureCount = lectures.filter((l) => !l.setAside).length;
  const have = rows.filter((r) => r.status === "have").length;
  const adds = rows.filter((r) => r.status === "adds").length;
  const name = (l: ProposedLecture) => l.label ?? l.title;

  return (
    <ActionForm action={importLectures}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="root" value={scan.root} />

      <h2>
        {lectureCount} lecture{lectureCount === 1 ? "" : "s"} in {files.length} files
        {(have > 0 || adds > 0) && (
          <span className="muted" style={{ fontWeight: 400 }}>
            {have > 0 && ` · ${have} already imported`}
            {adds > 0 && ` · ${adds} with new files`}
          </span>
        )}
      </h2>
      <p className="muted small" style={{ marginTop: -4 }}>
        Untick anything you don&apos;t want, or take a file out of one lecture with its ×. A deck shared by two
        lectures is copied into both. Titles are placeholders until each lecture is prepared — edit any of it now
        or later.
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
            {rows.map(({ l, home, fresh, status }, i) => {
              const on = included.has(i);
              const measured = l.fileIndexes.some((n) => files[n]?.measuredHours);
              const existing = status !== "new";
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
                    {status === "adds" && home && <input type="hidden" name={`into.${i}`} value={home.id} />}
                    {kept(i).map((n) => (
                      <input key={n} type="hidden" name={`paths.${i}`} value={files[n].relativePath} />
                    ))}
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      {l.label && <span className="faint small nowrap">{l.label}</span>}
                      {existing && home ? (
                        <span style={{ flex: 1, fontWeight: 500, padding: "4px 9px" }}>{home.title}</span>
                      ) : (
                        <input
                          name={`title.${i}`}
                          defaultValue={l.title}
                          style={{ flex: 1, fontWeight: 500, background: "transparent", borderColor: "transparent" }}
                          aria-label="Title"
                        />
                      )}
                      {status === "have" && <span className="tag t-gray">already imported</span>}
                      {status === "adds" && (
                        <span className="tag t-green">
                          adds {fresh.length} file{fresh.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {l.setAside && <span className="tag t-yellow">{l.setAside}</span>}
                    </div>
                    <div className="small muted" style={{ padding: "2px 9px 4px" }}>
                      {l.fileIndexes.map((n) => {
                        const out = dropped.has(`${i}:${n}`);
                        const others = lectures.filter((o, j) => j !== i && o.fileIndexes.includes(n));
                        const there = existing && (inLectures[n] ?? []).some((e) => e.id === home?.id);
                        return (
                          <div key={n} className={`import-file${out ? " out" : ""}`}>
                            <span className={`tag ${files[n].kind === "TRANSCRIPT" ? "t-blue" : files[n].kind === "RECORDING" ? "t-purple" : "t-gray"}`}>
                              {files[n].kind === "TRANSCRIPT" ? "transcript" : files[n].kind.toLowerCase()}
                            </span>
                            <span className="fname">{files[n].relativePath}</span>
                            {others.length > 0 && (
                              <span className="tag t-purple" title="One file for several lectures: each gets a copy">
                                shared with {others.map(name).join(", ")}
                              </span>
                            )}
                            {there && <span className="faint">already there</span>}
                            {files[n].warnings.length > 0 && (
                              <span style={{ color: "var(--s-orange)" }} title={files[n].warnings.join(" ")}>
                                <Icon name="alert" size={13} />
                              </span>
                            )}
                            {l.fileIndexes.length > 1 && (
                              <button
                                type="button"
                                className="icon-btn sm"
                                title={out ? "Put it back" : "Leave this file out of this lecture"}
                                aria-label={out ? "Put the file back" : "Leave the file out"}
                                onClick={() =>
                                  setDropped((d) => {
                                    const next = new Set(d);
                                    if (out) next.delete(`${i}:${n}`);
                                    else next.add(`${i}:${n}`);
                                    return next;
                                  })
                                }
                              >
                                <Icon name={out ? "refresh" : "x"} size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input
                      name={`module.${i}`}
                      defaultValue={l.moduleTitle ?? ""}
                      list="module-options"
                      placeholder="No module"
                      disabled={existing}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input
                      type="date"
                      name={`date.${i}`}
                      defaultValue={l.deliveredOn}
                      disabled={existing}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ verticalAlign: "top", paddingTop: 6 }}>
                    <input
                      type="number"
                      name={`hours.${i}`}
                      step="0.5"
                      min="0.5"
                      defaultValue={l.durationHours}
                      disabled={existing}
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
              {adds > 0 && "; lectures that get new files have their summary rewritten"}
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
