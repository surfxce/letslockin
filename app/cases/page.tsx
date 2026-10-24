import "@/app/exam/exam.css";
import "@/app/viva/viva.css";
import "./cases.css";

import Link from "next/link";

import { CaseWriter, type WriterCourse } from "@/app/cases/CaseWriter";
import { removeCase, runCase } from "@/app/cases/actions";
import { DeckRefresh } from "@/app/ak/DeckControls";
import { Tag } from "@/app/ui/bits";
import { Icon } from "@/app/ui/Icon";
import { STAGE_LABEL } from "@/lib/cases/schema";
import { caseRows } from "@/lib/cases/service";
import { prisma } from "@/lib/db";
import { formatScore, scoreTone, shortDate } from "@/lib/format";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function CasesPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const { course } = await searchParams;
  const [settings, rows, courses, jobs] = await Promise.all([
    getSettings(),
    caseRows(),
    prisma.course.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        code: true,
        title: true,
        lectures: { where: { summaryMd: { not: null } }, orderBy: [{ deliveredOn: "asc" }, { createdAt: "asc" }], select: { id: true, title: true } },
      },
    }),
    prisma.job.findMany({ where: { kind: "CASE" }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, error: true, createdAt: true } }),
  ]);
  const ai = usesAi(settings.mode);
  const writing = jobs.filter((j) => j.status === "PENDING" || j.status === "RUNNING");
  // Only the latest try's failure: an older one has been followed by another try.
  const failed = jobs[0]?.status === "FAILED" && jobs[0].error !== "Cancelled" ? jobs[0] : null;
  const writer: WriterCourse[] = courses.filter((c) => c.lectures.length);

  return (
    <main className="page">
      <DeckRefresh active={writing.length > 0} />
      <div className="views">
        <Link href="/viva">Viva</Link>
        <Link href="/cases" className="on">
          Clinical cases
        </Link>
      </div>
      <h1 className="page-title">Clinical cases</h1>
      <p className="page-sub">
        OSCE-style: the examiner presents a patient, then asks you about them a stage at a time — what you&apos;d ask, what you&apos;d look for,
        which tests, the diagnosis, the management — telling you what each stage found before the next. Answer out loud or type. Each stage is
        marked like an LAQ and counts towards its lecture.
      </p>
      {!ai && (
        <div className="callout">
          <span>
            Cases need an AI to write them and be the examiner. <Link href="/settings">Choose one in Settings</Link>.
          </span>
        </div>
      )}

      <CaseWriter courses={writer} ready={ai} initialCourse={course} />
      {writing.length > 0 && (
        <p className="small muted case-writing">
          <Icon name="sparkles" size={13} /> Writing {writing.length === 1 ? "a case" : `${writing.length} cases`}… it appears below when it&apos;s ready.
        </p>
      )}
      {failed && !writing.length && <p className="small error-text">The last case couldn&apos;t be written: {failed.error}</p>}

      {rows.length > 0 && (
        <section style={{ marginTop: 30 }}>
          <h2>Your cases</h2>
          <div className="case-list">
            {rows.map((c) => (
              <article key={c.id} className="case-card">
                <div className="case-top">
                  <b>{c.title}</b>
                  {c.last?.mean != null ? (
                    <Tag tone={scoreTone(c.last.mean)}>{formatScore(c.last.mean)}/10</Tag>
                  ) : c.last?.marking ? (
                    <span className="small muted">Marking…</span>
                  ) : null}
                </div>
                <div className="small muted">
                  {c.courseCode} · {c.lectures.join(", ") || "lectures since deleted"} · {shortDate(c.createdAt)}
                </div>
                <div className="case-stages small">
                  {c.stages.map((k, i) => (
                    <span key={i}>{STAGE_LABEL[k as keyof typeof STAGE_LABEL] ?? k}</span>
                  ))}
                </div>
                <div className="row case-actions">
                  {c.last && !c.last.done ? (
                    <Link href={`/viva/${c.last.vivaId}`} className="btn sm primary">
                      Continue
                    </Link>
                  ) : (
                    <form action={runCase}>
                      <input type="hidden" name="caseId" value={c.id} />
                      <button className="btn sm primary" disabled={!ai}>
                        <Icon name="play" size={12} /> {c.last ? "Run it again" : "Start"}
                      </button>
                    </form>
                  )}
                  {c.last?.done && (
                    <Link href={`/viva/${c.last.vivaId}`} className="btn sm">
                      Last results
                    </Link>
                  )}
                  <span className="spacer" />
                  <form action={removeCase}>
                    <input type="hidden" name="caseId" value={c.id} />
                    <button className="btn sm quiet" title="Delete this case and the marks of its stages">
                      <Icon name="trash" size={13} />
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
