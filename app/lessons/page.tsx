import "@/app/lessons/lessons.css";

import Link from "next/link";

import { WriteLesson } from "@/app/lessons/WriteLesson";
import { DeckRefresh } from "@/app/ak/DeckControls";
import { prisma } from "@/lib/db";
import { shortDate } from "@/lib/format";
import { LESSON_AFTER, lessonsBeingWritten, weakSpots } from "@/lib/lessons/service";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function LessonsPage() {
  const [lessons, spots, writing, settings] = await Promise.all([
    prisma.lesson.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, conceptId: true, gapCount: true, createdAt: true, doneAt: true, concept: { select: { name: true, lecture: { select: { title: true } } } } },
    }),
    weakSpots(),
    lessonsBeingWritten(),
    getSettings(),
  ]);
  const ai = usesAi(settings.mode);
  const waiting = lessons.filter((l) => !l.doneAt);
  const done = lessons.filter((l) => l.doneAt);
  const covered = new Set(waiting.map((l) => l.conceptId));
  const uncovered = spots.filter((s) => !covered.has(s.conceptId));

  return (
    <main className="page narrow">
      <DeckRefresh active={writing.size > 0} />
      <h1 className="page-title">Mini-lessons</h1>
      <p className="page-sub">
        When the marker says you&apos;ve missed or got the same thing wrong in {LESSON_AFTER} or more answers, Lockin writes a short lesson on just that: a
        few paragraphs from the lecture, aimed at what went wrong, and three quick questions. They show up in Today.
      </p>

      <section>
        <h2>Waiting</h2>
        {waiting.length ? (
          <ul className="lesson-list">
            {waiting.map((l) => (
              <li key={l.id}>
                <Link href={`/lessons/${l.id}`}>{l.concept.name}</Link>
                <span className="small muted">
                  {l.concept.lecture?.title ?? ""} · missed in {l.gapCount} answers
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{writing.size ? "One's being written." : "None right now."}</p>
        )}
      </section>

      {uncovered.length > 0 && (
        <section>
          <h2>Weak spots</h2>
          <p className="small muted">Concepts that keep coming up in the marker&apos;s notes and haven&apos;t been put right since.</p>
          <ul className="lesson-list">
            {uncovered.slice(0, 20).map((s) => (
              <li key={s.conceptId}>
                <b>{s.name}</b>
                <span className="small muted">
                  {s.lectureTitle ?? ""} · missed in {s.answers} answers, last {shortDate(s.latest)}
                </span>
                {ai && <WriteLesson conceptId={s.conceptId} busy={writing.has(s.conceptId)} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2>Done</h2>
          <ul className="lesson-list">
            {done.map((l) => (
              <li key={l.id}>
                <Link href={`/lessons/${l.id}`}>{l.concept.name}</Link>
                <span className="small muted">
                  {l.concept.lecture?.title ?? ""} · {shortDate(l.doneAt!)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
