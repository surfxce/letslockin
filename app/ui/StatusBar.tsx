"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cancelJobAction, clearQueueAction, retryJobAction } from "@/app/actions";
import type { StatusPayload } from "@/lib/payloads";
import { Icon } from "@/app/ui/Icon";
import { Menu } from "@/app/ui/Menu";
import { clockTime, duration } from "@/lib/format";
import type { ActivityJob } from "@/lib/jobs";
import { STAGES } from "@/lib/types";

import "@/app/ui/desktop";
import { usesAi } from "@/lib/modes";

const BUSY_POLL_MS = 2500;
const IDLE_POLL_MS = 20_000;
const HIDDEN_POLL_MS = 60_000;

const KIND_LABEL: Record<string, string> = { PREPARE: "Prepare", GENERATE: "New LAQs", MARK: "Mark answer", MCQS: "Exam MCQs", PAPER: "Past paper", MIXED: "Linking questions" };

/**
 * The top-bar status: what the AI is doing right now and since when, what is
 * queued, what just finished, and what is due. It also refreshes the page when a
 * job finishes, and raises browser notifications when LAQs come due.
 */
export function StatusBar({ initial }: { initial: StatusPayload }) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusPayload>(initial);
  const [seenInitial, setSeenInitial] = useState(initial);
  // Starts from the server's clock so the first render matches the server's HTML.
  const [now, setNow] = useState(initial.at);
  const version = useRef(initial.version);

  // A server render (after an action, or a refresh) carries fresher state than the
  // last poll — e.g. lectures just queued by an import. Take it straight away.
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setStatus(initial);
  }

  // Poll: quickly while something is running, slowly otherwise. Restarts whenever the
  // server reports a change, so freshly queued work is picked up at the fast rate.
  useEffect(() => {
    let stop = false;
    let busy = !!initial.running || initial.queued.length > 0 || initial.downloading.length > 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as StatusPayload;
          if (stop) return;
          setStatus(next);
          busy = !!next.running || next.queued.length > 0 || next.downloading.length > 0;
          if (next.version !== version.current) {
            version.current = next.version;
            if (!window.__lockinHoldRefresh) router.refresh();
          }
          notifyDue(next);
        }
      } catch {
        // The server restarting is not worth a visible error; the next tick retries.
      }
      if (stop) return;
      timer = setTimeout(tick, document.hidden ? HIDDEN_POLL_MS : busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // Keyed on the version string, not the object: every refresh makes a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, initial.version]);

  // A ticking clock for elapsed times, only while something runs.
  const running = status.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const queued = status.queued.filter((j) => j.kind !== "MARK");
  const lastFailed = status.recent.find((j) => j.status === "FAILED");
  const workerDown = usesAi(status.mode) && !status.worker?.alive;
  const waiting = status.queued.length > 0 && !running && workerDown;
  // Offline mode with nothing downloaded yet: queued work waits for a model.
  const noModel = status.mode === "local" && !status.localModel;

  let pill: { cls: string; label: React.ReactNode };
  if (running) {
    const since = running.steps.at(-1)?.startedAt ?? running.startedAt;
    pill = {
      cls: "busy",
      label: (
        <>
          <span className="dot pulse" />
          <span className="label">
            {running.stageLabel ?? KIND_LABEL[running.kind]} · {running.lectureTitle ?? (running.kind === "PAPER" ? "past paper" : running.kind === "MIXED" ? "related lectures" : "lecture")}
          </span>
          {since && <span className="nowrap">{duration(now - new Date(since).getTime())}</span>}
          {queued.length > 0 && <span className="nowrap">· {queued.length} waiting</span>}
        </>
      ),
    };
  } else if (noModel) {
    pill = {
      cls: "stalled",
      label: <><Icon name="download" size={13} /> <span className="label">{status.downloading.length ? "Waiting for the model to download" : "Pick an offline model"}</span></>,
    };
  } else if (waiting) {
    pill = { cls: "stalled", label: <><Icon name="pause" size={13} /> <span className="label">{status.queued.length} waiting — AI worker not running</span></> };
  } else if (lastFailed && lastFailed === status.recent[0]) {
    pill = { cls: "failed", label: <><Icon name="alert" size={13} /> <span className="label">Failed: {lastFailed.lectureTitle ?? KIND_LABEL[lastFailed.kind]}</span></> };
  } else if (usesAi(status.mode)) {
    const who = status.mode === "local" ? status.localModel!.name : "AI";
    pill = { cls: "idle", label: <><Icon name="sparkles" size={13} /> <span className="label">{status.recent.length ? "All done" : `${who} idle`}</span></> };
  } else {
    pill = { cls: "idle", label: <><Icon name="clipboard" size={13} /> <span className="label">Copy & paste mode</span></> };
  }

  const dl = status.downloading[0];
  return (
    <>
      {dl && (
        <Link
          href="/settings#local"
          className="activity busy"
          title={
            dl.part === "mlx"
              ? `Downloading ${dl.name}'s MLX version, which runs faster on this Mac`
              : dl.part
              ? `${dl.name} is downloaded; now the part that lets it see slides`
              : "Downloading an offline model"
          }
        >
          <Icon name="download" size={13} />
          <span className="label">
            {dl.name}
            {dl.part === "server"
              ? " · vision · setting up"
              : `${dl.part === "vision" ? " · vision" : dl.part === "mlx" ? " · MLX" : ""}${dl.total > 0 ? ` · ${Math.floor((dl.downloaded / dl.total) * 100)}%` : " · starting"}`}
          </span>
        </Link>
      )}
      {status.due.length > 0 && (
        <Link href="/#due" className="due-badge" title="Lectures due for LAQs today">
          <Icon name="bell" size={13} /> {status.due.length} due
        </Link>
      )}
      <Menu
        align="right"
        buttonClassName={`activity ${pill.cls}`}
        label={pill.label}
        title="What the AI is doing"
      >
        {() => <ActivityPanel status={status} now={now} workerDown={workerDown} noModel={noModel} />}
      </Menu>
    </>
  );
}

function ActivityPanel({
  status,
  now,
  workerDown,
  noModel,
}: {
  status: StatusPayload;
  now: number;
  workerDown: boolean;
  noModel: boolean;
}) {
  const { running, queued, recent } = status;
  return (
    <div className="activity-pop">
      {status.mode === "local" && (
        <p className="note">
          {noModel ? (
            <>
              Offline mode needs a model on this computer — queued lectures wait until one is ready.{" "}
              <Link className="link" href="/settings#local">Pick one</Link>
            </>
          ) : (
            <>Running offline on {status.localModel!.name}, on this computer.</>
          )}
        </p>
      )}
      {status.mode === "manual" && (
        <p className="note">
          You are in copy & paste mode: nothing runs here. Copy each lecture&apos;s prompt into any AI chat and paste the reply
          back. <Link className="link" href="/settings">Change</Link>
        </p>
      )}
      {usesAi(status.mode) && workerDown && (
        <p className="note" style={{ color: "var(--t-yellow)", background: "var(--t-yellow-bg)", borderRadius: 6 }}>
          The AI worker isn&apos;t running, so queued lectures will wait. The desktop app starts it for you; from a terminal,
          run <code>npm run worker</code>. Or switch to <Link className="link" href="/settings">copy & paste mode</Link>.
        </p>
      )}

      <div className="sec">Now</div>
      {running ? (
        <JobLine job={running} now={now} detailed />
      ) : (
        <p className="note">Nothing running.</p>
      )}

      {queued.length > 0 && (
        <>
          <div className="sec row between">
            <span>Up next · {queued.length}</span>
            <form action={clearQueueAction}>
              <button className="btn quiet sm" type="submit">
                Clear queue
              </button>
            </form>
          </div>
          {queued.slice(0, 6).map((j, i) => (
            <Link key={j.id} href={j.lectureId ? `/lectures/${j.lectureId}` : "/"} className="job">
              <span className="faint small" style={{ width: 18 }}>
                {i + 1}
              </span>
              <span className="what">
                <div className="t">{j.lectureTitle ?? "Lecture"}</div>
                <div className="s">{KIND_LABEL[j.kind]}</div>
              </span>
              <span className="when">queued {clockTime(j.createdAt)}</span>
            </Link>
          ))}
          {queued.length > 6 && <p className="note">and {queued.length - 6} more, one at a time</p>}
        </>
      )}

      {recent.length > 0 && (
        <>
          <div className="sec">Earlier today</div>
          {recent.slice(0, 6).map((j) => (
            <JobLine key={j.id} job={j} now={now} />
          ))}
        </>
      )}
    </div>
  );
}

function JobLine({ job, now, detailed }: { job: ActivityJob; now: number; detailed?: boolean }) {
  const failed = job.status === "FAILED";
  return (
    <div className="job" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: failed ? "var(--danger)" : job.status === "DONE" ? "var(--s-green)" : "var(--accent-text)", marginTop: 2 }}>
          <Icon name={failed ? "alert" : job.status === "DONE" ? "check" : "sparkles"} size={14} />
        </span>
        <Link href={job.lectureId ? `/lectures/${job.lectureId}` : job.kind === "PAPER" ? "/exam#papers" : job.kind === "MIXED" ? "/exam#linking" : "/"} className="what">
          <div className="t">{job.lectureTitle ?? (job.kind === "PAPER" ? "Past paper" : job.kind === "MIXED" ? "Questions linking lectures" : "Lecture")}</div>
          <div className="s">
            {KIND_LABEL[job.kind]}
            {job.courseCode ? ` · ${job.courseCode}` : ""}
          </div>
        </Link>
        {job.status === "RUNNING" && (
          <form action={cancelJobAction} className="job-cancel">
            <input type="hidden" name="jobId" value={job.id} />
            <button type="submit" className="icon-btn" title="Cancel — stop working on this lecture" aria-label="Cancel this job">
              <Icon name="x" size={14} />
            </button>
          </form>
        )}
        <span className="when">
          {job.status === "RUNNING" && job.startedAt
            ? `started ${clockTime(job.startedAt)}`
            : job.finishedAt
              ? `${clockTime(job.finishedAt)}${job.durationMs ? ` · ${duration(job.durationMs)}` : ""}`
              : ""}
        </span>
      </div>
      {detailed && job.steps.length > 0 && (
        <div className="steps" style={{ marginTop: 2, paddingLeft: 24 }}>
          {job.steps.map((s) => (
            <span key={s.stage + s.startedAt} className={`step ${s.finishedAt ? "done" : "run"}`}>
              <span className="ring">{s.finishedAt ? "✓" : ""}</span>
              {STAGES[s.stage] ?? s.stage}
              {!s.finishedAt && s.detail ? ` — ${s.detail}` : ""}
              <span className="t">
                {clockTime(s.startedAt)} ·{" "}
                {duration((s.finishedAt ? new Date(s.finishedAt).getTime() : now) - new Date(s.startedAt).getTime())}
              </span>
            </span>
          ))}
        </div>
      )}
      {failed && (
        <div style={{ paddingLeft: 24, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small" style={{ color: "var(--danger)" }}>
            {job.error}
          </span>
          <form action={retryJobAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className="btn sm" type="submit">
              <Icon name="refresh" size={13} /> Retry
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browser notifications. The desktop app raises its own from the main process, so
// they arrive even with the window closed; this covers a plain browser tab.

const NOTIFIED_KEY = "lockin.notified";

function notifyDue(status: StatusPayload) {
  if (typeof window === "undefined" || window.lockin?.desktop) return;
  if (!status.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  const hour = new Date().getHours();
  if (hour < 8 || hour >= 22) return; // nobody wants an LAQ reminder at 2am

  const today = new Date().toDateString();
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}");
  } catch {
    // Unreadable storage just means a repeat notification, not a broken page.
  }
  const fresh = status.due.filter((d) => seen[d.lectureId] !== today);
  if (fresh.length === 0) return;

  let n: Notification;
  try {
    n =
      fresh.length === 1
        ? new Notification("Time to redo your LAQs", {
            body: `${fresh[0].courseCode} · ${fresh[0].title}`,
            tag: "lockin-due",
          })
        : new Notification(`${fresh.length} lectures are due for LAQs`, {
            body: fresh.slice(0, 3).map((d) => d.title).join(" · "),
            tag: "lockin-due",
          });
  } catch {
    return; // some browsers only allow notifications from a service worker
  }
  n.onclick = () => {
    window.focus();
    window.location.href = fresh.length === 1 ? `/lectures/${fresh[0].lectureId}` : "/#due";
  };
  for (const d of fresh) seen[d.lectureId] = today;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(seen));
  } catch {
    // See above.
  }
}
