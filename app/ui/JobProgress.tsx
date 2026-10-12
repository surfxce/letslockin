"use client";

import { useEffect, useState } from "react";

import { clearQueueAction, retryJobAction } from "@/app/actions";
import { Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import { clockTime, duration } from "@/lib/format";
import type { Step } from "@/lib/jobs";
import { STAGES, type Stage } from "@/lib/types";

export interface JobView {
  id: string;
  kind: string;
  status: string;
  stage: string | null;
  steps: Step[];
  createdAt: string;
  startedAt: string | null;
  error: string | null;
  queuePosition: number | null;
  workerAlive: boolean;
}

/** The order a PREPARE runs its stages in, so waiting ones can be shown too. */
const PLAN: Record<string, Stage[]> = { PREPARE: ["digest", "questions"], GENERATE: ["questions"] };

/**
 * What is happening to this lecture right now, stage by stage, with when each
 * started and how long it took. Ticks every second while running.
 */
export function JobProgress({ job, lectureId }: { job: JobView; lectureId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (job.status !== "RUNNING") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  if (job.status === "FAILED") {
    return (
      <div className="callout red">
        <span className="callout-icon">
          <Icon name="alert" />
        </span>
        <div className="stack" style={{ gap: 8 }}>
          <p>
            <strong>Preparing this lecture failed.</strong> {job.error}
          </p>
          <form action={retryJobAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <Submit className="btn sm" pending="Queued">
              <Icon name="refresh" size={13} /> Try again
            </Submit>
          </form>
        </div>
      </div>
    );
  }

  if (job.status === "PENDING") {
    return (
      <div className="progress">
        <div className="progress-head">
          <Icon name="clock" />
          <span>
            {job.queuePosition === 1 ? "Next in line" : job.queuePosition ? `Queued — #${job.queuePosition} in line` : "Queued"}
          </span>
          <span className="small muted" style={{ fontWeight: 400 }}>
            since {clockTime(job.createdAt)} · lectures are prepared one at a time
          </span>
          <span style={{ flex: 1 }} />
          <form action={clearQueueAction}>
            <input type="hidden" name="lectureId" value={lectureId} />
            <Submit className="btn quiet sm" pending="Removing…">
              Remove from queue
            </Submit>
          </form>
        </div>
        {!job.workerAlive && (
          <p className="small" style={{ margin: "8px 0 0", color: "var(--s-orange)" }}>
            The AI worker isn&apos;t running, so nothing will start. Open the desktop app, or run <code>npm run worker</code>.
          </p>
        )}
      </div>
    );
  }

  const plan = PLAN[job.kind] ?? [];
  const seen = new Set(job.steps.map((s) => s.stage));
  const since = job.steps.at(-1)?.startedAt ?? job.startedAt;
  return (
    <div className="progress" aria-live="polite">
      <div className="progress-head">
        <span className="dot pulse" style={{ color: "var(--accent)" }} />
        <span>{job.stage ? STAGES[job.stage as Stage] ?? job.stage : "Starting"}…</span>
        {since && (
          <span className="small muted" style={{ fontWeight: 400 }}>
            started {clockTime(job.startedAt ?? since)} · {duration(now - new Date(since).getTime())} on this step
          </span>
        )}
      </div>
      <div className="steps">
        {job.steps.map((s) => (
          <span key={s.stage + s.startedAt} className={`step ${s.finishedAt ? "done" : "run"}`}>
            <span className="ring">{s.finishedAt ? "✓" : ""}</span>
            {STAGES[s.stage] ?? s.stage}
            <span className="t">
              {duration((s.finishedAt ? new Date(s.finishedAt).getTime() : now) - new Date(s.startedAt).getTime())}
            </span>
          </span>
        ))}
        {plan
          .filter((s) => !seen.has(s))
          .map((s) => (
            <span key={s} className="step">
              <span className="ring" />
              {STAGES[s]}
            </span>
          ))}
      </div>
    </div>
  );
}
