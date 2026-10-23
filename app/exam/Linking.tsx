"use client";

import { useState, useTransition } from "react";

import { writeLinking } from "@/app/exam/actions";
import type { Result } from "@/app/actions";
import { ResultLine } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import type { MixedCourse } from "@/lib/mixed/service";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Questions that join up related lectures: how many each course has, and a button for more. */
export function Linking({ courses, ai }: { courses: MixedCourse[]; ai: boolean }) {
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  if (!courses.length) return null;
  return (
    <section id="linking" className="exam-linking-list">
      <h2>Questions that link lectures</h2>
      <p className="small muted" style={{ marginTop: -4 }}>
        Long answers that need two related lectures at once — the kind that catch out anyone who revised each one on its own. Lockin pairs the
        lectures that share the most and writes a couple for each pair. They only come up in exams that include both lectures.
      </p>
      <div className="exam-linking-rows">
        {courses.map((c) => {
          const busy = c.job?.status === "PENDING" || c.job?.status === "RUNNING";
          return (
            <div key={c.id} className="exam-linking-row">
              <b>{c.code}</b>
              <span className="small muted">
                {c.questions ? plural(c.questions, "question") : "None yet"}
                {c.open ? ` · ${plural(c.open, "related pair")} could take more` : " · every related pair has plenty"}
              </span>
              {c.job?.status === "FAILED" && c.job.error !== "Cancelled" && <span className="small exam-linking-error">Last try failed: {c.job.error}</span>}
              <span className="spacer" />
              {ai && c.open > 0 && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || pending}
                  onClick={() => start(async () => setResult(await writeLinking(c.id)))}
                >
                  <Icon name="sparkles" size={14} /> {busy ? "Writing…" : c.questions ? "Write more" : "Write them"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <ResultLine result={result} />
    </section>
  );
}
