import Link from "next/link";
import { notFound } from "next/navigation";

import { saveAttemptScores } from "@/app/actions";
import { AnswerForm } from "@/app/attempts/[id]/AnswerForm";
import { DueTag } from "@/app/ui/bits";
import { CopyButton } from "@/app/ui/CopyButton";
import { Icon } from "@/app/ui/Icon";
import { PasteBox } from "@/app/ui/PasteBox";
import { FeedbackLegend, Markdown, QuestionScore } from "@/app/ui/render";
import { prisma } from "@/lib/db";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { clockTime, formatScore, scoreTone, shortDate } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { lectureRows, questionNumbers } from "@/lib/views";
import { usesAi } from "@/lib/modes";

export const dynamic = "force-dynamic";

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: {
      lecture: { include: { course: { select: { code: true } } } },
      responses: { include: { question: true, gaps: { include: { concept: { select: { name: true } } } } } },
    },
  });
  if (!attempt) notFound();

  const numbers = await questionNumbers(attempt.lectureId);
  const responses = [...attempt.responses].sort(
    (a, b) => (numbers.get(a.questionId) ?? 0) - (numbers.get(b.questionId) ?? 0),
  );
  const answered = responses.some((r) => r.answerText.trim() || r.mark !== null);

  const crumbs = (
    <nav className="crumbs">
      <Link href="/">Lectures</Link>
      <span className="sep">/</span>
      <Link href={`/?course=${attempt.lecture.courseId}`}>{attempt.lecture.course.code}</Link>
      <span className="sep">/</span>
      <Link href={`/lectures/${attempt.lectureId}?tab=scores`}>{attempt.lecture.title}</Link>
    </nav>
  );

  // Closed book: nothing about the lecture is reachable from here until answers are in.
  if (!answered) {
    return (
      <main className="page narrow">
        {crumbs}
        <h1 className="page-title">{attempt.lecture.title}</h1>
        <p className="page-sub">
          Closed book — no summary, no notes. Retrieving it from memory is the part that works; reading it back only
          feels like it does. Marking credits the substance, not the grammar.
        </p>
        <AnswerForm
          attemptId={attempt.id}
          questions={responses.map((r) => ({
            responseId: r.id,
            number: numbers.get(r.questionId) ?? 0,
            stem: r.question.stem,
          }))}
        />
      </main>
    );
  }

  const [settings, [row]] = await Promise.all([getSettings(), lectureRows({ ids: [attempt.lectureId] })]);
  const unmarked = responses.filter((r) => r.mark === null);
  const needsPaste = unmarked.length > 0 && settings.mode === "manual";

  return (
    <main className="page narrow">
      {crumbs}
      <h1 className="page-title">{attempt.lecture.title}</h1>
      <p className="page-sub">
        Sitting of {shortDate(attempt.sittingDate)}, {clockTime(attempt.sittingDate)}
      </p>

      {attempt.geometricMean !== null ? (
        <div className="sitting" style={{ marginBottom: 22 }}>
          <div className="sitting-head">
            <span className={`big-score t-${scoreTone(attempt.geometricMean)}`}>
              {formatScore(attempt.geometricMean)}
              <small>/10</small>
            </span>
            <div style={{ flex: 1 }}>
              <div className="when">Geometric mean of {responses.length} answers</div>
              <div className="sub">
                {responses.map((r) => formatScore(r.mark ?? 0)).join(" × ")}, then the {responses.length === 2 ? "square" : `${responses.length}th`} root. One
                weak answer pulls the whole sitting down — as it would in the exam.
              </div>
            </div>
          </div>
          {row && (
            <div className="row small muted" style={{ marginTop: 12 }}>
              <Icon name="bell" size={14} /> Next sitting: <DueTag dueAt={row.dueAt} />
            </div>
          )}
        </div>
      ) : needsPaste ? (
        <div className="soft-card" style={{ marginBottom: 22 }}>
          <h3 style={{ marginTop: 0 }}>Get it marked</h3>
          <div className="how">
            <div className="s">
              <b>1</b> Copy the marking prompt — your answers and each marking guide are in it.
            </div>
            <div className="s">
              <b>2</b> Paste it into any AI chat.
            </div>
            <div className="s">
              <b>3</b> Paste the marking it writes back here.
            </div>
          </div>
          <div className="stack">
            <div className="row">
              <CopyButton url={`/api/attempts/${attempt.id}/prompt`} label="Copy marking prompt" className="btn primary" />
            </div>
            <PasteBox kind="scores" action={saveAttemptScores} hidden={{ attemptId: attempt.id }} saveLabel="Save marks" />
          </div>
        </div>
      ) : (
        <div className="progress" style={{ marginBottom: 22 }}>
          <div className="progress-head">
            <span className="dot pulse" style={{ color: "var(--accent)" }} />
            Marking {unmarked.length} answer{unmarked.length === 1 ? "" : "s"} against the marking guide
            <span className="small muted" style={{ fontWeight: 400 }}>
              · marking goes ahead of anything else queued
            </span>
          </div>
        </div>
      )}

      <FeedbackLegend />
      <div className="q-scores" style={{ borderTop: 0 }}>
        {responses.map((r) => {
          const fb = feedbackFor(r);
          const rubric = readRubric(r.question.rubric);
          return (
            <div key={r.id} className="sitting" style={{ marginBottom: 14 }}>
              <QuestionScore
                label={`LAQ ${numbers.get(r.questionId) ?? "?"}`}
                mark={r.mark}
                raw={fb.raw ?? undefined}
                feedback={fb.items}
                pending={r.mark === null && usesAi(settings.mode)}
              />
              <details style={{ marginTop: 10 }}>
                <summary className="small muted" style={{ cursor: "pointer" }}>
                  Question, your answer{rubric.criteria.length ? " and the marking guide" : ""}
                </summary>
                <Markdown md={r.question.stem} className="laq-stem" />
                <pre className="model-answer" style={{ fontFamily: "var(--sans)" }}>
                  {r.answerText || "(left blank)"}
                </pre>
                {rubric.criteria.length > 0 && (
                  <ul className="criteria">
                    {rubric.criteria.map((c, i) => (
                      <li key={i}>
                        <span className="mk">{c.marks ?? "·"}</span>
                        <span>{c.point}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </div>
          );
        })}
      </div>

      <p style={{ marginTop: 24 }}>
        <Link href={`/lectures/${attempt.lectureId}?tab=scores`} className="link">
          Back to {attempt.lecture.title}
        </Link>
      </p>
    </main>
  );
}
