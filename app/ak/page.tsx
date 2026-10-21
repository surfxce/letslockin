import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSettings, readHeartbeat } from "@/lib/settings";
import { Tag } from "@/app/ui/bits";
import { tagTone, plural } from "@/lib/format";
import { Icon } from "@/app/ui/Icon";
import { DeckControls, DeckRefresh } from "@/app/ak/DeckControls";
import "./ak.css";

export const dynamic = "force-dynamic";

export default async function AKPage({ searchParams }: { searchParams: Promise<{ course?: string; q?: string; due?: string }> }) {
  const params = await searchParams;
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const [courses, settings, beat] = await Promise.all([
    prisma.course.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, title: true, code: true } }), getSettings(), readHeartbeat(),
  ]);
  const course = courses.find(c => c.id === params.course);
  const lectures = await prisma.lecture.findMany({
    where: { ...(course ? { courseId: course.id } : {}), ...(params.q ? { title: { contains: params.q.slice(0, 200) } } : {}) },
    orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, course: { select: { code: true } }, module: { select: { title: true } },
      _count: { select: {
        flashcards: true,
      } },
      jobs: { where: { kind: "FLASHCARDS" }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, error: true } },
    },
  });
  const ids = lectures.map(l => l.id);
  // Aggregate in SQLite: no card text or full review history in the library payload.
  const [newCounts, dueCounts, overdueCounts, learningCounts, nextDates] = await Promise.all([
    prisma.flashcard.groupBy({ by: ["lectureId"], where: { lectureId: { in: ids }, state: "new" }, _count: true }),
    prisma.flashcard.groupBy({ by: ["lectureId"], where: { lectureId: { in: ids }, state: { not: "new" }, dueAt: { lte: now } }, _count: true }),
    prisma.flashcard.groupBy({ by: ["lectureId"], where: { lectureId: { in: ids }, state: { not: "new" }, dueAt: { lt: dayStart } }, _count: true }),
    prisma.flashcard.groupBy({ by: ["lectureId"], where: { lectureId: { in: ids }, state: "learning" }, _count: true }),
    prisma.flashcard.groupBy({ by: ["lectureId"], where: { lectureId: { in: ids }, dueAt: { gt: now } }, _min: { dueAt: true } }),
  ]);
  const count = (rows: typeof newCounts, id: string) => rows.find(r => r.lectureId === id)?._count ?? 0;
  const rows = lectures.map(l => ({ ...l, fresh: count(newCounts, l.id), due: count(dueCounts, l.id), overdue: count(overdueCounts, l.id), learning: count(learningCounts, l.id), next: nextDates.find(r => r.lectureId === l.id)?._min.dueAt }));
  const visible = params.due === "1" ? rows.filter(r => r.fresh + r.due > 0) : rows;
  const total = (key: "fresh" | "due" | "overdue") => rows.reduce((n, r) => n + r[key], 0);
  const first = [...rows].sort((a, b) => b.overdue - a.overdue || b.due - a.due).find(r => r.fresh + r.due > 0);
  const active = rows.some(r => ["PENDING", "RUNNING"].includes(r.jobs[0]?.status));
  return <main className="page">
    <DeckRefresh active={active} />
    <div className="ak-heading"><div><h1 className="page-title">AK <span className="ak-subtitle">Anki Killer</span></h1>
      <p className="page-sub">Small questions. Lasting recall. Your lectures, one card at a time.</p></div>
      {first && <Link href={`/ak/${first.id}`} className="btn primary"><Icon name="play" size={15} /> Review now</Link>}
    </div>
    <div className="ak-stats">
      <div><strong className="ak-overdue">{total("overdue")}</strong><span>Overdue</span></div>
      <div><strong>{total("due")}</strong><span>Due now <small>includes overdue</small></span></div>
      <div><strong className="ak-new">{total("fresh")}</strong><span>New cards</span></div>
      <div><strong>{rows.filter(r => r._count.flashcards > 0).length}</strong><span>Decks ready</span></div>
    </div>
    {active && (!beat?.alive || settings.mode === "manual") && <div className="callout">Deck generation is waiting. {settings.mode === "manual" ? "Choose an AI in Settings to continue." : "Open the desktop app or start the worker to continue."}</div>}
    <div className="views">
      <Link href="/ak" className={!course ? "on" : undefined}>All courses</Link>
      {courses.map(c => <Link key={c.id} href={`/ak?course=${c.id}`} className={course?.id === c.id ? "on" : undefined}>{c.code}</Link>)}
    </div>
    <form className="ak-filters" action="/ak">
      {course && <input type="hidden" name="course" value={course.id} />}
      <label className="ak-search"><Icon name="search" size={15} /><input name="q" aria-label="Search decks" placeholder="Find a lecture…" defaultValue={params.q} /></label>
      <label className="row small"><input name="due" value="1" type="checkbox" defaultChecked={params.due === "1"} /> Ready to study</label>
      <button className="btn sm">Filter</button>
      <span className="spacer" />
      <Link href="/settings#ak" className="small muted link">Automatic generation {settings.autoFlashcards ? "on" : "off"}</Link>
    </form>
    <div className="db-wrap"><table className="db ak-table"><thead><tr><th>Lecture / deck</th><th>Course</th><th>New</th><th>Learning</th><th>Due now</th><th>Next review</th><th /></tr></thead>
      <tbody>{visible.map(r => {
        const job = r.jobs[0] ?? null;
        return <tr key={r.id}><td><Link className="ak-deck-title" href={`/ak/${r.id}`}><Icon name="layers" size={16} />{r.title}</Link>
          <div className="small muted">{r.module?.title ? `${r.module.title} · ` : ""}{plural(r._count.flashcards, "card")}
            {job && ["PENDING", "RUNNING"].includes(job.status) && ` · ${job.status === "RUNNING" ? "Writing cards…" : "Queued"}`}</div>
          {job?.status === "FAILED" && <div className="small ak-error">{job.error}</div>}
        </td><td><Tag tone={tagTone(r.course.code)}>{r.course.code}</Tag></td><td className="ak-new">{r.fresh || "—"}</td><td>{r.learning || "—"}</td>
        <td>{r.due || "—"}{r.overdue > 0 && <div className="small ak-overdue">{r.overdue} overdue</div>}</td>
        <td className="small muted">{r.fresh + r.due > 0 ? "Now" : r.next ? r.next.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—"}</td>
        <td>{r._count.flashcards ? <Link className="btn sm" href={`/ak/${r.id}`}>{r.fresh + r.due > 0 ? "Review" : "Open deck"}</Link> : <DeckControls lectureId={r.id} job={job} />}</td></tr>;
      })}</tbody></table></div>
    {!visible.length && <div className="empty"><p>{lectures.length ? "No decks are ready to study. Try clearing the filter." : "No lectures found. Add lectures to start building your decks."}</p><Link href="/" className="btn">Go to lectures</Link></div>}
    <p className="small muted">Review due cards first, then learn new ones. Ratings schedule each card independently of your LAQ scores.</p>
  </main>;
}
