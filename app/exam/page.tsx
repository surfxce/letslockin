import "./exam.css";

import Link from "next/link";

import { removeExam } from "@/app/exam/actions";
import { ExamSetup } from "@/app/exam/ExamSetup";
import { Tag } from "@/app/ui/bits";
import { Icon } from "@/app/ui/Icon";
import { prisma } from "@/lib/db";
import { summarise, examTree } from "@/lib/exam/service";
import { clockTime, duration, formatScore, scoreTone, shortDate } from "@/lib/format";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function ExamPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const { course } = await searchParams;
  const [tree, settings, exams] = await Promise.all([
    examTree(),
    getSettings(),
    prisma.exam.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        items: {
          select: { kind: true, choice: true, questionId: true, mcq: { select: { answer: true } }, response: { select: { mark: true } } },
        },
      },
    }),
  ]);
  const open = exams.filter((e) => !e.submittedAt);
  const done = exams.filter((e) => e.submittedAt);

  return (
    <main className="page">
      <h1 className="page-title">Exam</h1>
      <p className="page-sub">
        A mixed paper from across your lectures — multiple choice, then long answers, closed book and timed. Long answers are marked like
        any sitting and count towards each lecture&apos;s drill score.
      </p>

      {open.map((e) => (
        <div key={e.id} className="callout blue exam-open">
          <Icon name="clock" size={16} />
          <span>
            <b>{e.title}</b> started {shortDate(e.createdAt)} at {clockTime(e.createdAt)} — {e.items.length} questions
            {e.timeLimitMin ? `, ${e.timeLimitMin} minutes` : ""}.
          </span>
          <span className="spacer" />
          <Link href={`/exam/${e.id}`} className="btn sm primary">
            Continue
          </Link>
          <form action={removeExam}>
            <input type="hidden" name="examId" value={e.id} />
            <button className="btn sm quiet">Discard</button>
          </form>
        </div>
      ))}

      <ExamSetup tree={tree} ai={usesAi(settings.mode)} course={course} />

      {done.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h2>Past exams</h2>
          <div className="db-wrap">
            <table className="db exam-table">
              <thead>
                <tr>
                  <th>Exam</th>
                  <th>Multiple choice</th>
                  <th>Long answers</th>
                  <th>Time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {done.map((e) => {
                  const s = summarise(e.items);
                  const took = e.submittedAt!.getTime() - e.createdAt.getTime();
                  return (
                    <tr key={e.id}>
                      <td>
                        <Link href={`/exam/${e.id}`} className="ak-deck-title">
                          <Icon name="target" size={15} />
                          {e.title}
                        </Link>
                        <div className="small muted">
                          {shortDate(e.createdAt)} · {clockTime(e.createdAt)}
                        </div>
                      </td>
                      <td>
                        {s.mcqTotal ? (
                          <Tag tone={scoreTone((s.mcqCorrect / s.mcqTotal) * 10)}>
                            {s.mcqCorrect}/{s.mcqTotal} · {Math.round((s.mcqCorrect / s.mcqTotal) * 100)}%
                          </Tag>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        {s.laqScore !== null ? (
                          <Tag tone={scoreTone(s.laqScore)}>{formatScore(s.laqScore)}/10</Tag>
                        ) : s.laqTotal ? (
                          <span className="small muted">Marking {s.pending}…</span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="small muted">
                        {duration(took)}
                        {e.timeLimitMin && took > e.timeLimitMin * 60_000 ? <span className="exam-over"> · over time</span> : null}
                      </td>
                      <td>
                        <Link href={`/exam/${e.id}`} className="btn sm">
                          Results
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
