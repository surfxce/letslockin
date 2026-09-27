import Link from "next/link";
import { notFound } from "next/navigation";

import { deleteCourse, deleteModule, updateCourse } from "@/app/actions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CourseSettings({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const course = await prisma.course.findUnique({
    where: { id },
    include: {
      modules: { orderBy: { position: "asc" }, include: { _count: { select: { lectures: true } } } },
      _count: { select: { lectures: true, concepts: true } },
    },
  });
  if (!course) notFound();

  const attempts = await prisma.attempt.count({ where: { lecture: { courseId: id } } });

  return (
    <>
      <p className="crumb">
        <Link href="/">Courses</Link> /{" "}
        <Link href={`/courses/${course.id}`}>{course.code}</Link> / settings
      </p>
      <h1>{course.code} settings</h1>
      <p className="sub">
        {course._count.lectures} lectures · {course._count.concepts} concepts · {attempts} attempt
        {attempts === 1 ? "" : "s"}
      </p>

      {saved && (
        <div className="note">
          <p>Saved.</p>
        </div>
      )}

      <h2>Details</h2>
      <form className="stack" action={updateCourse}>
        <input type="hidden" name="courseId" value={course.id} />
        <label className="field">
          <span>Code</span>
          <input name="code" defaultValue={course.code} required />
        </label>
        <label className="field">
          <span>Title</span>
          <input name="title" defaultValue={course.title} required />
        </label>
        <label className="field">
          <span>Exam date</span>
          <input
            name="examDate"
            type="date"
            defaultValue={course.examDate?.toISOString().slice(0, 10) ?? ""}
          />
        </label>
        <button type="submit">Save</button>
      </form>

      <h2>Modules</h2>
      {course.modules.length === 0 ? (
        <p className="empty">None yet. Add them on the course page.</p>
      ) : (
        <div className="rows">
          {course.modules.map((m) => (
            <div key={m.id} className="row">
              <span>
                <span className="name">{m.title}</span>
                <br />
                <span className="meta">
                  {m._count.lectures} lecture{m._count.lectures === 1 ? "" : "s"} — they move to
                  Unassigned, they are not deleted
                </span>
              </span>
              <form action={deleteModule}>
                <input type="hidden" name="moduleId" value={m.id} />
                <button className="ghost" type="submit">Delete</button>
              </form>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ color: "var(--weak)" }}>Delete this course</h2>
      <div className="warn">
        <p>
          This removes {course._count.lectures} lecture
          {course._count.lectures === 1 ? "" : "s"}, {course._count.concepts} concept
          {course._count.concepts === 1 ? "" : "s"}, {attempts} attempt
          {attempts === 1 ? "" : "s"} and every mark and gap recorded against them, plus the
          uploaded files on disk. It cannot be undone.
        </p>
      </div>
      <form className="stack" action={deleteCourse}>
        <input type="hidden" name="courseId" value={course.id} />
        <label className="field">
          <span>
            Type <strong>{course.code}</strong> to confirm
          </span>
          <input name="confirm" placeholder={course.code} autoComplete="off" required />
        </label>
        <button type="submit" className="danger">
          Delete {course.code} permanently
        </button>
      </form>
    </>
  );
}
