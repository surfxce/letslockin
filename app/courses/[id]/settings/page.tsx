import Link from "next/link";
import { notFound } from "next/navigation";

import { deleteCourse, deleteModule, updateCourse } from "@/app/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { prisma } from "@/lib/db";
import { dateInput, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CourseSettings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const course = await prisma.course.findUnique({
    where: { id },
    include: {
      modules: { orderBy: { position: "asc" }, include: { _count: { select: { lectures: true } } } },
      _count: { select: { lectures: true } },
    },
  });
  if (!course) notFound();
  const attempts = await prisma.attempt.count({ where: { lecture: { courseId: id } } });

  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <Link href={`/?course=${course.id}`}>{course.code}</Link>
        <span className="sep">/</span>
        <span>Settings</span>
      </nav>
      <h1 className="page-title">{course.code} settings</h1>
      <p className="page-sub">
        {plural(course._count.lectures, "lecture")} · {plural(attempts, "sitting")}
      </p>

      <ActionForm action={updateCourse} className="form">
        <input type="hidden" name="courseId" value={course.id} />
        <div className="form-grid">
          <label className="field">
            <span>Course code</span>
            <input name="code" defaultValue={course.code} required />
          </label>
          <label className="field" style={{ gridColumn: "span 2" }}>
            <span>Name</span>
            <input name="title" defaultValue={course.title} required />
          </label>
        </div>
        <label className="field">
          <span>Exam date</span>
          <input
            name="examDate"
            type="date"
            defaultValue={course.examDate ? dateInput(course.examDate) : ""}
            style={{ maxWidth: 200 }}
          />
        </label>
        <div className="row">
          <Submit pending="Saving…">Save</Submit>
          <FormResult />
        </div>
      </ActionForm>

      <h2>Modules</h2>
      {course.modules.length === 0 ? (
        <p className="muted">
          None. Modules come from folder names when you import (“Module 2 - Heart”), or from a lecture&apos;s details.
        </p>
      ) : (
        <div className="files">
          {course.modules.map((m) => (
            <div key={m.id} className="file" style={{ alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                <span className="fname">{m.title}</span>{" "}
                <span className="small muted">· {plural(m._count.lectures, "lecture")}</span>
              </span>
              <form action={deleteModule}>
                <input type="hidden" name="moduleId" value={m.id} />
                <Submit className="btn quiet sm" confirm={`Remove the module "${m.title}"? Its lectures stay.`}>
                  Remove
                </Submit>
              </form>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ color: "var(--danger)" }}>Delete this course</h2>
      <p className="muted">
        Removes {plural(course._count.lectures, "lecture")}, {plural(attempts, "sitting")}, every mark, and the copies of
        your files Lockin made. The originals in your folders are not touched. This cannot be undone.
      </p>
      <ActionForm action={deleteCourse} className="form">
        <input type="hidden" name="courseId" value={course.id} />
        <label className="field">
          <span>
            Type <strong>{course.code}</strong> to confirm
          </span>
          <input name="confirm" placeholder={course.code} autoComplete="off" required style={{ maxWidth: 240 }} />
        </label>
        <div className="row">
          <Submit className="btn danger solid" pending="Deleting…">
            Delete {course.code}
          </Submit>
          <FormResult />
        </div>
      </ActionForm>
    </main>
  );
}
