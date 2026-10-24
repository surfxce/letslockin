import "@/app/viva/viva.css";

import Link from "next/link";
import { notFound } from "next/navigation";

import { VivaRoom } from "@/app/viva/[id]/VivaRoom";
import { DeckRefresh } from "@/app/ak/DeckControls";
import { Tag } from "@/app/ui/bits";
import { prisma } from "@/lib/db";
import { formatScore, scoreTone, shortDate } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { speechVia } from "@/lib/viva/listen";
import { usableModel } from "@/lib/voice/choice";
import { naturalStatus } from "@/lib/voice/natural";
import { readPlan, readTurns } from "@/lib/viva/schema";
import { caseStages } from "@/lib/cases/service";
import { STAGE_LABEL } from "@/lib/cases/schema";

export const dynamic = "force-dynamic";

export default async function VivaSittingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viva = await prisma.viva.findUnique({ where: { id } });
  if (!viva) notFound();
  const plan = readPlan(viva.plan);
  const turns = readTurns(viva.turns);
  // A clinical case names its stages; one deleted since is just "Stage n".
  const stages = viva.caseId ? await caseStages(viva.caseId) : null;
  const stageOf = new Map((stages ?? []).map((s) => [s.questionId, STAGE_LABEL[s.kind]]));
  const stageLabels = stages ? plan.map((p) => stageOf.get(p.questionId) ?? "") : undefined;
  const crumbs = (
    <nav className="crumbs">
      <Link href={stages ? "/cases" : "/viva"}>{stages ? "Clinical cases" : "Viva"}</Link>
      <span className="sep">/</span>
      <span>{viva.title}</span>
    </nav>
  );

  if (viva.waitingOn !== "done") {
    return (
      <main className="page narrow">
        {crumbs}
        <VivaRoom
          vivaId={viva.id}
          title={viva.title}
          initial={{ waitingOn: viva.waitingOn, current: viva.current, total: plan.length, turns, error: null }}
          speech={await speechVia()}
          canSpeak={!!usableModel((await getSettings()).voiceModel, naturalStatus().ready)}
          stageLabels={stageLabels}
        />
      </main>
    );
  }

  const [questions, responses] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: plan.map((p) => p.questionId) } },
      select: { id: true, stem: true, lecture: { select: { title: true, course: { select: { code: true } } } } },
    }),
    prisma.response.findMany({
      where: { id: { in: plan.flatMap((p) => (p.responseId ? [p.responseId] : [])) } },
      select: { id: true, mark: true, attemptId: true },
    }),
  ]);
  const questionOf = new Map(questions.map((q) => [q.id, q]));
  const responseOf = new Map(responses.map((r) => [r.id, r]));
  const marks = responses.map((r) => r.mark);
  const marked = marks.filter((m): m is number => m !== null);
  const mean = marks.length && marked.length === marks.length ? marked.reduce((a, b) => a + b, 0) / marked.length : null;
  const pending = marks.length - marked.length;

  return (
    <main className="page narrow">
      {crumbs}
      <DeckRefresh active={pending > 0} />
      <h1 className="page-title">{viva.title}</h1>
      <p className="page-sub">
        {shortDate(viva.createdAt)} · {plan.length} question{plan.length === 1 ? "" : "s"}
        {mean !== null ? (
          <>
            {" "}
            · <Tag tone={scoreTone(mean)}>{formatScore(mean)}/10</Tag>
          </>
        ) : pending ? (
          ` · marking ${pending}…`
        ) : null}
      </p>
      {plan.map((item, i) => {
        const q = questionOf.get(item.questionId);
        const r = item.responseId ? responseOf.get(item.responseId) : undefined;
        const exchange = turns.filter((t) => t.questionId === item.questionId);
        return (
          <section key={item.questionId} className="viva-result">
            <div className="row" style={{ gap: 8 }}>
              <b>{stageLabels ? `Stage ${i + 1}${stageLabels[i] ? ` · ${stageLabels[i]}` : ""}` : `Question ${i + 1}`}</b>
              <span className="small muted">
                {q ? `${q.lecture.course.code} · ${q.lecture.title}` : stages ? "This case has since been deleted" : "This question has since been deleted"}
              </span>
              <span className="spacer" />
              {r ? (
                r.mark !== null ? (
                  <Tag tone={scoreTone(r.mark)}>{formatScore(r.mark)}/10</Tag>
                ) : (
                  <span className="small muted">Marking…</span>
                )
              ) : null}
            </div>
            <div className="viva-turns compact">
              {exchange.map((t, k) => (
                <div key={k} className={`viva-turn ${t.role}`}>
                  <div className="viva-who">{t.role === "examiner" ? "Examiner" : "You"}</div>
                  <div className="viva-said">{t.text}</div>
                </div>
              ))}
              {!exchange.some((t) => t.role === "student") && <p className="small muted">Not answered.</p>}
            </div>
            {r && r.mark !== null && (
              <Link href={`/attempts/${r.attemptId}/notes/${r.id}`} className="btn sm">
                What the marker said
              </Link>
            )}
          </section>
        );
      })}
      <div className="row" style={{ marginTop: 24 }}>
        <Link href={stages ? "/cases" : "/viva"} className="btn primary">
          {stages ? "Another case" : "Another viva"}
        </Link>
      </div>
    </main>
  );
}
