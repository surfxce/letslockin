import Link from "next/link";

import { prepareLectures } from "@/app/actions";
import { ScoreTag, Tag } from "@/app/ui/bits";
import { CourseMenu } from "@/app/ui/CourseMenu";
import { Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import { LectureTable } from "@/app/ui/LectureTable";
import { prisma } from "@/lib/db";
import { daysUntil, dueLabel, plural, tagTone } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { dueLectures, lectureRows } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ course?: string; imported?: string }>;
}) {
  const { course: courseParam, imported } = await searchParams;
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, code: true, title: true, examDate: true },
  });

  if (courses.length === 0) return <Welcome />;

  // With one course there is nothing to choose between, so show it directly.
  const active = courses.find((c) => c.id === courseParam) ?? (courses.length === 1 ? courses[0] : null);
  const [rows, allDue, settings] = await Promise.all([
    lectureRows(active ? { courseId: active.id } : {}),
    dueLectures(),
    getSettings(),
  ]);
  const due = active ? allDue.filter((d) => d.courseId === active.id) : allDue;
  const toPrepare = rows.filter((r) => r.status === "todo" || r.status === "failed" || r.status === "summary");
  const daysToExam = active?.examDate ? daysUntil(active.examDate) : null;
  const practised = rows.filter((r) => r.lastScore !== null);
  const weakest = [...practised].sort((a, b) => a.lastScore! - b.lastScore!)[0];

  return (
    <main className="page">
      <h1 className="page-title">{active ? active.title : "Lectures"}</h1>
      <p className="page-sub">
        {active ? (
          <>
            <Tag tone={tagTone(active.code)}>{active.code}</Tag> · {plural(rows.length, "lecture")}
            {daysToExam !== null && (daysToExam >= 0 ? ` · exam in ${plural(daysToExam, "day")}` : " · exam has passed")}
          </>
        ) : (
          <>Every lecture across {plural(courses.length, "course")}, with how you are doing on each.</>
        )}
      </p>

      {imported && (
        <div className="callout blue">
          <span className="callout-icon">
            <Icon name="check" />
          </span>
          <p>
            Imported {plural(Number(imported), "lecture")}.{" "}
            {settings.mode === "auto"
              ? "They are being prepared one at a time — the top-right corner shows which lecture it is on and for how long."
              : "Open one and use Copy prompt to get its summary and LAQs from any AI chat."}
          </p>
        </div>
      )}

      {due.length > 0 && (
        <section id="due">
          <h2 style={{ marginTop: 0 }}>
            <span className="row">
              <Icon name="bell" /> Due for LAQs
            </span>
          </h2>
          <div className="due-strip">
            {due.slice(0, 8).map((d) => (
              <Link key={d.id} href={`/lectures/${d.id}`} className="due-card">
                <span className="t">{d.title}</span>
                <span className="m">
                  <Tag tone={dueLabel(d.dueAt).tone}>{dueLabel(d.dueAt).text}</Tag>
                  {!active && <span>{d.courseCode}</span>}
                  <span>L{d.ordinal}</span>
                  {d.lastScore !== null && (
                    <span className="row" style={{ gap: 4 }}>
                      last <ScoreTag score={d.lastScore} />
                    </span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="views">
        {courses.length > 1 && (
          <Link href="/?course=all" className={!active ? "on" : undefined}>
            <Icon name="list" size={15} /> All
          </Link>
        )}
        {courses.map((c) => (
          <Link key={c.id} href={`/?course=${c.id}`} className={active?.id === c.id ? "on" : undefined} title={c.title}>
            {c.code}
          </Link>
        ))}
        <Link href="/courses/new">
          <Icon name="plus" size={15} /> Course
        </Link>
      </div>

      <div className="row" style={{ margin: "14px 0 4px" }}>
        {active ? (
          <>
            <Link href={`/courses/${active.id}/import`} className="btn primary">
              <Icon name="folder" /> Import folder
            </Link>
            <Link href={`/lectures/new?course=${active.id}`} className="btn">
              <Icon name="plus" /> New lecture
            </Link>
          </>
        ) : (
          <CourseMenu courses={courses.map((c) => ({ id: c.id, code: c.code, title: c.title }))} />
        )}
        {settings.mode === "auto" && toPrepare.length > 0 && (
          <form action={prepareLectures}>
            {toPrepare.map((r) => (
              <input key={r.id} type="hidden" name="lectureId" value={r.id} />
            ))}
            <Submit className="btn" pending="Queueing…">
              <Icon name="sparkles" /> Prepare {plural(toPrepare.length, "lecture")}
            </Submit>
          </form>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {weakest && practised.length > 1 && (
          <span className="small muted row" style={{ gap: 6 }}>
            Weakest: <Link href={`/lectures/${weakest.id}`} className="link">L{weakest.ordinal}</Link>
            <ScoreTag score={weakest.lastScore} />
          </span>
        )}
        {active && (
          <Link href={`/courses/${active.id}/settings`} className="icon-btn" title={`${active.code} settings`}>
            <Icon name="gear" />
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <p>No lectures in {active?.code ?? "any course"} yet.</p>
          {active && (
            <Link href={`/courses/${active.id}/import`} className="btn primary">
              <Icon name="folder" /> Import a folder of lectures
            </Link>
          )}
        </div>
      ) : (
        <LectureTable
          rows={rows}
          showCourse={!active}
          storageKey={active?.id ?? "all"}
          newLectureHref={active ? `/lectures/new?course=${active.id}` : null}
        />
      )}
    </main>
  );
}

function Welcome() {
  return (
    <main className="page narrow">
      <div className="page-icon">📚</div>
      <h1 className="page-title">Welcome to Lockin</h1>
      <p className="page-sub">
        Lockin turns your lecture recordings and slides into a summary and long-answer questions for each lecture,
        marks your answers, and reminds you when each lecture is due again.
      </p>
      <div className="how">
        <div className="s">
          <b>1</b> Add a course, then point it at the folder your lecture files are in.
        </div>
        <div className="s">
          <b>2</b> Each lecture gets a summary and LAQs — automatically, or by copy and paste with any AI chat.
        </div>
        <div className="s">
          <b>3</b> Answer closed book, get marked, and come back when it is due.
        </div>
      </div>
      <div className="row">
        <Link href="/courses/new" className="btn primary lg">
          <Icon name="plus" /> Add your first course
        </Link>
        <a href="#intro" className="btn lg">
          How it works
        </a>
      </div>
    </main>
  );
}
