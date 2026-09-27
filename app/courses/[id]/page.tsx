import Link from "next/link";
import { notFound } from "next/navigation";

import { createLecture, createModule } from "@/app/actions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type LectureRow = {
  id: string;
  title: string;
  deliveredOn: Date;
  durationHours: number;
  _count: { concepts: number; attempts: number };
};

export default async function CoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ imported?: string }>;
}) {
  const { id } = await params;
  const { imported } = await searchParams;
  const course = await prisma.course.findUnique({
    where: { id },
    include: {
      modules: { orderBy: { position: "asc" } },
      lectures: {
        orderBy: { deliveredOn: "asc" },
        include: { _count: { select: { concepts: true, attempts: true } } },
      },
    },
  });
  if (!course) notFound();

  const daysToExam = course.examDate
    ? Math.ceil((course.examDate.getTime() - Date.now()) / 86_400_000)
    : null;

  // The number lives here, not in the title: it is a position in the course, so it
  // renumbers itself when a lecture is added out of order.
  const ordinal = new Map<string, number>();
  course.lectures.forEach((l, i) => ordinal.set(l.id, i + 1));

  const byModule = new Map<string | null, LectureRow[]>();
  for (const l of course.lectures) {
    const key = l.moduleId ?? null;
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key)!.push(l);
  }
  const groups: Array<{ title: string; lectures: LectureRow[] }> = [
    ...course.modules
      .filter((m) => byModule.has(m.id))
      .map((m) => ({ title: m.title, lectures: byModule.get(m.id)! })),
    ...(byModule.has(null) ? [{ title: "Unassigned", lectures: byModule.get(null)! }] : []),
  ];

  return (
    <>
      <p className="crumb">
        <Link href="/">Courses</Link> / {course.code}
      </p>
      <h1>{course.title}</h1>
      <p className="sub">
        {course.code}
        {daysToExam !== null && (
          <>
            {" · "}
            {daysToExam >= 0 ? `${daysToExam} days to the exam` : "exam has passed"}
          </>
        )}
        {" · "}
        {course.lectures.length} lecture{course.lectures.length === 1 ? "" : "s"} across{" "}
        {course.modules.length} module{course.modules.length === 1 ? "" : "s"}
      </p>

      {imported && (
        <div className="note">
          <p>
            Imported {imported} lecture{imported === "1" ? "" : "s"}. Summaries and concepts
            are queued — the worker picks them up one at a time.
          </p>
        </div>
      )}

      <div className="inline" style={{ marginBottom: 24 }}>
        <Link href={`/courses/${course.id}/import`}>
          <button type="button">Import from a folder</button>
        </Link>
        <Link href={`/courses/${course.id}/settings`}>
          <button type="button" className="ghost">Settings</button>
        </Link>
      </div>

      <h2>Lectures</h2>
      {groups.length === 0 ? (
        <p className="empty">
          Nothing yet. Point the importer at wherever your lecture files already live —
          titles, dates and modules are read off the files rather than typed in.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.title} style={{ marginBottom: 22 }}>
            <p className="label" style={{ marginBottom: 8 }}>{g.title}</p>
            <div className="rows">
              {g.lectures.map((l) => (
                <Link key={l.id} className="row" href={`/lectures/${l.id}`}>
                  <span>
                    <span className="label" style={{ marginRight: 8 }}>L{ordinal.get(l.id)}</span>
                    <span className="name">{l.title}</span>
                    <br />
                    <span className="meta">
                      {DAYS[l.deliveredOn.getDay()]}, {l.deliveredOn.toLocaleDateString()} ·{" "}
                      {l.durationHours}h
                    </span>
                  </span>
                  <span className="num">
                    {l._count.concepts} concept{l._count.concepts === 1 ? "" : "s"} ·{" "}
                    {l._count.attempts} attempt{l._count.attempts === 1 ? "" : "s"}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))
      )}

      <h2>Modules</h2>
      <p className="sub" style={{ marginBottom: 12 }}>
        Add the divisions your course publishes and the importer will assign lectures to
        them rather than inventing its own.
      </p>
      {course.modules.length > 0 && (
        <div className="rows" style={{ marginBottom: 12 }}>
          {course.modules.map((m) => (
            <div key={m.id} className="row">
              <span className="name">{m.title}</span>
              <span className="num">
                {(byModule.get(m.id) ?? []).length} lecture
                {(byModule.get(m.id) ?? []).length === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
      <form className="stack" action={createModule}>
        <input type="hidden" name="courseId" value={course.id} />
        <div className="inline">
          <label className="field" style={{ flex: 1 }}>
            <span>Module title</span>
            <input name="title" placeholder="Module 3: Gene expression" required />
          </label>
          <button className="ghost" type="submit">Add module</button>
        </div>
      </form>

      <details style={{ marginTop: 32 }}>
        <summary className="label" style={{ cursor: "pointer" }}>
          Add a lecture by hand
        </summary>
        <form className="stack" action={createLecture} style={{ marginTop: 12 }}>
          <input type="hidden" name="courseId" value={course.id} />
          <label className="field">
            <span>Title</span>
            <input name="title" required />
          </label>
          <div className="inline">
            <label className="field">
              <span>Delivered on</span>
              <input name="deliveredOn" type="date" />
            </label>
            <label className="field">
              <span>Hours — two questions per hour</span>
              <input name="durationHours" type="number" step="0.5" min="0.5" defaultValue="1" />
            </label>
          </div>
          <button className="ghost" type="submit">Add lecture</button>
        </form>
      </details>
    </>
  );
}
