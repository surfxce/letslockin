"use client";

import { useState } from "react";

import { beginViva } from "@/app/viva/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import type { ExamCourse } from "@/lib/exam/service";

const SIZES = [3, 5, 8];

/** Which lectures, how many questions, and how they're chosen. */
export function VivaSetup({ tree, course, ready }: { tree: ExamCourse[]; course?: string; ready: boolean }) {
  // Only lectures with LAQs can be asked about.
  const courses = tree
    .map((c) => ({ ...c, lectures: c.modules.flatMap((m) => m.lectures).filter((l) => l.laqs > 0) }))
    .filter((c) => c.lectures.length);
  const [chosen, setChosen] = useState<Set<string>>(() => {
    const scoped = courses.find((c) => c.id === course) ?? courses[0];
    return new Set(scoped?.lectures.map((l) => l.id) ?? []);
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [size, setSize] = useState(5);
  const toggle = (ids: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  if (!courses.length) {
    return (
      <div className="empty">
        <p>No lectures with LAQs yet. Prepare a lecture and its LAQs become your viva questions.</p>
      </div>
    );
  }

  return (
    <ActionForm action={beginViva} className="viva-setup">
      {[...chosen].map((id) => (
        <input key={id} type="hidden" name="lectureId" value={id} />
      ))}
      <input type="hidden" name="questions" value={size} />
      <section className="viva-scope">
        {courses.map((c) => {
          const ids = c.lectures.map((l) => l.id);
          const n = ids.filter((id) => chosen.has(id)).length;
          const isOpen = open.has(c.id);
          return (
            <div key={c.id} className="viva-course">
              <div className="viva-course-head">
                <label>
                  <input
                    type="checkbox"
                    checked={n === ids.length}
                    ref={(el) => {
                      if (el) el.indeterminate = n > 0 && n < ids.length;
                    }}
                    onChange={(e) => toggle(ids, e.target.checked)}
                  />
                  <b>{c.code}</b> <span className="muted">{c.title}</span>
                </label>
                <span className="small faint">
                  {n} of {ids.length} lectures
                </span>
                <button
                  type="button"
                  className="btn quiet sm"
                  aria-expanded={isOpen}
                  onClick={() => setOpen((prev) => new Set(prev.has(c.id) ? [...prev].filter((x) => x !== c.id) : [...prev, c.id]))}
                >
                  <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} /> Lectures
                </button>
              </div>
              {isOpen && (
                <div className="viva-lectures">
                  {c.lectures.map((l) => (
                    <label key={l.id}>
                      <input type="checkbox" checked={chosen.has(l.id)} onChange={(e) => toggle([l.id], e.target.checked)} />
                      <span>{l.title}</span>
                      <span className="small faint">
                        {l.laqs} LAQ{l.laqs === 1 ? "" : "s"}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="soft-card viva-options">
        <div className="setting" style={{ border: 0, padding: 0 }}>
          <div>
            <div className="st">Questions</div>
            <div className="sd">About {size * 4}–{size * 6} minutes, with the examiner&apos;s follow-ups.</div>
          </div>
          <div className="seg" role="radiogroup" aria-label="Questions">
            {SIZES.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={size === n} className={size === n ? "on" : undefined} onClick={() => setSize(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="exam-focus">
          <legend className="exam-label">Which questions</legend>
          <label>
            <input type="radio" name="focus" value="mixed" defaultChecked /> Spread across everything chosen
          </label>
          <label>
            <input type="radio" name="focus" value="weak" /> Weak areas first — the questions you did worst on
          </label>
        </fieldset>
        <div className="row">
          <Submit className="btn primary lg" pending="Starting…" disabled={!ready || chosen.size === 0}>
            <Icon name="mic" size={15} /> Start the viva
          </Submit>
          <FormResult />
        </div>
      </section>
    </ActionForm>
  );
}
