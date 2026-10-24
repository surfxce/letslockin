"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { SavePdf } from "@/app/export/SavePdf";
import type { ExportChoice, ExportScope } from "@/lib/export-data";
import { exportHref, NO_MODULE, PAPER, type ExportRequest, type Paper } from "@/lib/export";

const scopeOf = (r: ExportRequest): ExportScope => (r.lectureIds ? "lectures" : r.moduleId ? "module" : "course");

/**
 * What to export. Every choice goes into the page's address, so the preview below
 * re-renders from the server exactly as the PDF will print. The controls show a
 * choice at once; the preview catches up.
 */
export function ExportOptions(props: {
  request: ExportRequest;
  courses: Array<{ id: string; code: string; title: string }>;
  courseId: string;
  modules: Array<{ id: string; title: string; summaries: number }>;
  unsorted: number;
  choices: ExportChoice[];
  scope: ExportScope;
  moduleId: string | null;
  /** What Save as PDF saves: the document as the server last rendered it. */
  save: { title: string; count: number; leftOut: number; href: string };
}) {
  const { courses, modules, unsorted, choices } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  // What the server made of the address: a module that isn't this course's is the whole course.
  const [shown, setShown] = useOptimistic({ request: props.request, scope: props.scope, moduleId: props.moduleId });
  const { request, scope, moduleId } = shown;
  const courseId = request.courseId ?? props.courseId;
  // Until another course's lectures arrive, choosing among this one's would mix them up.
  const switching = courseId !== props.courseId;

  const go = (patch: Partial<ExportRequest>) => {
    const next = { ...request, courseId, ...patch };
    start(() => {
      setShown({ request: next, scope: scopeOf(next), moduleId: next.lectureIds ? null : next.moduleId });
      router.replace(exportHref(next), { scroll: false });
    });
  };
  const withSummary = choices.filter((c) => c.hasSummary);
  const moduleChoices = [
    ...modules.map((m) => ({ id: m.id, label: m.title, summaries: m.summaries })),
    ...(unsorted > 0 && modules.length > 0 ? [{ id: NO_MODULE, label: "Lectures with no module", summaries: unsorted }] : []),
  ];
  const firstModule = moduleChoices.find((m) => m.summaries > 0) ?? moduleChoices[0];
  const picked = new Set(scope === "lectures" ? (request.lectureIds ?? []) : []);

  const setScope = (next: ExportScope) => {
    if (next === scope) return;
    if (next === "course") go({ moduleId: null, lectureIds: null });
    else if (next === "module" && firstModule) go({ moduleId: moduleId ?? firstModule.id, lectureIds: null });
    else if (next === "lectures") {
      // Start from what was being exported, so narrowing it down is a few unticks.
      const from =
        scope === "module" ? withSummary.filter((c) => (moduleId === NO_MODULE ? !c.moduleId : c.moduleId === moduleId)) : withSummary;
      go({ lectureIds: from.map((c) => c.id) });
    }
  };
  const toggle = (id: string, on: boolean) => {
    const next = choices.filter((c) => (c.id === id ? on : picked.has(c.id))).map((c) => c.id);
    go({ lectureIds: next });
  };

  return (
    <>
      <div className="export-options" aria-busy={pending}>
        {courses.length > 1 && (
          <div className="export-row">
            <span className="lab">Course</span>
            <select
              value={courseId}
              onChange={(e) => go({ courseId: e.target.value, moduleId: null, lectureIds: null })}
              style={{ width: "auto", maxWidth: "100%" }}
            >
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="export-fieldset" disabled={switching}>
          <div className="export-row">
            <span className="lab">Export</span>
            <div className="seg" role="radiogroup" aria-label="What to export">
              {(
                [
                  ["course", "Whole course"],
                  ["module", "A module"],
                  ["lectures", "Choose lectures"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={scope === key}
                  className={scope === key ? "on" : undefined}
                  disabled={key === "module" && moduleChoices.length === 0}
                  title={key === "module" && moduleChoices.length === 0 ? "This course has no modules" : undefined}
                  onClick={() => setScope(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {scope === "module" && moduleChoices.length > 0 && (
              <select
                value={moduleId ?? firstModule?.id}
                onChange={(e) => go({ moduleId: e.target.value, lectureIds: null })}
                aria-label="Module"
                style={{ width: "auto", maxWidth: "100%" }}
              >
                {moduleChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.summaries} {m.summaries === 1 ? "summary" : "summaries"})
                  </option>
                ))}
              </select>
            )}
          </div>

          {scope === "lectures" && (
            <div className="export-picks">
              <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                <button type="button" className="btn sm quiet" onClick={() => go({ lectureIds: withSummary.map((c) => c.id) })}>
                  All
                </button>
                <button type="button" className="btn sm quiet" onClick={() => go({ lectureIds: [] })}>
                  None
                </button>
                <span className="small faint">{picked.size} chosen</span>
              </div>
              <ul>
                {choices.map((c) => (
                  <li key={c.id}>
                    <label className={`check${c.hasSummary ? "" : " off"}`}>
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        disabled={!c.hasSummary}
                        onChange={(e) => toggle(c.id, e.target.checked)}
                      />
                      <span>
                        <span className="ord">L{c.ordinal}</span> {c.title}
                        {c.moduleTitle && <span className="small faint"> · {c.moduleTitle}</span>}
                        {!c.hasSummary && <span className="small faint"> · no summary yet</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="export-row">
            <span className="lab">Include</span>
            <label className="check">
              <input type="checkbox" checked={request.pictures} onChange={(e) => go({ pictures: e.target.checked })} />
              <span>Slide pictures</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={request.glossary} onChange={(e) => go({ glossary: e.target.checked })} />
              <span>Glossary</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={request.contents} onChange={(e) => go({ contents: e.target.checked })} />
              <span>Title page and contents</span>
            </label>
          </div>

          <div className="export-row">
            <span className="lab">Paper</span>
            <div className="seg" role="radiogroup" aria-label="Paper size">
              {(Object.keys(PAPER) as Paper[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={request.paper === p}
                  className={request.paper === p ? "on" : undefined}
                  onClick={() => go({ paper: p })}
                >
                  {PAPER[p].label}
                </button>
              ))}
            </div>
            {pending && <span className="small faint">Updating the preview…</span>}
          </div>
        </fieldset>
      </div>
      <SavePdf {...props.save} scope={props.scope} pending={pending} />
    </>
  );
}
