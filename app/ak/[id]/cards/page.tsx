import "../../ak.css";
import "./cards.css";

import Link from "next/link";
import { notFound } from "next/navigation";

import { CardsWorkshop, type WorkshopCard } from "@/app/ak/[id]/cards/CardsWorkshop";
import { Icon } from "@/app/ui/Icon";
import { prisma } from "@/lib/db";
import { plural, shortDate } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { lectureDecks, pictured } from "@/lib/slides";

export const dynamic = "force-dynamic";

const PER_PAGE = 100;

export default async function CardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string; q?: string; page?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const lecture = await prisma.lecture.findUnique({ where: { id }, select: { id: true, title: true, course: { select: { code: true } } } });
  if (!lecture) notFound();

  const q = query.q?.trim().slice(0, 200) ?? "";
  const page = Math.max(0, Math.floor(Number(query.page) || 0));
  const where = { lectureId: id, ...(q ? { OR: [{ front: { contains: q } }, { back: { contains: q } }] } : {}) };
  const [decks, cards, total, byOrigin] = await Promise.all([
    lectureDecks(id),
    prisma.flashcard.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: page * PER_PAGE, take: PER_PAGE }),
    prisma.flashcard.count({ where }),
    prisma.flashcard.groupBy({ by: ["origin"], where: { lectureId: id }, _count: true }),
  ]);
  const ranges = pictured(decks);
  const base = `/api/lectures/${encodeURIComponent(id)}/slides`;
  const listSlides = { base, ranges, print: true };
  const rows: WorkshopCard[] = cards.map((c) => ({
    id: c.id,
    front: c.front,
    back: c.back,
    frontHtml: renderMarkdown(c.front, listSlides),
    backHtml: renderMarkdown(c.back, listSlides),
    origin: c.origin,
    state: c.state,
    due: shortDate(c.dueAt),
  }));
  const count = (origin: string) => byOrigin.find((r) => r.origin === origin)?._count ?? 0;
  const all = byOrigin.reduce((n, r) => n + r._count, 0);
  const own = all - count("ai");
  const pages = Math.ceil(total / PER_PAGE);
  const link = (p: number) => `/ak/${id}/cards?${new URLSearchParams({ ...(q ? { q } : {}), ...(p ? { page: String(p) } : {}) })}`;

  return (
    <main className="page ak-review-page">
      <div className="crumbs">
        <Link href="/ak">AK</Link>
        <Icon name="chevronRight" size={13} />
        <span>{lecture.course.code}</span>
        <Icon name="chevronRight" size={13} />
        <Link href={`/ak/${id}`}>{lecture.title}</Link>
      </div>
      <div className="ak-heading">
        <div>
          <h1 className="page-title">Make your own cards</h1>
          <p className="page-sub">
            {lecture.title} · {plural(all, "card")}
            {all ? ` (${count("ai")} generated, ${own} yours)` : ""}
          </p>
        </div>
        {all > 0 && (
          <Link href={`/ak/${id}`} className="btn primary">
            <Icon name="play" size={15} /> Review
          </Link>
        )}
      </div>

      <CardsWorkshop
        lectureId={id}
        slides={{ base, ranges }}
        pictures={{ base, numbers: ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)) }}
        cards={rows}
        initialPanel={query.new === "occlusion" ? "occlusion" : query.new === "csv" ? "csv" : "write"}
      />

      {(all > PER_PAGE || q) && (
        <form className="ak-filters" action={`/ak/${id}/cards`}>
          <label className="ak-search">
            <Icon name="search" size={15} />
            <input name="q" aria-label="Search cards" placeholder="Find a card…" defaultValue={q} />
          </label>
          <button className="btn sm">Search</button>
          {q && (
            <Link href={`/ak/${id}/cards`} className="small link">
              Clear
            </Link>
          )}
          <span className="spacer" />
          {pages > 1 && (
            <span className="row small">
              {page > 0 && <Link href={link(page - 1)}>← Newer</Link>}
              <span className="muted">
                Page {page + 1} of {pages}
              </span>
              {page + 1 < pages && <Link href={link(page + 1)}>Older →</Link>}
            </span>
          )}
        </form>
      )}
    </main>
  );
}
