import "../exam.css";

import Link from "next/link";
import { notFound } from "next/navigation";

import { removeExam } from "@/app/exam/actions";
import { ExamSitting, type SittingItem } from "@/app/exam/[id]/ExamSitting";
import { Submit } from "@/app/ui/forms";
import { FeedbackLegend, Markdown, QuestionScore } from "@/app/ui/render";
import { prisma } from "@/lib/db";
import { LETTERS } from "@/lib/exam/pick";
import { summarise } from "@/lib/exam/service";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { clockTime, duration, formatScore, scoreTone, shortDate } from "@/lib/format";
import { readOptions } from "@/lib/mcq/service";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";
import "@/app/ak/ak.css";
import { MistakeCards } from "@/app/ak/MistakeCards";
import { mistakesLeft, wrongMcqsLeft } from "@/lib/flashcards/mistakes";

export const dynamic = "force-dynamic";

const lecture = { select: { id: true, title: true, course: { select: { code: true } } } } as const;

export default async function ExamSittingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          mcq: { include: { lecture } },
          question: { include: { lecture } },
          response: { include: { gaps: { include: { concept: { select: { name: true } } } } } },
        },
      },
    },
  });
  if (!exam) notFound();

  const crumbs = (
    <nav className="crumbs">
      <Link href="/exam">Exam</Link>
      <span className="sep">/</span>
      <span>{exam.title}</span>
    </nav>
  );

  // Questions whose lecture was deleted since are left out.
  let mcqNo = 0;
  let laqNo = 0;
  const items = exam.items
    .filter((i) => (i.kind === "MCQ" ? i.mcq && readOptions(i.mcq.options).length : i.question))
    .map((i) => ({ ...i, number: i.kind === "MCQ" ? ++mcqNo : ++laqNo }));

  if (!exam.submittedAt) {
    const sitting: SittingItem[] = items.map((i) => ({
      id: i.id,
      kind: i.kind === "MCQ" ? "MCQ" : "LAQ",
      number: i.number,
      stem: i.kind === "MCQ" ? i.mcq!.stem : i.question!.stem,
      options: i.kind === "MCQ" ? readOptions(i.mcq!.options) : [],
      choice: i.choice,
      draft: i.draftText,
    }));
    return (
      <main className="page narrow">
        {crumbs}
        <ExamSitting examId={exam.id} title={exam.title} startedAt={exam.createdAt.toISOString()} timeLimitMin={exam.timeLimitMin} items={sitting} />
      </main>
    );
  }

  const laqResponseIds = exam.items.filter((i) => i.kind === "LAQ" && i.response?.mark !== null && i.responseId).map((i) => i.responseId!);
  const [settings, gapsLeft, mcqsLeft, gapCount] = await Promise.all([
    getSettings(),
    mistakesLeft(laqResponseIds),
    wrongMcqsLeft(exam.id),
    prisma.gap.count({ where: { responseId: { in: laqResponseIds } } }),
  ]);
  const s = summarise(exam.items);
  const wrongMcqs = s.mcqTotal - s.mcqCorrect;
  const took = exam.submittedAt.getTime() - exam.createdAt.getTime();
  const mcqs = items.filter((i) => i.kind === "MCQ");
  const laqs = items.filter((i) => i.kind === "LAQ");
  const unmarkedAttempts = [...new Set(laqs.filter((i) => i.response && i.response.mark === null).map((i) => i.response!.attemptId))];

  // Where the marks went, lecture by lecture.
  const byLecture = new Map<string, { title: string; code: string; right: number; asked: number; marks: Array<number | null> }>();
  for (const i of items) {
    const l = i.kind === "MCQ" ? i.mcq!.lecture : i.question!.lecture;
    const row = byLecture.get(l.id) ?? { title: l.title, code: l.course.code, right: 0, asked: 0, marks: [] };
    if (i.kind === "MCQ") {
      row.asked++;
      if (i.choice === i.mcq!.answer) row.right++;
    } else if (i.response) {
      row.marks.push(i.response.mark);
    }
    byLecture.set(l.id, row);
  }

  return (
    <main className="page narrow">
      {crumbs}
      <h1 className="page-title">{exam.title}</h1>
      <p className="page-sub">
        Sat {shortDate(exam.createdAt)} at {clockTime(exam.createdAt)} · took {duration(took)}
        {exam.timeLimitMin ? ` of ${exam.timeLimitMin} minutes` : ""}
        {exam.timeLimitMin && took > exam.timeLimitMin * 60_000 ? <span className="exam-over"> · {duration(took - exam.timeLimitMin * 60_000)} over</span> : null}
      </p>

      <div className="exam-scores">
        {s.mcqTotal > 0 && (
          <div className="sitting">
            <div className="sitting-head">
              <span className={`big-score t-${scoreTone((s.mcqCorrect / s.mcqTotal) * 10)}`}>
                {Math.round((s.mcqCorrect / s.mcqTotal) * 100)}
                <small>%</small>
              </span>
              <div>
                <div className="when">Multiple choice</div>
                <div className="sub">
                  {s.mcqCorrect} of {s.mcqTotal} right
                </div>
              </div>
            </div>
          </div>
        )}
        {s.laqTotal > 0 && (
          <div className="sitting">
            <div className="sitting-head">
              {s.laqScore !== null ? (
                <span className={`big-score t-${scoreTone(s.laqScore)}`}>
                  {formatScore(s.laqScore)}
                  <small>/10</small>
                </span>
              ) : (
                <span className="tag t-blue">
                  <span className="dot pulse" /> Marking {s.pending}
                </span>
              )}
              <div>
                <div className="when">Long answers</div>
                <div className="sub">
                  {s.laqScore !== null
                    ? `Geometric mean of ${s.laqTotal}: ${s.laqMarks.map(formatScore).join(" × ")}`
                    : `${s.laqMarks.length} of ${s.laqTotal} marked`}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <MistakeCards examId={exam.id} left={gapsLeft + mcqsLeft} made={gapCount - gapsLeft + wrongMcqs - mcqsLeft} />

      {unmarkedAttempts.length > 0 && !usesAi(settings.mode) && (
        <div className="callout">
          <span>
            Copy & paste mode: the long answers are marked lecture by lecture, in an AI chat.{" "}
            {unmarkedAttempts.map((a, i) => (
              <Link key={a} href={`/attempts/${a}`} className="link" style={{ marginRight: 8 }}>
                Mark lecture {i + 1} →
              </Link>
            ))}
          </span>
        </div>
      )}

      {byLecture.size > 1 && (
        <section className="exam-breakdown">
          <h2>By lecture</h2>
          <table className="db" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th>Lecture</th>
                <th>Multiple choice</th>
                <th>Long answers</th>
              </tr>
            </thead>
            <tbody>
              {[...byLecture.entries()].map(([lectureId, r]) => (
                <tr key={lectureId}>
                  <td>
                    <Link href={`/lectures/${lectureId}?tab=scores`} className="link">
                      {r.title}
                    </Link>{" "}
                    <span className="small faint">{r.code}</span>
                  </td>
                  <td className={r.right < r.asked ? "exam-over" : undefined}>{r.asked ? `${r.right}/${r.asked}` : <span className="faint">—</span>}</td>
                  <td>{r.marks.length ? r.marks.map((m) => (m === null ? "…" : formatScore(m))).join(", ") : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {mcqs.length > 0 && (
        <section>
          <h2 className="exam-section">Multiple choice</h2>
          {mcqs.map((i) => {
            const options = readOptions(i.mcq!.options);
            const right = i.choice === i.mcq!.answer;
            return (
              <div key={i.id} className={`exam-mcq exam-result ${right ? "right" : "wrong"}`}>
                <div className="laq-num">
                  Question {i.number} · {right ? "right" : i.choice === null ? "not answered" : "wrong"}
                  <span className="exam-from">{i.mcq!.lecture.title}</span>
                </div>
                <Markdown md={i.mcq!.stem} className="laq-stem" />
                <div className="exam-options-list">
                  {options.map((o, n) => (
                    <div
                      key={n}
                      className={n === i.mcq!.answer ? "correct" : n === i.choice ? "chosen" : undefined}
                    >
                      <span className="exam-letter">{LETTERS[n]}</span>
                      <span>{o}</span>
                      {n === i.mcq!.answer && <span className="exam-tick">✓ answer</span>}
                      {n === i.choice && n !== i.mcq!.answer && <span className="exam-cross">your choice</span>}
                    </div>
                  ))}
                </div>
                <p className="exam-explain">{i.mcq!.explanation}</p>
              </div>
            );
          })}
        </section>
      )}

      {laqs.length > 0 && (
        <section>
          <h2 className="exam-section">Long answers</h2>
          <FeedbackLegend />
          {laqs.map((i) => {
            const r = i.response;
            const fb = r ? feedbackFor(r) : { raw: null, items: [] };
            const rubric = readRubric(i.question!.rubric);
            return (
              <div key={i.id} className="sitting" style={{ marginBottom: 14 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  {i.question!.lecture.course.code} · {i.question!.lecture.title}
                </div>
                <QuestionScore
                  label={`LAQ ${i.number}`}
                  mark={r?.mark ?? null}
                  raw={fb.raw ?? undefined}
                  feedback={fb.items}
                  pending={!!r && r.mark === null && usesAi(settings.mode)}
                />
                {r && r.mark !== null && (
                  <Link href={`/attempts/${r.attemptId}/notes/${r.id}`} className="btn sm" style={{ marginTop: 10 }}>
                    {r.notesCopiedAt ? "✓ Notes copied down" : "Notes to copy down →"}
                  </Link>
                )}
                <details style={{ marginTop: 10 }}>
                  <summary className="small muted" style={{ cursor: "pointer" }}>
                    Question, your answer{rubric.criteria.length ? " and the marking guide" : ""}
                  </summary>
                  <Markdown md={i.question!.stem} className="laq-stem" />
                  <pre className="model-answer" style={{ fontFamily: "var(--sans)" }}>
                    {r?.answerText || "(left blank)"}
                  </pre>
                  {rubric.criteria.length > 0 && (
                    <ul className="criteria">
                      {rubric.criteria.map((c, n) => (
                        <li key={n}>
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
        </section>
      )}

      <div className="row" style={{ marginTop: 24 }}>
        <Link href="/exam" className="btn primary">
          Another exam
        </Link>
        <form action={removeExam}>
          <input type="hidden" name="examId" value={exam.id} />
          <input type="hidden" name="back" value="1" />
          <Submit className="btn quiet" confirm="Delete this exam's results? Its long answers stay with their lectures as sittings.">
            Delete these results
          </Submit>
        </form>
      </div>
    </main>
  );
}
