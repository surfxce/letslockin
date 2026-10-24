import "@/app/exam/exam.css";
import "./viva.css";

import Link from "next/link";

import { removeViva } from "@/app/viva/actions";
import { VivaSetup } from "@/app/viva/VivaSetup";
import { Tag } from "@/app/ui/bits";
import { Icon } from "@/app/ui/Icon";
import { prisma } from "@/lib/db";
import { examTree } from "@/lib/exam/service";
import { clockTime, formatScore, scoreTone, shortDate } from "@/lib/format";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";
import { speechVia } from "@/lib/viva/listen";
import { readPlan } from "@/lib/viva/schema";

export const dynamic = "force-dynamic";

export default async function VivaPage({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const { course } = await searchParams;
  const [tree, settings, vivas, speech] = await Promise.all([
    examTree(),
    getSettings(),
    prisma.viva.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
    speechVia(),
  ]);
  const responseIds = vivas.flatMap((v) => readPlan(v.plan).flatMap((p) => (p.responseId ? [p.responseId] : [])));
  const marks = new Map(
    (await prisma.response.findMany({ where: { id: { in: responseIds } }, select: { id: true, mark: true } })).map((r) => [r.id, r.mark]),
  );
  const ai = usesAi(settings.mode);
  // Clinical cases are run as vivas, and listed with the cases.
  const open = vivas.filter((v) => !v.caseId && v.waitingOn !== "done");
  const done = vivas.filter((v) => !v.caseId && v.waitingOn === "done");

  return (
    <main className="page">
      <div className="views">
        <Link href="/viva" className="on">
          Viva
        </Link>
        <Link href="/cases">Clinical cases</Link>
      </div>
      <h1 className="page-title">Viva</h1>
      <p className="page-sub">
        An oral exam. The examiner asks one of your LAQs, listens to your answer and follows up on anything you left out — then moves on.
        Answer out loud or type. Each answer is marked like a sitting and counts towards its lecture&apos;s drill score.
      </p>

      {!ai && (
        <div className="callout">
          <span>
            A viva needs an AI to be the examiner. <Link href="/settings">Choose one in Settings</Link>.
          </span>
        </div>
      )}
      {ai && (
        <p className="small muted" style={{ marginTop: -6 }}>
          <Icon name="mic" size={13} />{" "}
          {speech
            ? `Spoken answers are turned into text by ${speech}, and you can correct them before they're sent.`
            : "Spoken answers need Whisper, which comes with the latest Lockin.dmg, or Gemini as your AI. Until then, type."}
        </p>
      )}

      {open.map((v) => (
        <div key={v.id} className="callout blue exam-open">
          <Icon name="mic" size={16} />
          <span>
            <b>{v.title}</b> started {shortDate(v.createdAt)} at {clockTime(v.createdAt)} — question {Math.min(v.current + 1, readPlan(v.plan).length)} of{" "}
            {readPlan(v.plan).length}.
          </span>
          <span className="spacer" />
          <Link href={`/viva/${v.id}`} className="btn sm primary">
            Continue
          </Link>
          <form action={removeViva}>
            <input type="hidden" name="vivaId" value={v.id} />
            <button className="btn sm quiet">Discard</button>
          </form>
        </div>
      ))}

      <VivaSetup tree={tree} course={course} ready={ai} />

      {done.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h2>Past vivas</h2>
          <div className="db-wrap">
            <table className="db exam-table">
              <thead>
                <tr>
                  <th>Viva</th>
                  <th>Questions</th>
                  <th>Mark</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {done.map((v) => {
                  const plan = readPlan(v.plan);
                  const got = plan.map((p) => (p.responseId ? marks.get(p.responseId) : undefined)).filter((m) => m !== undefined);
                  const marked = got.filter((m): m is number => m !== null);
                  const mean = marked.length === got.length && got.length ? marked.reduce((a, b) => a + b, 0) / marked.length : null;
                  return (
                    <tr key={v.id}>
                      <td>
                        <Link href={`/viva/${v.id}`} className="ak-deck-title">
                          <Icon name="mic" size={15} />
                          {v.title}
                        </Link>
                        <div className="small muted">
                          {shortDate(v.createdAt)} · {clockTime(v.createdAt)}
                        </div>
                      </td>
                      <td className="small muted">{plan.length}</td>
                      <td>
                        {mean !== null ? (
                          <Tag tone={scoreTone(mean)}>{formatScore(mean)}/10</Tag>
                        ) : got.length ? (
                          <span className="small muted">Marking…</span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <Link href={`/viva/${v.id}`} className="btn sm">
                          Results
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
