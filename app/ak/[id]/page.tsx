import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { nextCard } from "@/app/ak/actions";
import { Review } from "@/app/ak/Review";
import { DeckControls, DeckRefresh } from "@/app/ak/DeckControls";
import { Icon } from "@/app/ui/Icon";
import "../ak.css";

export const dynamic = "force-dynamic";
export default async function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lecture = await prisma.lecture.findUnique({ where: { id }, select: {
    id: true, title: true, course: { select: { code: true } }, _count: { select: { flashcards: true } },
    jobs: { where: { kind: "FLASHCARDS" }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, error: true } },
  } });
  if (!lecture) notFound();
  const job = lecture.jobs[0] ?? null;
  const busy = !!job && ["PENDING", "RUNNING"].includes(job.status);
  return <main className="page ak-review-page">
    <div className="crumbs"><Link href="/ak">AK</Link><Icon name="chevronRight" size={13} /><span>{lecture.course.code}</span></div>
    <h1 className="page-title">{lecture.title}</h1>
    <p className="page-sub">{lecture._count.flashcards} cards · <Link href={`/lectures/${id}`}>Open lecture</Link></p>
    {lecture._count.flashcards ? <Review lectureId={id} initial={await nextCard(id)} /> : <div className="ak-done">
      <DeckRefresh active={busy} /><Icon name="layers" size={32} /><h2>{busy ? "Your deck is on its way" : "Make this lecture stick"}</h2>
      <p>{busy ? "Cards are generated independently of your summary and LAQs. You can leave this page while they’re being written." : "Generate a deck of focused questions and answers, with diagrams from your lecture slides."}</p>
      {job?.status === "FAILED" && <p className="ak-error" role="alert">{job.error}</p>}
      <DeckControls lectureId={id} job={job} />
    </div>}
  </main>;
}
