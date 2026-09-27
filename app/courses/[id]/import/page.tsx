import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoRefresh } from "@/app/AutoRefresh";
import { FolderPicker } from "@/app/FolderPicker";
import { confirmImport, startImport } from "@/app/actions";
import { prisma } from "@/lib/db";
import type { LectureIdentification } from "@/lib/llm/schemas";

export const dynamic = "force-dynamic";

interface Proposal {
  root: string;
  files: Array<{
    relativePath: string;
    filename: string;
    kindGuess: string;
    measuredHours: number | null;
    warnings: string[];
    checksum: string;
  }>;
  skipped: Array<{ path: string; why: string }>;
  identification: LectureIdentification;
}

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const course = await prisma.course.findUnique({
    where: { id },
    include: { modules: { orderBy: { position: "asc" } } },
  });
  if (!course) notFound();

  const job = await prisma.job.findFirst({
    where: { kind: "IDENTIFY", payload: { contains: course.id } },
    orderBy: { createdAt: "desc" },
  });
  // Scanning the same folder twice must not silently double every lecture.
  const alreadyImported = new Set(
    (
      await prisma.material.findMany({
        where: { lecture: { courseId: course.id } },
        select: { checksum: true },
      })
    ).map((m) => m.checksum),
  );
  const busy = job?.status === "PENDING" || job?.status === "RUNNING";
  const proposal: Proposal | null =
    job?.status === "DONE" && job.result ? (JSON.parse(job.result) as Proposal) : null;

  return (
    <>
      <AutoRefresh active={busy} />
      <p className="crumb">
        <Link href="/">Courses</Link> /{" "}
        <Link href={`/courses/${course.id}`}>{course.code}</Link> / import
      </p>
      <h1>Point it at a folder</h1>
      <p className="sub">
        Give it the folder your lecture files are already sitting in, however messy. It
        reads everything it recognises, works out which files belong to the same lecture,
        and proposes a title and module for each. Nothing is written until you confirm.
      </p>

      <form className="stack" action={startImport}>
        <input type="hidden" name="courseId" value={course.id} />
        <FolderPicker defaultValue={proposal?.root ?? ""} />
        <button type="submit" disabled={busy}>
          {busy ? "Reading…" : proposal ? "Scan again" : "Scan folder"}
        </button>
      </form>

      {busy && (
        <div className="note" style={{ marginTop: 20 }}>
          <p>
            Reading and grouping the folder. Parsing happens locally; only short excerpts
            are sent for grouping. This page updates itself.
          </p>
        </div>
      )}

      {job?.status === "FAILED" && (
        <div className="warn" style={{ marginTop: 20 }}>
          <p>{job.error}</p>
        </div>
      )}

      {proposal && (
        <Review course={course} job={job!} proposal={proposal} alreadyImported={alreadyImported} />
      )}
    </>
  );
}

function Review({
  course,
  job,
  proposal,
  alreadyImported,
}: {
  course: { id: string; modules: Array<{ id: string; title: string }> };
  job: { id: string };
  proposal: Proposal;
  alreadyImported: Set<string>;
}) {
  const { identification, files, skipped } = proposal;

  return (
    <form action={confirmImport}>
      <input type="hidden" name="courseId" value={course.id} />
      <input type="hidden" name="root" value={proposal.root} />
      <input type="hidden" name="jobId" value={job.id} />

      <h2>
        {identification.lectures.length} lecture
        {identification.lectures.length === 1 ? "" : "s"} found in {files.length} files
      </h2>
      <p className="sub">
        Everything below is editable. Untick anything you do not want, fix any title that
        is wrong, then import.
      </p>

      <div className="rows">
        {identification.lectures.map((lec, i) => {
          const lecFiles = lec.fileIndexes.map((n) => files[n]).filter(Boolean);
          const seen = lecFiles.length > 0 && lecFiles.every((f) => alreadyImported.has(f.checksum));
          const measured = lecFiles.find((f) => f.measuredHours)?.measuredHours ?? null;
          const moduleValue = lec.existingModuleId
            ? lec.existingModuleId
            : lec.newModuleTitle
              ? `new:${lec.newModuleTitle}`
              : "";
          return (
            <div key={i} className="row" style={{ alignItems: "flex-start", display: "block" }}>
              <label
                style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}
              >
                <input
                  type="checkbox"
                  name="include"
                  value={String(i)}
                  defaultChecked={!seen}
                />
                <input
                  name={`title.${i}`}
                  defaultValue={lec.title}
                  style={{ flex: 1, fontWeight: 500 }}
                />
                {seen && <span className="chip">already imported</span>}
                {lec.confidence === "low" && <span className="chip fail">unsure</span>}
              </label>

              {lec.note && (
                <p className="meta" style={{ margin: "0 0 10px", color: "var(--weak)" }}>
                  {lec.note}
                </p>
              )}

              <div className="inline" style={{ marginBottom: 10 }}>
                <label className="field">
                  <span>Module</span>
                  <select name={`module.${i}`} defaultValue={moduleValue}>
                    <option value="">No module</option>
                    {course.modules.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                    {lec.newModuleTitle && (
                      <option value={`new:${lec.newModuleTitle}`}>
                        {lec.newModuleTitle} (new)
                      </option>
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>Delivered</span>
                  <input type="date" name={`date.${i}`} defaultValue={lec.deliveredOn ?? ""} />
                </label>
                <label className="field">
                  <span>Hours{measured ? " — from the transcript" : ""}</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    name={`hours.${i}`}
                    defaultValue={measured ?? lec.durationHours}
                  />
                </label>
              </div>

              {lecFiles.map((f) => (
                <input key={f.relativePath} type="hidden" name={`paths.${i}`} value={f.relativePath} />
              ))}
              <div className="meta">
                {lecFiles.map((f) => (
                  <div key={f.relativePath}>
                    <span className="chip">{f.kindGuess}</span> {f.relativePath}
                    {f.warnings.map((w) => (
                      <div key={w} style={{ color: "var(--weak)" }}>
                        ! {w}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <label style={{ display: "flex", gap: 10, alignItems: "center", margin: "18px 0" }}>
        <input type="checkbox" name="summarise" defaultChecked />
        <span>Summarise and extract concepts for each one straight after importing</span>
      </label>
      <button type="submit">Import {identification.lectures.length} lectures</button>

      {identification.pastPapers.length > 0 && (
        <>
          <h2>Past papers spotted ({identification.pastPapers.length})</h2>
          <p className="sub">
            Left where they are for now — yield scoring reads these, and that lands in a
            later phase.
          </p>
          <div className="rows">
            {identification.pastPapers.map((p, i) => (
              <div key={i} className="row">
                <span className="meta">
                  {p.fileIndexes.map((n) => files[n]?.relativePath).join(", ")}
                </span>
                <span className="num">{p.year ?? "year unknown"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {(identification.ignored.length > 0 || skipped.length > 0) && (
        <>
          <h2>Left out</h2>
          <div className="rows">
            {identification.ignored.map((ig, i) => (
              <div key={`i${i}`} className="row">
                <span className="meta">{files[ig.fileIndex]?.relativePath ?? "?"}</span>
                <span className="num">{ig.why}</span>
              </div>
            ))}
            {skipped.map((s, i) => (
              <div key={`s${i}`} className="row">
                <span className="meta">{s.path}</span>
                <span className="num">{s.why}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </form>
  );
}
