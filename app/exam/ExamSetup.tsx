"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { startExam, writeMissingMcqs } from "@/app/exam/actions";
import type { Result } from "@/app/actions";
import { ActionForm, FormResult, ResultLine, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import { suggestedMinutes } from "@/lib/exam/pick";
import type { ExamCourse, ExamLecture } from "@/lib/exam/service";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A checkbox that can also show "some of these". */
function TriCheck({
  state,
  onChange,
  label,
}: {
  state: "all" | "some" | "none" | "empty";
  onChange: (on: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={state === "all"}
      disabled={state === "empty"}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** A lecture with no LAQs or MCQs yet has nothing to put in an exam. */
const usable = (l: ExamLecture) => l.laqs + l.mcqs > 0;

function counts(lectures: ExamLecture[]) {
  return {
    laqs: lectures.reduce((n, l) => n + l.laqs, 0),
    mcqs: lectures.reduce((n, l) => n + l.mcqs, 0),
  };
}

export function ExamSetup({ tree, ai, course }: { tree: ExamCourse[]; ai: boolean; course?: string }) {
  const all = useMemo(() => tree.flatMap((c) => c.modules.flatMap((m) => m.lectures)), [tree]);
  const [chosen, setChosen] = useState<Set<string>>(() => {
    const scoped = tree.find((c) => c.id === course);
    const pool = scoped ? scoped.modules.flatMap((m) => m.lectures) : all;
    return new Set(pool.filter(usable).map((l) => l.id));
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [mcqs, setMcqs] = useState(10);
  const [laqs, setLaqs] = useState(4);
  const [timed, setTimed] = useState(true);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [mcqResult, setMcqResult] = useState<Result>(null);
  const [writing, startWriting] = useTransition();
  const [linking, setLinking] = useState(true);

  const picked = all.filter((l) => chosen.has(l.id));
  const allLinking = tree.flatMap((c) => c.linking);
  // A linking question can be asked when every lecture it needs is chosen.
  const linkable = allLinking.filter((ids) => ids.every((id) => chosen.has(id))).length;
  const own = counts(picked);
  const pool = { mcqs: own.mcqs, laqs: own.laqs + (linking ? linkable : 0) };
  const missing = picked.filter((l) => l.mcqs === 0 && l.prepared);
  const unprepared = picked.filter((l) => !l.prepared).length;
  const shownMinutes = minutes ?? suggestedMinutes(Math.min(mcqs, pool.mcqs), Math.min(laqs, pool.laqs));

  const stateOf = (lectures: ExamLecture[]) => {
    const some = lectures.filter(usable);
    const n = some.filter((l) => chosen.has(l.id)).length;
    return some.length === 0 ? "empty" : n === 0 ? "none" : n === some.length ? "all" : "some";
  };
  const toggle = (lectures: ExamLecture[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      for (const l of lectures.filter(usable)) {
        if (on) next.add(l.id);
        else next.delete(l.id);
      }
      return next;
    });
  const expand = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!all.length) {
    return (
      <div className="empty">
        <p>No lectures yet. Add some, prepare them, and they can go into an exam.</p>
      </div>
    );
  }

  return (
    <ActionForm action={startExam} className="exam-setup">
      {[...chosen].map((id) => (
        <input key={id} type="hidden" name="lectureId" value={id} />
      ))}
      <section className="exam-scope">
        <div className="exam-scope-head">
          <h2>What it covers</h2>
          <span className="small muted">
            {plural(picked.length, "lecture")} · {plural(pool.laqs, "LAQ")} · {plural(pool.mcqs, "MCQ")}
          </span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => toggle(all, true)}>
            All
          </button>
          <button type="button" className="btn sm" onClick={() => toggle(all, false)}>
            None
          </button>
        </div>
        {tree.map((c) => {
          const lectures = c.modules.flatMap((m) => m.lectures);
          const n = counts(lectures);
          return (
            <div key={c.id} className="exam-course">
              <label className="exam-course-head">
                <TriCheck state={stateOf(lectures)} onChange={(on) => toggle(lectures, on)} label={`All of ${c.code}`} />
                <b>{c.code}</b>
                <span className="exam-course-title">{c.title}</span>
                <span className="small faint">
                  {plural(n.laqs, "LAQ")} · {plural(n.mcqs, "MCQ")}
                </span>
              </label>
              {c.modules.map((m) => {
                const key = `${c.id}:${m.id ?? "none"}`;
                const mc = counts(m.lectures);
                const isOpen = open.has(key);
                return (
                  <div key={key} className="exam-module">
                    <div className="exam-module-head">
                      <label>
                        <TriCheck state={stateOf(m.lectures)} onChange={(on) => toggle(m.lectures, on)} label={`All of ${m.title}`} />
                        <span>{m.title}</span>
                      </label>
                      <span className="small faint">
                        {plural(m.lectures.length, "lecture")} · {mc.laqs} LAQs · {mc.mcqs} MCQs
                      </span>
                      <button type="button" className="btn quiet sm" aria-expanded={isOpen} onClick={() => expand(key)}>
                        <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} /> Lectures
                      </button>
                    </div>
                    {isOpen && (
                      <div className="exam-lectures">
                        {m.lectures.map((l) => (
                          <label key={l.id} className={usable(l) ? undefined : "faint"}>
                            <input type="checkbox" checked={chosen.has(l.id)} disabled={!usable(l)} onChange={(e) => toggle([l], e.target.checked)} />
                            <span className="exam-lecture-title">{l.title}</span>
                            <span className="small faint">
                              {l.prepared ? `${l.laqs} LAQ${l.laqs === 1 ? "" : "s"} · ${l.mcqs} MCQ${l.mcqs === 1 ? "" : "s"}` : "not prepared"}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      <section className="exam-options soft-card">
        <div className="exam-option-grid">
          <label>
            <span className="exam-label">Multiple choice</span>
            <input name="mcqs" type="number" min={0} max={60} value={mcqs} onChange={(e) => setMcqs(Math.max(0, Number(e.target.value) || 0))} />
            <span className="small faint">{mcqs > pool.mcqs ? `only ${pool.mcqs} available` : `of ${pool.mcqs} available`}</span>
          </label>
          <label>
            <span className="exam-label">Long answers</span>
            <input name="laqs" type="number" min={0} max={20} value={laqs} onChange={(e) => setLaqs(Math.max(0, Number(e.target.value) || 0))} />
            <span className="small faint">{laqs > pool.laqs ? `only ${pool.laqs} available` : `of ${pool.laqs} available`}</span>
          </label>
          <div>
            <label className="exam-label row">
              <input type="checkbox" name="timed" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Timed
            </label>
            <div className="row" style={{ gap: 6 }}>
              <input
                name="minutes"
                type="number"
                min={1}
                max={600}
                disabled={!timed}
                value={shownMinutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
                aria-label="Minutes"
                style={{ width: 90 }}
              />
              <span className="small muted">minutes</span>
            </div>
          </div>
        </div>
        {allLinking.length > 0 && (
          <label className="exam-linking">
            <input type="hidden" name="linking" value={linking ? "1" : "0"} />
            <input type="checkbox" checked={linking} onChange={(e) => setLinking(e.target.checked)} />
            <span>
              Include long answers that link lectures
              <span className="small faint"> · {linkable ? `${linkable} for what's chosen` : "none for what's chosen — they need every lecture they link"}</span>
            </span>
          </label>
        )}
        <fieldset className="exam-focus">
          <legend className="exam-label">Which questions</legend>
          <label>
            <input type="radio" name="focus" value="mixed" defaultChecked /> Mixed, spread across everything chosen — like the real exam
          </label>
          <label>
            <input type="radio" name="focus" value="weak" /> Weak areas first — lectures with the lowest drill scores, questions you did worst on
          </label>
        </fieldset>

        {missing.length > 0 && (
          <div className="callout exam-missing">
            <span>
              {plural(missing.length, "chosen lecture has", "chosen lectures have")} no MCQs yet
              {ai ? "." : " — MCQs are written by the AI, so in copy & paste mode exams are long answers only."}
            </span>
            {ai && (
              <button
                type="button"
                className="btn sm"
                disabled={writing}
                onClick={() => startWriting(async () => setMcqResult(await writeMissingMcqs(missing.map((l) => l.id))))}
              >
                <Icon name="sparkles" size={14} /> {writing ? "Queuing…" : "Write MCQs for them"}
              </button>
            )}
            <ResultLine result={mcqResult} />
          </div>
        )}
        {unprepared > 0 && <p className="small muted">{plural(unprepared, "chosen lecture isn't", "chosen lectures aren't")} prepared yet, so they add nothing.</p>}

        <div className="row">
          <Submit className="btn primary lg" pending="Setting the paper…" disabled={!picked.length || pool.laqs + pool.mcqs === 0 || mcqs + laqs === 0}>
            <Icon name="play" size={15} /> Start exam
          </Submit>
          <span className="small muted">Closed book. Multiple choice first, then long answers.</span>
          <FormResult />
        </div>
      </section>
    </ActionForm>
  );
}
