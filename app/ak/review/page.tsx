import Link from "next/link";

import { nextCard } from "@/app/ak/actions";
import { Review } from "@/app/ak/Review";
import { Icon } from "@/app/ui/Icon";
import { prisma } from "@/lib/db";
import type { ReviewScope } from "@/lib/flashcards/review";
import { cleanTag } from "@/lib/flashcards/tags";
import "../ak.css";

export const dynamic = "force-dynamic";

/** Reviewing across decks: everything due, a course, a tag, or hard cards. */
export default async function ReviewAllPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string; lecture?: string; tag?: string; hard?: string }>;
}) {
  const q = await searchParams;
  const [course, lecture] = await Promise.all([
    q.course ? prisma.course.findUnique({ where: { id: q.course }, select: { id: true, code: true } }) : null,
    q.lecture ? prisma.lecture.findUnique({ where: { id: q.lecture }, select: { id: true, title: true } }) : null,
  ]);
  const tag = q.tag ? cleanTag(q.tag) : "";
  const scope: ReviewScope = {
    ...(course ? { courseId: course.id } : {}),
    ...(lecture ? { lectureId: lecture.id } : {}),
    ...(tag ? { tag } : {}),
    hard: q.hard === "1",
  };
  const what = [scope.hard ? "Hard cards" : "Due cards", lecture?.title ?? course?.code ?? "", tag ? `#${tag}` : ""].filter(Boolean).join(" · ");
  return (
    <main className="page ak-review-page">
      <div className="crumbs">
        <Link href="/ak">AK</Link>
        <Icon name="chevronRight" size={13} />
        <span>{what}</span>
      </div>
      <h1 className="page-title">{scope.hard ? "Hard cards" : lecture || course || tag ? "Review" : "Review everything due"}</h1>
      <p className="page-sub">
        {scope.hard
          ? "Cards you've forgotten more than once, or keep marking hard — due or not. Each comes up once, unless you miss it again."
          : `${[lecture?.title, course?.code, tag ? `#${tag}` : ""].filter(Boolean).join(" · ") || "Every deck"}, due cards first, then new ones.`}
      </p>
      <Review
        scope={scope}
        initial={await nextCard(scope)}
        across={!lecture}
        done={scope.hard ? "No hard cards left in this session." : "Nothing else is due here right now."}
      />
    </main>
  );
}
