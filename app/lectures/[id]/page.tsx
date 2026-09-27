import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoRefresh } from "@/app/AutoRefresh";
import {
  correctText,
  deleteLecture,
  deleteMaterial,
  runJob,
  startAttempt,
  updateLecture,
  uploadMaterial,
} from "@/app/actions";
import { prisma } from "@/lib/db";
import { roundMark } from "@/lib/engines/geomean";
import { questionBudget } from "@/lib/engines/mastery";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function LecturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lecture = await prisma.lecture.findUnique({
    where: { id },
    include: {
      course: { include: { modules: { orderBy: { position: "asc" } } } },
      materials: { orderBy: { createdAt: "asc" } },
      concepts: { where: { mergedIntoId: null }, orderBy: { createdAt: "asc" } },
      attempts: { orderBy: { sittingDate: "desc" }, include: { _count: { select: { responses: true } } } },
      _count: { select: { questions: true } },
    },
  });
  if (!lecture) notFound();

  const budget = questionBudget(lecture.durationHours);
  const enoughQuestions = lecture._count.questions >= budget;

  // What has come back more than once across separate sittings — the thing the
  // paper binder can never tell you on its own.
  const gaps = await prisma.gap.findMany({
    where: { response: { attempt: { lectureId: lecture.id } } },
    include: { concept: true, response: { select: { attemptId: true } } },
  });
  const recurring = [...
    gaps.reduce((acc, g) => {
      const entry = acc.get(g.conceptId) ?? { name: g.concept.name, attempts: new Set<string>(), texts: [] as string[] };
      entry.attempts.add(g.response.attemptId);
      if (!entry.texts.includes(g.text)) entry.texts.push(g.text);
      acc.set(g.conceptId, entry);
      return acc;
    }, new Map<string, { name: string; attempts: Set<string>; texts: string[] }>())
  ]
    .filter(([, v]) => v.attempts.size > 1)
    .sort((a, b) => b[1].attempts.size - a[1].attempts.size);

  const jobs = await prisma.job.findMany({
    where: { payload: { contains: lecture.id } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const busy = jobs.some((j) => j.status === "PENDING" || j.status === "RUNNING");
  const hasTranscript = lecture.materials.some(
    (m) => m.kind === "TRANSCRIPT" && (m.extractedText ?? "").trim().length > 0,
  );

  return (
    <>
      <AutoRefresh active={busy} />
      <p className="crumb">
        <Link href="/">Courses</Link> /{" "}
        <Link href={`/courses/${lecture.courseId}`}>{lecture.course.code}</Link> / lecture
      </p>
      <h1>{lecture.title}</h1>
      <p className="sub">
        {DAYS[lecture.deliveredOn.getDay()]}, {lecture.deliveredOn.toLocaleDateString()} ·{" "}
        {lecture.durationHours}h · {Math.round(lecture.durationHours * 2)} questions per attempt
      </p>

      <h2>Material</h2>
      {lecture.materials.length === 0 ? (
        <p className="empty">
          Nothing uploaded. Drop in the transcript and the slides — they are parsed to text
          once, here, and every later step reads that text rather than re-parsing the file.
        </p>
      ) : (
        <div className="rows">
          {lecture.materials.map((m) => (
            <div key={m.id} className="row" style={{ alignItems: "flex-start" }}>
              <span style={{ minWidth: 0 }}>
                <span className="name">{m.originalName}</span>{" "}
                <span className="chip">{m.kind}</span>
                <br />
                <span className="meta">
                  {(m.extractedText ?? "").length.toLocaleString()} characters extracted
                </span>
                <details style={{ marginTop: 8 }}>
                  <summary className="meta" style={{ cursor: "pointer" }}>
                    Check and correct the extracted text
                  </summary>
                  <form action={correctText} className="stack" style={{ marginTop: 8, maxWidth: "100%" }}>
                    <input type="hidden" name="materialId" value={m.id} />
                    <textarea name="extractedText" rows={14} defaultValue={m.extractedText ?? ""} />
                    <button type="submit" className="ghost">Save corrections</button>
                  </form>
                </details>
              </span>
              <form action={deleteMaterial}>
                <input type="hidden" name="materialId" value={m.id} />
                <button className="ghost" type="submit">Remove</button>
              </form>
            </div>
          ))}
        </div>
      )}

      <form className="stack" action={uploadMaterial} style={{ marginTop: 16 }}>
        <input type="hidden" name="lectureId" value={lecture.id} />
        <label className="field">
          <span>Transcript (.txt .vtt .srt) and slides (.pdf .pptx)</span>
          <input type="file" name="files" multiple required
            accept=".txt,.md,.vtt,.srt,.pdf,.pptx" />
        </label>
        <label className="field">
          <span>Kind — leave on auto unless it guesses wrong</span>
          <select name="kind" defaultValue="">
            <option value="">Auto-detect</option>
            <option value="TRANSCRIPT">Transcript</option>
            <option value="SLIDES">Slides</option>
            <option value="FIGURE">Figure</option>
          </select>
        </label>
        <button type="submit">Upload</button>
      </form>

      <h2>Pipeline</h2>
      {!hasTranscript && (
        <div className="warn">
          <p>Upload a transcript first — both steps below read it.</p>
        </div>
      )}
      <div className="inline" style={{ marginBottom: 14 }}>
        <form action={runJob}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <input type="hidden" name="kind" value="SUMMARISE" />
          <button type="submit" disabled={!hasTranscript}>Summarise</button>
        </form>
        <form action={runJob}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <input type="hidden" name="kind" value="EXTRACT_CONCEPTS" />
          <button type="submit" className="ghost" disabled={!hasTranscript}>
            Extract concepts
          </button>
        </form>
        <form action={runJob}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <input type="hidden" name="kind" value="GENERATE" />
          <button type="submit" className="ghost" disabled={lecture.concepts.length === 0}>
            Generate questions
          </button>
        </form>
      </div>

      {jobs.length === 0 ? (
        <p className="empty">Queued work shows up here. The worker must be running: <code>npm run worker</code></p>
      ) : (
        <div className="rows">
          {jobs.map((j) => (
            <div key={j.id} className="row">
              <span>
                <span className="name">{j.kind}</span>{" "}
                <span
                  className={`chip ${j.status === "FAILED" ? "fail" : j.status === "DONE" ? "" : "run"}`}
                >
                  {j.status}
                </span>
                {j.error && (
                  <>
                    <br />
                    <span className="meta" style={{ color: "var(--weak)" }}>{j.error}</span>
                  </>
                )}
              </span>
              <span className="num">
                {j.durationMs ? `${(j.durationMs / 1000).toFixed(1)}s` : "—"}
                {j.attempts > 1 && ` · attempt ${j.attempts}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <h2>Attempts</h2>
      <p className="sub" style={{ marginBottom: 12 }}>
        {budget} question{budget === 1 ? "" : "s"} a sitting, two per lecture hour. Which ones
        you get depends on your scores: a concept you have never been asked about outranks one
        you have twice nailed, and anything at 10/10 drops out of the pool.
      </p>

      <div className="inline" style={{ marginBottom: 14 }}>
        <form action={startAttempt}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <button type="submit" disabled={!enoughQuestions}>
            Start an attempt
          </button>
        </form>
        <span className="meta">
          {lecture._count.questions} question{lecture._count.questions === 1 ? "" : "s"} in the
          bank{!enoughQuestions && " — generate some first"}
        </span>
      </div>

      {lecture.attempts.length === 0 ? (
        <p className="empty">
          Nothing attempted yet. Read the summary once, then come back and answer without it.
        </p>
      ) : (
        <div className="rows">
          {lecture.attempts.map((a) => (
            <Link key={a.id} className="row" href={`/attempts/${a.id}`}>
              <span>
                <span className="name">{a.sittingDate.toLocaleDateString()}</span>
                <br />
                <span className="meta">
                  {a._count.responses} question{a._count.responses === 1 ? "" : "s"}
                  {a.completedAt ? "" : " · not finished"}
                </span>
              </span>
              <span
                className={`gm ${a.geometricMean === null ? "" : a.geometricMean < 5 ? "low" : "high"}`}
                style={{ fontSize: 17 }}
              >
                {a.geometricMean === null ? "—" : roundMark(a.geometricMean, 2)}
              </span>
            </Link>
          ))}
        </div>
      )}

      {recurring.length > 0 && (
        <>
          <h2>Missed again</h2>
          <p className="sub" style={{ marginBottom: 12 }}>
            These came back in more than one sitting. Highlight them.
          </p>
          <div className="concepts">
            {recurring.map(([conceptId, v]) => (
              <div key={conceptId} className="concept">
                <div className="cname">
                  {v.name} <span className="chip fail">{v.attempts.size}×</span>
                </div>
                {v.texts.map((t) => (
                  <div key={t} className="cdef">{t}</div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      <details className="section" open={lecture.concepts.length > 0 && lecture.concepts.length <= 12}>
        <summary>
          <h2 style={{ margin: 0 }}>
            Concepts {lecture.concepts.length > 0 && `(${lecture.concepts.length})`}
          </h2>
        </summary>
      {lecture.concepts.length === 0 ? (
          <p className="empty">
            None yet. These are the unit everything is scored against, so they come before
            questions.
          </p>
        ) : (
          <div className="concepts" style={{ marginTop: 10 }}>
            {lecture.concepts.map((c) => (
              <div key={c.id} className="concept">
                <div className="cname">{c.name}</div>
                <div className="cdef">{c.definition}</div>
                {c.sourceRef && <div className="cref">{c.sourceRef}</div>}
              </div>
            ))}
          </div>
        )}
      </details>

      <details className="section" style={{ marginTop: 30 }}>
        <summary>
          <h2 style={{ margin: 0 }}>Settings</h2>
        </summary>
        <form className="stack" action={updateLecture} style={{ marginTop: 12 }}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <label className="field">
            <span>Title</span>
            <input name="title" defaultValue={lecture.title} required />
          </label>
          <div className="inline">
            <label className="field">
              <span>Module</span>
              <select name="moduleId" defaultValue={lecture.moduleId ?? ""}>
                <option value="">No module</option>
                {lecture.course.modules.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Delivered on</span>
              <input
                name="deliveredOn"
                type="date"
                defaultValue={lecture.deliveredOn.toISOString().slice(0, 10)}
              />
            </label>
            <label className="field">
              <span>Hours</span>
              <input
                name="durationHours"
                type="number"
                step="0.5"
                min="0.5"
                defaultValue={lecture.durationHours}
              />
            </label>
          </div>
          <button type="submit">Save</button>
        </form>
        <form action={deleteLecture} style={{ marginTop: 18 }}>
          <input type="hidden" name="lectureId" value={lecture.id} />
          <button type="submit" className="danger">
            Delete this lecture and its {lecture.materials.length} file
            {lecture.materials.length === 1 ? "" : "s"}
          </button>
        </form>
      </details>

      <h2>Summary</h2>
      {lecture.summaryMd ? (
        <div className="panel scroll">
          <div
            className="summary"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(lecture.summaryMd) }}
          />
        </div>
      ) : (
        <p className="empty">
          Not summarised yet. Read it once, then answer questions on it without looking —
          the summary is hidden during an attempt.
        </p>
      )}
    </>
  );
}
