import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoRefresh } from "@/app/AutoRefresh";
import { submitAttempt } from "@/app/actions";
import { prisma } from "@/lib/db";
import { roundMark } from "@/lib/engines/geomean";

export const dynamic = "force-dynamic";

interface Marking {
  criteria: Array<{ point: string; awarded: number; outOf: number; note: string | null }>;
}

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: {
      lecture: { include: { course: true } },
      responses: {
        orderBy: { id: "asc" },
        include: {
          question: true,
          gaps: { include: { concept: true } },
        },
      },
    },
  });
  if (!attempt) notFound();

  const answered = attempt.responses.some((r) => r.answerText.trim());
  const marked = attempt.responses.filter((r) => r.mark !== null);
  const awaiting = answered && marked.length < attempt.responses.filter((r) => r.answerText.trim()).length;

  // Closed book: the summary is unreachable from here until the answers are in.
  if (!answered) return <Answering attempt={attempt} />;

  return (
    <>
      <AutoRefresh active={awaiting} />
      <p className="crumb">
        <Link href="/">Courses</Link> /{" "}
        <Link href={`/courses/${attempt.lecture.courseId}`}>{attempt.lecture.course.code}</Link> /{" "}
        <Link href={`/lectures/${attempt.lectureId}`}>{attempt.lecture.title}</Link> / attempt
      </p>
      <h1>{attempt.lecture.title}</h1>
      <p className="sub">
        Attempt of {attempt.sittingDate.toLocaleDateString()} · {attempt.responses.length} question
        {attempt.responses.length === 1 ? "" : "s"}
      </p>

      {attempt.geometricMean !== null ? (
        <div className="panel score">
          <div>
            <p className="label">Geometric mean</p>
            <p className="big">{roundMark(attempt.geometricMean, 2)}</p>
          </div>
          <p className="workings">
            {marked.map((r) => roundMark(r.mark!, 1)).join(" × ")} , to the power of 1/
            {marked.length}. A zero anywhere zeroes the sitting — which is the point:
            averaging 0 and 10 flatters an answer that would have scored nothing.
          </p>
        </div>
      ) : (
        <div className="note">
          <p>
            {awaiting
              ? "Marking. Each answer is compared against the rubric frozen when the question was written, so the same answer scores the same every time."
              : "Not all questions were answered, so there is no geometric mean for this sitting."}
          </p>
        </div>
      )}

      {attempt.responses.map((r, i) => {
        const marking: Marking | null = r.rawMarkingJson ? JSON.parse(r.rawMarkingJson) : null;
        return (
          <div key={r.id} className="panel" style={{ marginTop: 18 }}>
            <div className="qhead">
              <span className="label">Question {i + 1}</span>
              {r.mark !== null && <span className="mark">{roundMark(r.mark, 1)}/10</span>}
            </div>
            <p style={{ fontWeight: 500, marginTop: 6 }}>{r.question.stem}</p>

            <details open>
              <summary className="label" style={{ cursor: "pointer", margin: "14px 0 6px" }}>
                What you wrote
              </summary>
              <pre className="raw">{r.answerText || "(left blank)"}</pre>
            </details>

            {marking && (
              <>
                <p className="label" style={{ margin: "16px 0 6px" }}>Rubric</p>
                <div className="criteria">
                  {marking.criteria.map((c, n) => (
                    <div key={n} className={`crit ${c.awarded >= c.outOf ? "got" : "lost"}`}>
                      <span className="num">
                        {c.awarded}/{c.outOf}
                      </span>
                      <span>
                        {c.point}
                        {c.note && <em className="cnote"> — {c.note}</em>}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {r.gaps.length > 0 && (
              <>
                <p className="label" style={{ margin: "16px 0 6px" }}>
                  For the binder — {r.gaps.length} to write down
                </p>
                <div className="concepts">
                  {r.gaps.map((g) => (
                    <div key={g.id} className="concept">
                      <span className={`chip ${g.type === "WRONG" ? "fail" : ""}`}>{g.type}</span>{" "}
                      <span className="cdef" style={{ color: "var(--ink)" }}>{g.text}</span>
                      <div className="cref">{g.concept.name}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}

      <p style={{ marginTop: 24 }}>
        <Link href={`/lectures/${attempt.lectureId}`}>Back to the lecture</Link>
      </p>
    </>
  );
}

function Answering({
  attempt,
}: {
  attempt: {
    id: string;
    lectureId: string;
    lecture: { title: string };
    responses: Array<{ id: string; question: { stem: string } }>;
  };
}) {
  return (
    <>
      <h1>{attempt.lecture.title}</h1>
      <p className="sub">
        Closed book. The summary, the concepts and the transcript are all out of reach until
        you submit — retrieving it from memory is the part that works, and reading it back is
        the part that only feels like it does.
      </p>
      <div className="note">
        <p>
          Dot points are fine. So is dictation — tap the mic on your keyboard and talk. Marking
          credits the substance, not the grammar.
        </p>
      </div>

      <form action={submitAttempt}>
        <input type="hidden" name="attemptId" value={attempt.id} />
        {attempt.responses.map((r, i) => (
          <div key={r.id} className="panel" style={{ marginBottom: 18 }}>
            <span className="label">Question {i + 1}</span>
            <p style={{ fontWeight: 500, margin: "6px 0 12px" }}>{r.question.stem}</p>
            <textarea
              name={`answer.${r.id}`}
              rows={10}
              style={{ width: "100%" }}
              placeholder="Answer from memory…"
            />
          </div>
        ))}
        <button type="submit">Submit for marking</button>
      </form>
    </>
  );
}
