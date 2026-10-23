import Link from "next/link";
import { notFound } from "next/navigation";

import {
  correctText,
  deleteLecture,
  deleteMaterial,
  deleteQuestion,
  logScores,
  prepareLectures,
  saveLaqs,
  saveSummary,
  startAttempt,
  updateLecture,
  uploadMaterial,
  writeMoreLaqs,
} from "@/app/actions";
import { DueTag, ScoreTag, StatusTag, Tag } from "@/app/ui/bits";
import { CopyButton } from "@/app/ui/CopyButton";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon, type IconName } from "@/app/ui/Icon";
import { JobProgress, type JobView } from "@/app/ui/JobProgress";
import { AskButton, type AskHistoryItem } from "@/app/ui/AskButton";
import { LeftOut } from "@/app/ui/LeftOut";
import { ModelInfo, type ModelInfoData } from "@/app/ui/ModelInfo";
import { PasteBox } from "@/app/ui/PasteBox";
import { FeedbackLegend, LaqCard, QuestionScore } from "@/app/ui/render";
import { SummaryView } from "@/app/ui/SummaryView";
import type { GlossaryEntry } from "@/app/study-actions";
import type { AskResult } from "@/lib/ask";
import { prisma } from "@/lib/db";
import { OWN_QUESTIONS } from "@/lib/mixed/schema";
import type { Prisma } from "@/lib/generated/prisma/client";
import { questionBudget } from "@/lib/engines/mastery";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { clockTime, dateInput, formatScore, hours, longDate, plural, scoreTone, shortDate, tagTone } from "@/lib/format";
import { readSteps } from "@/lib/jobs";
import { activeLocalModel } from "@/lib/models";
import { getSettings, readHeartbeat, type Mode } from "@/lib/settings";
import { exportHref } from "@/lib/export";
import type { SlideImages } from "@/lib/markdown";
import { lectureDecks, pictured, sharedDecks, type Deck } from "@/lib/slides";
import { readSkipped, readSlideNotes } from "@/lib/sources";
import { summaryHeadings } from "@/lib/summary-edit";
import { lectureRows, questionNumbers } from "@/lib/views";
import { LAQ_STYLE_LABEL, usesAi } from "@/lib/modes";

export const dynamic = "force-dynamic";

type Tab = "summary" | "laqs" | "scores" | "details";

const LECTURE_INCLUDE = {
  course: { include: { modules: { orderBy: { position: "asc" }, select: { title: true } } } },
  module: { select: { title: true } },
  materials: { orderBy: { createdAt: "asc" } },
  questions: {
    // Past-paper questions are asked only when the paper is sat.
    where: OWN_QUESTIONS,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      concepts: { include: { concept: { select: { name: true } } } },
      _count: { select: { responses: true } },
    },
  },
  attempts: {
    orderBy: { sittingDate: "desc" },
    include: {
      responses: { include: { question: true, gaps: { include: { concept: { select: { name: true } } } } } },
    },
  },
} satisfies Prisma.LectureInclude;

type LecturePageData = Prisma.LectureGetPayload<{ include: typeof LECTURE_INCLUDE }>;

export default async function LecturePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const lecture = await prisma.lecture.findUnique({ where: { id }, include: LECTURE_INCLUDE });
  if (!lecture) notFound();

  const [[row], settings, numbers, job, beat, localReady, decks, deckCopies, lastRun, glossary, asked] = await Promise.all([
    lectureRows({ ids: [id] }),
    getSettings(),
    questionNumbers(id),
    prisma.job.findFirst({
      where: { lectureId: id, kind: { in: ["PREPARE", "GENERATE"] } },
      orderBy: { createdAt: "desc" },
    }),
    readHeartbeat(),
    activeLocalModel(),
    lectureDecks(id),
    sharedDecks(lecture),
    prisma.job.findFirst({
      where: { lectureId: id, kind: { in: ["PREPARE", "GENERATE"] }, status: "DONE" },
      orderBy: { finishedAt: "desc" },
      select: { kind: true, model: true, durationMs: true, finishedAt: true, result: true },
    }),
    prisma.glossaryTerm.findMany({
      where: { lectureId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, term: true, explanation: true },
    }),
    prisma.job.findMany({
      where: { lectureId: id, kind: "ASK", status: "DONE" },
      orderBy: { finishedAt: "desc" },
      take: 30,
      select: { id: true, result: true, finishedAt: true },
    }),
  ]);

  const tab: Tab = (["summary", "laqs", "scores", "details"] as const).find((t) => t === tabParam) ?? "summary";
  const skipped = readSkipped(lecture.skipped);
  const busy = job && (job.status === "PENDING" || job.status === "RUNNING");
  const showJob = job && (busy || (job.status === "FAILED" && lecture.questions.length === 0));
  const budget = questionBudget(lecture.durationHours, settings.sittingPerHour);
  // A deck of pictures has no text but is still something to prepare from.
  const hasMaterial =
    lecture.materials.some((m) => (m.extractedText ?? "").trim()) || decks.some((d) => d.pdf && d.pages > 0);
  const slideImages: SlideImages = { base: `/api/lectures/${lecture.id}/slides`, ranges: pictured(decks) };
  const pdfDecks = decks.filter((d) => d.pdf && d.pages > 0);
  const needsPrep = !lecture.summaryMd || lecture.questions.length === 0;
  const scored = lecture.attempts.filter((a) => a.geometricMean !== null);

  const jobView: JobView | null = showJob
    ? {
        id: job.id,
        kind: job.kind,
        status: job.status,
        stage: job.stage,
        steps: readSteps(job.steps),
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        error: job.error,
        queuePosition: row.queuePosition,
        waitingFor: !beat?.alive ? "worker" : settings.mode === "local" && !localReady ? "model" : null,
        // A server component renders once per request, so this is the time of that render.
        // eslint-disable-next-line react-hooks/purity
        renderedAt: Date.now(),
      }
    : null;

  const modelInfo = describeModels(lecture, lastRun);
  const history = askHistory(asked);

  const tabs: Array<{ key: Tab; label: string; icon: IconName; n?: number }> = [
    { key: "summary", label: "Summary", icon: "book" },
    { key: "laqs", label: "LAQs", icon: "pen", n: lecture.questions.length },
    { key: "scores", label: "Scores", icon: "target", n: lecture.attempts.length },
    { key: "details", label: "Details & files", icon: "file", n: lecture.materials.length },
  ];

  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <Link href={`/?course=${lecture.courseId}`}>{lecture.course.code}</Link>
        {lecture.module && (
          <>
            <span className="sep">/</span>
            <span>{lecture.module.title}</span>
          </>
        )}
      </nav>

      <div className="faint small" style={{ fontFamily: "var(--mono)", marginBottom: 4, display: "flex", alignItems: "center" }}>
        L{row.ordinal}
        <ModelInfo info={modelInfo} />
      </div>
      <h1 className="page-title">{lecture.title}</h1>

      <div className="props">
        <Prop icon="calendar" label="Date">{longDate(lecture.deliveredOn)}</Prop>
        <Prop icon="layers" label="Module">
          {lecture.module ? <Tag tone={tagTone(lecture.module.title)}>{lecture.module.title}</Tag> : <span className="faint">None</span>}
        </Prop>
        <Prop icon="clock" label="Length">
          {hours(lecture.durationHours)} <span className="faint">· {plural(budget, "LAQ")} per sitting</span>
        </Prop>
        <Prop icon="status" label="Status">
          <StatusTag status={row.status} stageLabel={row.stageLabel} queuePosition={row.queuePosition} error={row.error} />
        </Prop>
        <Prop icon="target" label="Drill score">
          <ScoreTag score={row.lastScore} prev={row.prevScore} drillCount={row.drillCount} />
          {scored.length > 0 && (
            <span className="faint">
              · best {formatScore(row.bestScore!)} · {plural(scored.length, "sitting")}
            </span>
          )}
        </Prop>
        <Prop icon="bell" label="Next review">
          <DueTag dueAt={row.dueAt} />
          {!row.dueAt && <span className="faint">{lecture.questions.length ? "" : "once it has LAQs"}</span>}
        </Prop>
        {skipped.length > 0 && (
          <Prop icon="scissors" label="Left out">
            <LeftOut lectureId={lecture.id} items={skipped} canAsk={usesAi(settings.mode)} />
          </Prop>
        )}
      </div>

      {jobView && <JobProgress job={jobView} lectureId={lecture.id} />}

      <div className="row" style={{ marginBottom: 6 }}>
        {lecture.questions.length > 0 && (
          <form action={startAttempt}>
            <input type="hidden" name="lectureId" value={lecture.id} />
            <Submit className="btn primary lg" pending="Picking questions…">
              <Icon name="play" /> {row.sittings > 0 ? "Drill weak areas" : "Start LAQs"}
            </Submit>
          </form>
        )}
        {usesAi(settings.mode) && needsPrep && hasMaterial && !busy && (
          <form action={prepareLectures}>
            <input type="hidden" name="lectureId" value={lecture.id} />
            <Submit className={lecture.questions.length ? "btn lg" : "btn primary lg"} pending="Queueing…">
              <Icon name="sparkles" /> Prepare with AI
            </Submit>
          </form>
        )}
        {lecture.questions.length > 0 && (
          <span className="small muted">
            {plural(budget, "question")}, closed book — your weakest concepts are asked first.
          </span>
        )}
        {lecture.summaryMd && (
          <Link
            href={exportHref({ courseId: lecture.courseId, lectureIds: [lecture.id] })}
            className="btn lg"
            title="Save this summary as a PDF"
            style={{ marginLeft: "auto" }}
          >
            <Icon name="download" /> Export PDF
          </Link>
        )}
      </div>

      <nav className="tabs">
        {tabs.map((t) => (
          <Link key={t.key} href={`/lectures/${lecture.id}?tab=${t.key}`} className={tab === t.key ? "on" : undefined} scroll={false}>
            <Icon name={t.icon} size={15} /> {t.label}
            {t.n ? <span className="n">{t.n}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "summary" && (
        <SummaryTab
          lecture={lecture}
          mode={settings.mode}
          busy={!!busy}
          hasMaterial={hasMaterial}
          sat={scored.length > 0}
          slides={slideImages}
          decks={pdfDecks}
          terms={glossary}
        />
      )}
      {tab === "laqs" && (
        <LaqsTab
          lecture={lecture}
          numbers={numbers}
          mode={settings.mode}
          writes={questionBudget(lecture.durationHours, settings.laqsPerHour)}
          style={LAQ_STYLE_LABEL[settings.laqStyle]}
          busy={!!busy}
          hasMaterial={hasMaterial}
          decks={pdfDecks}
        />
      )}
      {tab === "scores" && <ScoresTab lecture={lecture} numbers={numbers} />}
      {tab === "details" && (
        <DetailsTab lecture={lecture} decks={decks} shared={deckCopies} sittingPerHour={settings.sittingPerHour} />
      )}

      <AskButton
        lectureId={lecture.id}
        mode={settings.mode}
        hasSummary={!!lecture.summaryMd?.trim()}
        headings={summaryHeadings(lecture.summaryMd ?? "")}
        history={history}
        slides={slideImages}
      />
    </main>
  );
}

/** Questions asked about this lecture, newest first, for the Ask panel's history. */
function askHistory(jobs: Array<{ id: string; result: string | null; finishedAt: Date | null }>): AskHistoryItem[] {
  return jobs.flatMap((j) => {
    try {
      const r = JSON.parse(j.result ?? "null") as AskResult | null;
      if (r?.kind !== "question" || !r.question || !r.answer) return [];
      return [
        {
          id: j.id,
          question: r.question,
          answer: r.answer,
          section: r.section,
          at: (j.finishedAt ?? new Date()).toISOString(),
          ...(r.model ? { model: r.model } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Who wrote the summary and the LAQs, and the last AI run, for the ⓘ by the title. */
function describeModels(
  lecture: LecturePageData,
  lastRun: { kind: string; model: string | null; durationMs: number | null; finishedAt: Date | null; result: string | null } | null,
): ModelInfoData {
  const laqs = new Map<string, number>();
  for (const q of lecture.questions) {
    const by = q.model ?? (q.promptVersion === "pasted" ? "Pasted from an AI chat" : "a model Lockin didn't record");
    laqs.set(by, (laqs.get(by) ?? 0) + 1);
  }
  let fellBack: string | null = null;
  try {
    const r = lastRun?.result ? JSON.parse(lastRun.result) : null;
    if (r && typeof r.fellBack === "string") fellBack = r.fellBack;
  } catch {
    // An unreadable result just says nothing about a fallback.
  }
  return {
    summary: lecture.summaryMd ? (lecture.summaryModel ?? "") : null,
    laqs: [...laqs].map(([model, count]) => ({ model, count })),
    lastRun:
      lastRun?.finishedAt
        ? {
            what: lastRun.kind === "PREPARE" ? "Prepared" : "Wrote new LAQs",
            model: lastRun.model,
            durationMs: lastRun.durationMs,
            finishedAt: lastRun.finishedAt.toISOString(),
            fellBack,
          }
        : null,
  };
}

function Prop({ icon, label, children }: { icon: IconName; label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="k">
        <Icon name={icon} size={15} /> {label}
      </div>
      <div className="v">{children}</div>
    </>
  );
}

/** The steps of copy-and-paste mode, shown wherever it is used. */
function HowToPaste({ what, decks }: { what: string; decks: Deck[] }) {
  return (
    <div className="how">
      <div className="s">
        <b>1</b> Copy the prompt — it already contains this lecture&apos;s transcript and slide text.
      </div>
      <div className="s">
        <b>2</b> Paste it into Claude, ChatGPT or any AI chat
        {decks.length > 0 && (
          <>
            , and attach the slides too:{" "}
            {decks.map((d) => (
              <a key={d.materialId} className="btn sm" href={`/api/materials/${d.materialId}`} download>
                <Icon name="download" size={13} /> {d.name}
              </a>
            ))}{" "}
            — then it reads the pictures and diagrams, and can put slides in your summary
          </>
        )}
        .
      </div>
      <div className="s">
        <b>3</b> Copy the {what} it writes and paste it into the box below.
      </div>
    </div>
  );
}

function NoMaterial({ lectureId }: { lectureId: string }) {
  return (
    <div className="callout yellow">
      <span className="callout-icon">
        <Icon name="upload" />
      </span>
      <p>
        This lecture has no transcript or slides yet.{" "}
        <Link href={`/lectures/${lectureId}?tab=details`} className="link">
          Add them
        </Link>{" "}
        first — everything else is made from them.
      </p>
    </div>
  );
}

function SummaryTab({
  lecture,
  mode,
  busy,
  hasMaterial,
  sat,
  slides,
  decks,
  terms,
}: {
  lecture: LecturePageData;
  mode: Mode;
  busy: boolean;
  hasMaterial: boolean;
  sat: boolean;
  slides: SlideImages;
  decks: Deck[];
  terms: GlossaryEntry[];
}) {
  if (lecture.summaryMd) {
    return (
      <>
        {!sat && lecture.questions.length > 0 && (
          <div className="callout">
            <span className="callout-icon">💡</span>
            <p>Read this once, properly. Then come back — ideally tomorrow — and answer the LAQs without it.</p>
          </div>
        )}
        <SummaryView lectureId={lecture.id} md={lecture.summaryMd} slides={slides} mode={mode} terms={terms} />
        <hr className="divider" />
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Replace this summary
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {usesAi(mode) && !busy && (
              <form action={prepareLectures}>
                <input type="hidden" name="lectureId" value={lecture.id} />
                <input type="hidden" name="redo" value="1" />
                <Submit className="btn" pending="Queueing…" confirm="Rewrite this summary with AI? The current one is replaced.">
                  <Icon name="refresh" /> Rewrite it with AI
                </Submit>
              </form>
            )}
            <div className="row">
              <CopyButton url={`/api/lectures/${lecture.id}/prompt?kind=summary`} label="Copy summary prompt" />
            </div>
            <PasteBox kind="summary" action={saveSummary} hidden={{ lectureId: lecture.id }} saveLabel="Replace summary" slides={slides} />
          </div>
        </details>
      </>
    );
  }

  if (!hasMaterial) return <NoMaterial lectureId={lecture.id} />;

  if (usesAi(mode)) {
    return (
      <div className="soft-card">
        <p style={{ marginTop: 0 }}>
          {busy
            ? "The summary is being written — progress is shown above. This page fills in when it's done."
            : "No summary yet. Prepare with AI writes the summary, then the LAQs, for this lecture."}
        </p>
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Or use any AI chat instead
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <HowToPaste what="summary" decks={decks} />
            <div className="row">
              <CopyButton url={`/api/lectures/${lecture.id}/prompt?kind=summary`} label="Copy summary prompt" />
            </div>
            <PasteBox kind="summary" action={saveSummary} hidden={{ lectureId: lecture.id }} saveLabel="Save summary" slides={slides} />
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="stack">
      <HowToPaste what="summary" decks={decks} />
      <div className="row">
        <CopyButton url={`/api/lectures/${lecture.id}/prompt?kind=summary`} label="Copy summary prompt" className="btn primary" />
      </div>
      <PasteBox kind="summary" action={saveSummary} hidden={{ lectureId: lecture.id }} saveLabel="Save summary" slides={slides} />
    </div>
  );
}

function LaqsTab({
  lecture,
  numbers,
  mode,
  writes,
  style,
  busy,
  hasMaterial,
  decks,
}: {
  lecture: LecturePageData;
  numbers: Map<string, number>;
  mode: Mode;
  /** How many one press of Write new LAQs writes. */
  writes: number;
  /** The question style in Settings, as shown. */
  style: string;
  busy: boolean;
  hasMaterial: boolean;
  decks: Deck[];
}) {
  const next = lecture.questions.length + 1;
  const pasteSection = (
    <div className="stack">
      <HowToPaste what="LAQs" decks={decks} />
      <p className="small muted" style={{ margin: 0 }}>
        The prompt asks the chat to mark your answers too, so you can answer there and paste the marking into{" "}
        <Link className="link" href={`/lectures/${lecture.id}?tab=scores`}>
          Scores
        </Link>
        .
      </p>
      <div className="row">
        <CopyButton
          url={`/api/lectures/${lecture.id}/prompt?kind=laqs`}
          label="Copy LAQ prompt"
          className={mode === "manual" ? "btn primary" : "btn"}
        />
      </div>
      <PasteBox kind="laqs" action={saveLaqs} hidden={{ lectureId: lecture.id }} saveLabel="Save LAQs" firstNumber={next} />
    </div>
  );

  return (
    <>
      {lecture.questions.length > 0 ? (
        <div className="laqs">
          {lecture.questions.map((q) => {
            const rubric = readRubric(q.rubric);
            return (
              <LaqCard
                key={q.id}
                laq={{
                  number: numbers.get(q.id) ?? 0,
                  stem: q.stem,
                  marks: rubric.marks,
                  criteria: rubric.criteria,
                  modelAnswer: rubric.modelAnswer,
                }}
                extra={
                  <>
                    {q.concepts.slice(0, 3).map((c) => (
                      <Tag key={c.conceptId}>{c.concept.name}</Tag>
                    ))}
                    {q.promptVersion === "pasted" && <span className="faint">pasted</span>}
                    {q._count.responses > 0 && <span className="faint">answered {plural(q._count.responses, "time")}</span>}
                  </>
                }
                action={
                  <form action={deleteQuestion}>
                    <input type="hidden" name="questionId" value={q.id} />
                    <Submit className="icon-btn" confirm={`Delete LAQ ${numbers.get(q.id)}? Its past marks go with it.`}>
                      <Icon name="trash" size={14} />
                    </Submit>
                  </form>
                }
              />
            );
          })}
        </div>
      ) : !hasMaterial ? (
        <NoMaterial lectureId={lecture.id} />
      ) : (
        usesAi(mode) && (
          <p className="muted">
            {busy ? "LAQs are written right after the summary — progress is shown above." : "No LAQs yet. Prepare with AI writes them."}
          </p>
        )
      )}

      {hasMaterial && usesAi(mode) && lecture.questions.length > 0 && (
        <div className="row" style={{ marginTop: 18 }}>
          <form action={writeMoreLaqs}>
            <input type="hidden" name="lectureId" value={lecture.id} />
            <Submit className="btn" pending="Queueing…" disabled={busy}>
              <Icon name="sparkles" /> Write LAQs for weak areas
            </Submit>
          </form>
          <span className="small muted">
            {writes} more, {style.toLowerCase()} style, aimed at the concepts you have scored worst on or never been asked ·{" "}
            <Link className="link" href="/settings#laqs">
              change
            </Link>
          </span>
        </div>
      )}

      {hasMaterial &&
        (mode === "manual" ? (
          <div style={{ marginTop: 24 }}>{pasteSection}</div>
        ) : (
          <details style={{ marginTop: 22 }}>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Add LAQs from any AI chat
            </summary>
            <div style={{ marginTop: 12 }}>{pasteSection}</div>
          </details>
        ))}
    </>
  );
}

function ScoresTab({ lecture, numbers }: { lecture: LecturePageData; numbers: Map<string, number> }) {
  // What has come back in more than one sitting — the thing paper notes can't tell you.
  const recurring = new Map<string, { name: string; sittings: Set<string>; texts: Set<string> }>();
  for (const a of lecture.attempts) {
    for (const r of a.responses) {
      for (const g of r.gaps) {
        const entry = recurring.get(g.conceptId) ?? { name: g.concept.name, sittings: new Set(), texts: new Set() };
        entry.sittings.add(a.id);
        entry.texts.add(g.text);
        recurring.set(g.conceptId, entry);
      }
    }
  }
  const again = [...recurring.values()].filter((v) => v.sittings.size > 1).sort((a, b) => b.sittings.size - a.sittings.size);

  return (
    <>
      {again.length > 0 && (
        <div className="callout yellow">
          <span className="callout-icon">
            <Icon name="refresh" />
          </span>
          <div>
            <p>
              <strong>Missed again</strong> — these came up in more than one sitting.
            </p>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {again.slice(0, 6).map((v) => (
                <li key={v.name}>
                  <strong>{v.name}</strong> ({v.sittings.size}×): {[...v.texts][0]}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {lecture.attempts.length === 0 ? (
        <p className="muted">
          No sittings yet.{" "}
          {lecture.questions.length > 0 ? "Start LAQs above, or paste marking from an AI chat below." : "Add LAQs first."}
        </p>
      ) : (
        <>
          <FeedbackLegend />
          {lecture.attempts.map((a) => {
            const answered = a.responses.some((r) => r.answerText.trim() || r.mark !== null);
            const marking = answered && a.geometricMean === null;
            return (
              <div key={a.id} className="sitting">
                <div className="sitting-head">
                  {a.geometricMean !== null ? (
                    <span className={`big-score t-${scoreTone(a.geometricMean)}`}>
                      {formatScore(a.geometricMean)}
                      <small>/10</small>
                    </span>
                  ) : (
                    <span className="tag t-blue">{marking ? "Being marked" : "Not finished"}</span>
                  )}
                  <div style={{ flex: 1 }}>
                    <div className="when">
                      {shortDate(a.sittingDate)} · {clockTime(a.sittingDate)}
                    </div>
                    <div className="sub">
                      {a.source === "PASTED"
                        ? "Marked in an AI chat, pasted in"
                        : a.source === "EXAM"
                          ? "Answered in an exam"
                          : "Answered closed book in Lockin"}{" "}
                      ·{" "}
                      {plural(a.responses.length, "LAQ")}
                    </div>
                  </div>
                  {(a.source === "APP" || (a.source === "EXAM" && answered)) && (
                    <Link href={`/attempts/${a.id}`} className="btn sm">
                      {answered ? "Open" : "Continue"}
                    </Link>
                  )}
                </div>
                {answered && (
                  <div className="q-scores">
                    {[...a.responses]
                      .sort((x, y) => (numbers.get(x.questionId) ?? 0) - (numbers.get(y.questionId) ?? 0))
                      .map((r) => {
                        const fb = feedbackFor(r);
                        return (
                          <div key={r.id}>
                            <QuestionScore
                              label={`LAQ ${numbers.get(r.questionId) ?? "?"}`}
                              mark={r.mark}
                              raw={fb.raw ?? undefined}
                              stem={r.question.stem.replace(/\*\*/g, "").slice(0, 160) + (r.question.stem.length > 160 ? "…" : "")}
                              feedback={fb.items}
                              pending={r.mark === null && !!r.answerText.trim()}
                            />
                            {r.mark !== null && (
                              <Link href={`/attempts/${a.id}/notes/${r.id}`} className="btn sm" style={{ margin: "8px 0 14px" }}>
                                {r.notesCopiedAt ? "✓ Notes copied down" : "Notes to copy down →"}
                              </Link>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {lecture.questions.length > 0 && (
        <details style={{ marginTop: 24 }} open={lecture.attempts.length === 0}>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Log scores from an AI chat or paper
          </summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="small muted" style={{ margin: 0 }}>
              Answered this lecture&apos;s LAQs somewhere else? Paste the marking — one line like “LAQ 2: 7/10” per question,
              with Good / Missed / Wrong points under each.
            </p>
            <PasteBox kind="scores" action={logScores} hidden={{ lectureId: lecture.id }} saveLabel="Log these scores" />
          </div>
        </details>
      )}
    </>
  );
}

function DetailsTab({
  lecture,
  decks,
  shared,
  sittingPerHour,
}: {
  lecture: LecturePageData;
  decks: Deck[];
  shared: Map<string, Array<{ id: string; title: string }>>;
  sittingPerHour: number;
}) {
  const notes = readSlideNotes(lecture.slideNotes);
  return (
    <>
      <ActionForm action={updateLecture} className="form">
        <input type="hidden" name="lectureId" value={lecture.id} />
        <label className="field">
          <span>Title</span>
          <input name="title" defaultValue={lecture.title} required />
          {lecture.autoTitle && (
            <span className="hint">A placeholder from the filename — preparing the lecture replaces it unless you edit it.</span>
          )}
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Module</span>
            <input name="module" defaultValue={lecture.module?.title ?? ""} list="modules" placeholder="None" />
            <datalist id="modules">
              {lecture.course.modules.map((m) => (
                <option key={m.title} value={m.title} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Delivered on</span>
            <input name="deliveredOn" type="date" defaultValue={dateInput(lecture.deliveredOn)} />
          </label>
          <label className="field">
            <span>Hours — {sittingPerHour} LAQs per hour in a sitting</span>
            <input name="durationHours" type="number" step="0.5" min="0.5" defaultValue={lecture.durationHours} />
          </label>
        </div>
        <div className="row">
          <Submit pending="Saving…">Save</Submit>
          <FormResult />
        </div>
      </ActionForm>

      <h2>Files</h2>
      {lecture.materials.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="files">
          {lecture.materials.map((m) => {
            const deck = decks.find((d) => d.materialId === m.id);
            const others = shared.get(m.checksum) ?? [];
            return (
            <div key={m.id} className="file">
              <Icon name="file" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <a className="fname link" href={`/api/materials/${m.id}`} download title="Download the original file">
                    {m.originalName}
                  </a>
                  <Tag tone={m.kind === "TRANSCRIPT" ? "blue" : "gray"}>{m.kind.toLowerCase()}</Tag>
                  {others.length > 0 && (
                    <span className="small muted">
                      also in{" "}
                      {others.map((o, i) => (
                        <span key={o.id}>
                          {i > 0 && ", "}
                          <Link className="link" href={`/lectures/${o.id}`}>
                            {o.title}
                          </Link>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="small muted">
                  {deck && deck.pages > 0 && (
                    <>
                      slides {deck.first}–{deck.first + deck.pages - 1}
                      {deck.pdf ? "" : " · no pictures (export it as PDF to show slides in summaries)"} ·{" "}
                    </>
                  )}
                  {(m.extractedText ?? "").length.toLocaleString("en")} characters of text
                </div>
                <details>
                  <summary>Check or correct the text Lockin reads</summary>
                  <ActionForm action={correctText} className="stack" >
                    <input type="hidden" name="materialId" value={m.id} />
                    <textarea name="extractedText" rows={12} defaultValue={m.extractedText ?? ""} style={{ marginTop: 8, fontSize: 13 }} />
                    <div className="row">
                      <Submit className="btn sm" pending="Saving…">
                        Save text
                      </Submit>
                      <FormResult />
                    </div>
                  </ActionForm>
                </details>
              </div>
              <form action={deleteMaterial}>
                <input type="hidden" name="materialId" value={m.id} />
                <Submit className="btn quiet sm" confirm={`Remove ${m.originalName} from this lecture?`}>
                  Remove
                </Submit>
              </form>
            </div>
            );
          })}
        </div>
      )}

      {notes.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            Slide notes — what the AI saw on {plural(notes.length, "slide")}, used when it writes and marks LAQs
          </summary>
          <dl className="slide-notes">
            {notes.map((n) => (
              <div key={n.slide}>
                <dt>Slide {n.slide}</dt>
                <dd>{n.notes}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <h3>Add files</h3>
      <ActionForm action={uploadMaterial} className="form" resetOnSuccess>
        <input type="hidden" name="lectureId" value={lecture.id} />
        <input type="file" name="files" multiple accept=".txt,.md,.vtt,.srt,.pdf,.pptx" />
        <label className="field">
          <span>Or paste transcript text</span>
          <textarea name="transcriptText" rows={4} placeholder="Paste a transcript copied from Echo360, Panopto, Zoom…" />
        </label>
        <div className="row">
          <select name="kind" defaultValue="" aria-label="File type" style={{ width: "auto" }}>
            <option value="">Detect file type</option>
            <option value="TRANSCRIPT">Transcript</option>
            <option value="SLIDES">Slides</option>
          </select>
          <Submit pending="Reading…">Add</Submit>
          <FormResult />
        </div>
      </ActionForm>

      <h2 style={{ color: "var(--danger)" }}>Delete lecture</h2>
      <p className="muted small">Removes its summary, LAQs, sittings and marks. Your original files are not touched.</p>
      <form action={deleteLecture}>
        <input type="hidden" name="lectureId" value={lecture.id} />
        <Submit className="btn danger" confirm={`Delete "${lecture.title}" and everything recorded against it?`}>
          <Icon name="trash" /> Delete this lecture
        </Submit>
      </form>
    </>
  );
}
