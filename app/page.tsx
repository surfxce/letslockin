import Link from "next/link";
import { createCourse } from "./actions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lectures: true, concepts: true } } },
  });

  return (
    <>
      <h1>Courses</h1>
      <p className="sub">
        A course holds its lectures and, more importantly, one shared list of concepts —
        which is what stops the same idea being scored three times under three names.
      </p>

      {courses.length === 0 ? (
        <p className="empty">No courses yet. Add the one you are studying now.</p>
      ) : (
        <div className="rows">
          {courses.map((c) => (
            <Link key={c.id} className="row" href={`/courses/${c.id}`}>
              <span>
                <span className="name">{c.code}</span>{" "}
                <span className="meta">{c.title}</span>
              </span>
              <span className="num">
                {c._count.lectures} lecture{c._count.lectures === 1 ? "" : "s"} ·{" "}
                {c._count.concepts} concept{c._count.concepts === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
        </div>
      )}

      <h2>Add a course</h2>
      <form className="stack" action={createCourse}>
        <label className="field">
          <span>Code</span>
          <input name="code" placeholder="BIOL3010" required />
        </label>
        <label className="field">
          <span>Title</span>
          <input name="title" placeholder="Genetics" required />
        </label>
        <label className="field">
          <span>Exam date — drives how hard the scheduler pushes as it approaches</span>
          <input name="examDate" type="date" />
        </label>
        <button type="submit">Add course</button>
      </form>
    </>
  );
}
