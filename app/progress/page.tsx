import "./progress.css";

import Link from "next/link";

import { Heatmap } from "@/app/progress/Heatmap";
import { LectureMap } from "@/app/progress/LectureMap";
import { ScoreChart } from "@/app/progress/ScoreChart";
import { Icon } from "@/app/ui/Icon";
import { prisma } from "@/lib/db";
import { progressData } from "@/lib/progress/data";

export const dynamic = "force-dynamic";

export default async function ProgressPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const { course: courseParam } = await searchParams;
  const courses = await prisma.course.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, code: true, title: true } });
  const course = courses.find((c) => c.id === courseParam);
  const data = await progressData(course?.id);
  const s = data.stats;
  const tiles: Array<[string | number, string]> = [
    [`${s.prepared}/${s.lectures}`, "Lectures prepared"],
    [s.sittings, "LAQ sittings marked"],
    [s.answers, "Answers marked"],
    [s.reviews, "AK reviews"],
    [s.exams, "Exams sat"],
    [s.streak ? `${s.streak} day${s.streak === 1 ? "" : "s"}` : "—", "Study streak"],
  ];

  return (
    <main className="page">
      <h1 className="page-title">Progress</h1>
      <p className="page-sub">How ready you are, how your scores are moving, and how your lectures fit together.</p>

      {courses.length > 1 && (
        <div className="views">
          <Link href="/progress" className={!course ? "on" : undefined}>
            All courses
          </Link>
          {courses.map((c) => (
            <Link key={c.id} href={`/progress?course=${c.id}`} className={course?.id === c.id ? "on" : undefined} title={c.title}>
              {c.code}
            </Link>
          ))}
        </div>
      )}

      <div className="pg-tiles">
        {tiles.map(([value, label]) => (
          <div key={label} className="pg-tile">
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <section className="pg-section">
        <h2>If the exam were today</h2>
        <p className="pg-sub">
          Your latest drill score on each lecture, averaged, as a percentage. Lectures you haven&apos;t drilled yet count as zero — that&apos;s the gap
          to close.
        </p>
        <div className="pg-ready viz">
          {data.courses.map((c) => (
            <div key={c.id} className="pg-ready-card">
              <div className="pg-ready-top">
                <b>{c.code}</b>
                <span className="small muted">{c.title}</span>
              </div>
              <div className="pg-hero">
                {c.predicted === null ? "—" : Math.round(c.predicted)}
                {c.predicted !== null && <small>%</small>}
              </div>
              <div className="pg-cover" title={`${c.drilled} of ${c.lectures} lectures drilled`}>
                <span style={{ width: `${c.lectures ? (c.drilled / c.lectures) * 100 : 0}%` }} />
              </div>
              <p>
                {c.lectures
                  ? `${c.drilled} of ${c.lectures} lectures drilled${c.drilledAverage !== null ? `, averaging ${Math.round(c.drilledAverage)}%` : ""}.`
                  : "No lectures with LAQs yet."}
                {c.mcqAsked ? ` Exam multiple choice: ${Math.round((c.mcqRight / c.mcqAsked) * 100)}% right (${c.mcqRight}/${c.mcqAsked}).` : ""}
                {c.examDays !== null && c.examDays >= 0 ? ` Exam in ${c.examDays} day${c.examDays === 1 ? "" : "s"}` : ""}
                {c.examDays !== null && c.examDays >= 0 && c.weighting ? `, worth ${Math.round(c.weighting * 100)}% of the grade.` : c.examDays !== null && c.examDays >= 0 ? "." : ""}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="pg-section">
        <h2>Scores over time</h2>
        <p className="pg-sub">Each marked sitting, out of 10, with the average of your last few as a line.</p>
        <ScoreChart scores={data.scores} />
        {data.scores.length > 0 && (
          <details className="pg-table">
            <summary>As a table</summary>
            <table className="db">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Lecture</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {[...data.scores].reverse().slice(0, 40).map((p, i) => (
                  <tr key={i}>
                    <td>{new Date(p.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</td>
                    <td>{p.lecture}</td>
                    <td>{p.score.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="pg-section">
        <h2>Every concept</h2>
        <p className="pg-sub">
          One square per concept, by lecture, coloured by its latest mark. Red squares are what to revise; striped ones haven&apos;t been asked yet.
        </p>
        <Heatmap rows={data.heat} multiCourse={!course && courses.length > 1} />
      </section>

      <section className="pg-section">
        <h2>How your lectures relate</h2>
        <p className="pg-sub">
          Lectures are linked by the distinctive words they share — terms that turn up in a few lectures count far more than ones that are
          everywhere. <Icon name="help" size={13} /> Close lectures are worth revising together.
        </p>
        <LectureMap nodes={data.map.nodes} links={data.map.links} courses={courses.filter((c) => data.courseOrder.includes(c.id))} />
      </section>
    </main>
  );
}
