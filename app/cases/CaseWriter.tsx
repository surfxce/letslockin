"use client";

import { useState } from "react";

import { writeCaseAction } from "@/app/cases/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";

export interface WriterCourse {
  id: string;
  code: string;
  title: string;
  lectures: Array<{ id: string; title: string }>;
}

const MAX = 4;

/** Which lectures the next case is written from: one course's, up to four. */
export function CaseWriter({ courses, ready, initialCourse }: { courses: WriterCourse[]; ready: boolean; initialCourse?: string }) {
  const [courseId, setCourseId] = useState(courses.find((c) => c.id === initialCourse)?.id ?? courses[0]?.id ?? "");
  const [chosen, setChosen] = useState<string[]>([]);
  const course = courses.find((c) => c.id === courseId);
  if (!courses.length) {
    return (
      <div className="empty">
        <p>No prepared lectures yet. Prepare a lecture and cases can be written from it.</p>
      </div>
    );
  }
  const toggle = (id: string, on: boolean) => setChosen((prev) => (on ? [...prev, id].slice(-MAX) : prev.filter((x) => x !== id)));

  return (
    <ActionForm action={writeCaseAction} className="soft-card case-writer">
      {chosen.map((id) => (
        <input key={id} type="hidden" name="lectureId" value={id} />
      ))}
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <label className="exam-label" htmlFor="case-course">
          Write a case from
        </label>
        <select
          id="case-course"
          value={courseId}
          onChange={(e) => {
            setCourseId(e.target.value);
            setChosen([]);
          }}
        >
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.title}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted" style={{ margin: "8px 0" }}>
        Tick one lecture, or up to {MAX} that belong together — say, the anatomy, the disease and its drugs. The AI writes one patient around them.
      </p>
      <div className="case-lectures">
        {course?.lectures.map((l) => (
          <label key={l.id}>
            <input type="checkbox" checked={chosen.includes(l.id)} onChange={(e) => toggle(l.id, e.target.checked)} />
            <span>{l.title}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Submit className="btn primary" pending="Asking…" disabled={!ready || chosen.length === 0}>
          <Icon name="sparkles" size={14} /> Write a case
        </Submit>
        <span className="small faint">{chosen.length ? `${chosen.length} chosen` : "Choose a lecture"}</span>
        <FormResult />
      </div>
    </ActionForm>
  );
}
