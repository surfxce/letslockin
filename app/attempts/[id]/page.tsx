import Link from "next/link";
import { notFound } from "next/navigation";

import { saveAttemptScores, startAttempt } from "@/app/actions";
import { AnswerForm } from "@/app/attempts/[id]/AnswerForm";
import { NotesSheet } from "@/app/attempts/[id]/NotesSheet";
import { DueTag, ScoreTag } from "@/app/ui/bits";
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
import { buildNotesSheet, notesFileName } from "@/lib/notes-sheet";

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
            draft: r.draftText,
          }))}
        />
      </main>
    );
  }

  const [settings, [row]] = await Promise.all([getSettings(), lectureRows({ ids: [attempt.lectureId] })]);
  const unmarked = responses.filter((r) => r.mark === null);
  const needsPaste = unmarked.length > 0 && settings.mode === "manual";
  const rows = responses.map((r) => ({ r, fb: feedbackFor(r), rubric: readRubric(r.question.rubric) }));
  // What to write down, straight from the marking: no extra AI call.
  const notes = buildNotesSheet({
    lectureTitle: attempt.lecture.title,
    sittingDate: attempt.sittingDate,
    responses: rows.map(({ r, fb, rubric }) => ({
      number: numbers.get(r.questionId) ?? 0,
      stem: r.question.stem,
      mark: r.mark,
      items: fb.items,
      gaps: r.gaps.map((g) => ({ type: g.type, text: g.text, concept: g.concept.name })),
      blank: r.mark !== null && !r.answerText.trim(),
      guide: rubric.criteria.map((c) => c.point),
    })),
  });

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
            <div className="row small muted" style={{ marginTop: 12, gap: 8 }}>
              <span>Drill score:</span>
              <ScoreTag score={row.lastScore} prev={row.prevScore} drillCount={row.drillCount} />
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

      <NotesSheet
        sheet={notes}
        pending={unmarked.length}
        manual={!usesAi(settings.mode)}
        fileName={notesFileName(attempt.lecture.title, attempt.sittingDate)}
        copy={{
          responseIds: responses.filter((r) => r.mark !== null).map((r) => r.id),
          // Copied once every marked answer's notes are; a newly marked one asks again.
          at: copiedAt(responses),
        }}
      />

      <FeedbackLegend />
      <div className="q-scores" style={{ borderTop: 0 }}>
        {rows.map(({ r, fb, rubric }) => (
          <div key={r.id} className="sitting" style={{ marginBottom: 14 }}>
            <QuestionScore
              label={`LAQ ${numbers.get(r.questionId) ?? "?"}`}
              mark={r.mark}
              raw={fb.raw ?? undefined}
              feedback={fb.items}
              pending={r.mark === null && usesAi(settings.mode)}
            />
            {r.mark !== null && (
              <Link href={`/attempts/${attempt.id}/notes/${r.id}`} className="btn sm" style={{ marginTop: 10 }}>
                {r.notesCopiedAt ? "✓ Notes copied down" : "Notes to copy down →"}
              </Link>
            )}
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
        ))}
      </div>

      {attempt.geometricMean !== null && (
        <div className="soft-card" style={{ marginTop: 22 }}>
          <h2 style={{ marginTop: 0 }}>Keep drilling</h2>
          <p className="small muted">The next sitting favours concepts your latest answers show are still weak. The drill score updates as you improve them.</p>
          <div className="row">
            <form action={startAttempt}>
              <input type="hidden" name="lectureId" value={attempt.lectureId} />
              <button type="submit" className="btn primary">Drill weak areas again</button>
            </form>
            {usesAi(settings.mode) && <Link href={`/lectures/${attempt.lectureId}?tab=laqs`} className="btn">Write new weak-area LAQs</Link>}
          </div>
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <Link href={`/lectures/${attempt.lectureId}?tab=scores`} className="link">
          Back to {attempt.lecture.title}
        </Link>
      </p>
    </main>
  );
}

/** When a sitting's notes were copied down: the latest, once every marked answer's are. */
function copiedAt(responses: Array<{ mark: number | null; notesCopiedAt: Date | null }>): string | null {
  const marked = responses.filter((r) => r.mark !== null);
  if (!marked.length || marked.some((r) => !r.notesCopiedAt)) return null;
  return new Date(Math.max(...marked.map((r) => r.notesCopiedAt!.getTime()))).toISOString();
}
