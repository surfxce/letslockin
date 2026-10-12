import { dueLabel, formatScore, scoreTone, type Tone } from "@/lib/format";
import { STATUS_LABEL, type LectureStatus } from "@/lib/status";

/** Render-only pieces used by both server and client components. No hooks here. */

export function Tag({ tone = "gray", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`tag t-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ScoreTag({ score, prev }: { score: number | null; prev?: number | null }) {
  if (score === null) return <span className="faint">—</span>;
  const delta = prev == null ? 0 : score - prev;
  return (
    <span className="nowrap">
      <span className={`tag score t-${scoreTone(score)}`}>{formatScore(score)}</span>
      {Math.abs(delta) >= 0.05 && (
        <span className={`trend ${delta > 0 ? "up" : "down"}`} title={`was ${formatScore(prev!)}`}>
          {delta > 0 ? "▲" : "▼"}
          {formatScore(Math.abs(delta))}
        </span>
      )}
    </span>
  );
}

const STATUS_TONE: Record<LectureStatus, Tone> = {
  empty: "gray",
  todo: "gray",
  queued: "blue",
  working: "blue",
  failed: "red",
  summary: "yellow",
  ready: "purple",
  practised: "green",
};

export function StatusTag({
  status,
  stageLabel,
  queuePosition,
  error,
}: {
  status: LectureStatus;
  stageLabel?: string | null;
  queuePosition?: number | null;
  error?: string | null;
}) {
  const label =
    status === "working" && stageLabel
      ? stageLabel
      : status === "queued" && queuePosition
        ? `Queued · #${queuePosition}`
        : STATUS_LABEL[status];
  return (
    <span className={`tag t-${STATUS_TONE[status]}`} title={error ?? undefined}>
      {status === "working" && <span className="dot pulse" />}
      {label}
    </span>
  );
}

export function DueTag({ dueAt }: { dueAt: string | null }) {
  const due = dueLabel(dueAt);
  if (!dueAt) return <span className="faint">—</span>;
  return due.tone === "gray" ? <span className="muted">{due.text}</span> : <Tag tone={due.tone}>{due.text}</Tag>;
}
