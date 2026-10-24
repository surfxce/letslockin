import "@/app/lessons/lessons.css";

import Link from "next/link";
import { notFound } from "next/navigation";

import { LessonChecks } from "@/app/lessons/[id]/LessonChecks";
import { Markdown } from "@/app/ui/render";
import { prisma } from "@/lib/db";
import { shortDate } from "@/lib/format";
import { readChecks } from "@/lib/lessons/schema";

export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lesson = await prisma.lesson.findUnique({
    where: { id },
    include: { concept: { select: { name: true, lecture: { select: { id: true, title: true, course: { select: { code: true } } } } } } },
  });
  if (!lesson) notFound();
  const lecture = lesson.concept.lecture;
  const gaps = await prisma.gap.findMany({
    where: { conceptId: lesson.conceptId, createdAt: { lte: lesson.createdAt } },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: { id: true, type: true, text: true },
  });

  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/lessons">Mini-lessons</Link>
        <span className="sep">/</span>
        <span>{lesson.concept.name}</span>
      </nav>
      <h1 className="page-title">{lesson.concept.name}</h1>
      <p className="page-sub">
        {lecture ? (
          <>
            {lecture.course.code} · <Link href={`/lectures/${lecture.id}`}>{lecture.title}</Link> ·{" "}
          </>
        ) : null}
        missed in {lesson.gapCount} answers
        {lesson.doneAt ? ` · done ${shortDate(lesson.doneAt)}` : ""}
      </p>

      {gaps.length > 0 && (
        <section className="lesson-gaps">
          <h2>What kept going wrong</h2>
          <ul>
            {gaps.map((g) => (
              <li key={g.id}>
                <span className={`lesson-gap ${g.type === "WRONG" ? "wrong" : "missed"}`}>{g.type === "WRONG" ? "Wrong" : "Missed"}</span> {g.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="lesson-body">
        <Markdown md={lesson.explanation} />
      </section>

      <section>
        <h2>Check yourself</h2>
        <p className="small muted">Answer each in your head first, then look.</p>
        <LessonChecks lessonId={lesson.id} checks={readChecks(lesson.checks)} done={!!lesson.doneAt} canCard={!!lesson.lectureId} />
      </section>

      {lecture && (
        <p className="small muted lesson-next">
          Then prove it: <Link href={`/lectures/${lecture.id}?tab=laqs`}>sit this lecture&apos;s LAQs</Link> — the next sitting asks more on what you&apos;re weakest at.
        </p>
      )}
    </main>
  );
}
