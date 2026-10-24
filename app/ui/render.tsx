import { SlideErrors } from "@/app/ui/SlideErrors";
import { formatScore, scoreTone } from "@/lib/format";
import { renderMarkdown, type SlideImages } from "@/lib/markdown";
import type { FeedbackKind } from "@/lib/paste";

/**
 * Display pieces shared by saved views and live paste previews, so what the
 * preview shows is exactly what will be saved. Render-only: no hooks.
 */

export function Markdown({ md, className = "prose", slides }: { md: string; className?: string; slides?: SlideImages }) {
  return (
    <>
      <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(md, slides) }} />
      {slides && <SlideErrors watch={md} />}
    </>
  );
}

export interface LaqData {
  number: number;
  stem: string;
  marks: number | null;
  criteria: Array<{ point: string; marks: number | null }>;
  modelAnswer: string | null;
}

export function LaqCard({
  laq,
  extra,
  action,
}: {
  laq: LaqData;
  /** Concepts, source, attempts — shown under the stem. */
  extra?: React.ReactNode;
  /** A small control in the corner, e.g. delete. */
  action?: React.ReactNode;
}) {
  const hasGuide = laq.criteria.length > 0 || !!laq.modelAnswer;
  return (
    <div className="laq">
      <div className="laq-num">LAQ {laq.number}</div>
      <Markdown md={laq.stem} className="laq-stem" />
      {(extra || laq.marks) && (
        <div className="laq-meta">
          {laq.marks ? <span>{laq.marks} marks</span> : null}
          {extra}
        </div>
      )}
      {hasGuide && (
        // Closed by default: the marking guide is the answer, and reading it first
        // turns a recall test into a reading exercise.
        <details>
          <summary>Marking guide{laq.modelAnswer ? " & model answer" : ""} — open after you have answered</summary>
          {laq.criteria.length > 0 && (
            <ul className="criteria">
              {laq.criteria.map((c, i) => (
                <li key={i}>
                  <span className="mk">{c.marks ?? "·"}</span>
                  <span>{c.point}</span>
                </li>
              ))}
            </ul>
          )}
          {laq.modelAnswer && <div className="model-answer">{laq.modelAnswer}</div>}
        </details>
      )}
      {action && <div className="remove">{action}</div>}
    </div>
  );
}

const FB_ICON: Record<FeedbackKind, string> = { good: "✓", missed: "○", wrong: "✕", note: "•" };

export function FeedbackList({ items }: { items: Array<{ kind: FeedbackKind; text: string }> }) {
  if (items.length === 0) return null;
  return (
    <ul className="feedback">
      {items.map((f, i) => (
        <li key={i} className={`fb-${f.kind}`}>
          <span className="fb-icon">{FB_ICON[f.kind]}</span>
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function FeedbackLegend() {
  return (
    <div className="legend">
      <span className="fb-good">
        <span className="fb-icon">{FB_ICON.good}</span> got right
      </span>
      <span className="fb-missed">
        <span className="fb-icon">{FB_ICON.missed}</span> missed — write it down
      </span>
      <span className="fb-wrong">
        <span className="fb-icon">{FB_ICON.wrong}</span> got wrong — the correct fact
      </span>
      <span className="fb-note">
        <span className="fb-icon">{FB_ICON.note}</span> partly right — some of the marks
      </span>
    </div>
  );
}

export function ScoreBar({ mark }: { mark: number }) {
  return (
    <span className="bar" aria-hidden="true">
      <i className={`fill-${scoreTone(mark)}`} style={{ width: `${Math.max(3, mark * 10)}%` }} />
    </span>
  );
}

export function QuestionScore({
  label,
  mark,
  raw,
  stem,
  feedback,
  pending,
}: {
  label: string;
  mark: number | null;
  raw?: string;
  stem?: string;
  feedback: Array<{ kind: FeedbackKind; text: string }>;
  pending?: boolean;
}) {
  return (
    <div className="q-score">
      <div className="lab">{label}</div>
      <div>
        {stem && <div className="stem">{stem}</div>}
        <div className="row">
          {mark === null ? (
            <span className="tag t-blue">
              {pending && <span className="dot pulse" />}
              {pending ? "Marking…" : "Not marked"}
            </span>
          ) : (
            <>
              <span className={`tag score t-${scoreTone(mark)}`}>{formatScore(mark)} / 10</span>
              <ScoreBar mark={mark} />
              {raw && raw !== `${mark}/10` && <span className="faint small">marked {raw}</span>}
            </>
          )}
        </div>
        <FeedbackList items={feedback} />
      </div>
    </div>
  );
}
