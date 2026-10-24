"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { removePaper, retryPaper, sitPaper } from "@/app/exam/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { Icon } from "@/app/ui/Icon";
import type { PaperRow } from "@/lib/papers/service";

/** Past papers: add one, watch it being read, then sit it like the real thing. */
export function Papers({ papers, courses, ai }: { papers: PaperRow[]; courses: Array<{ id: string; code: string }>; ai: boolean }) {
  const router = useRouter();
  const [course, setCourse] = useState(courses[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/papers?course=${encodeURIComponent(course)}`, {
        method: "POST",
        body: file,
        headers: { "x-file-name": encodeURIComponent(file.name) },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Couldn't add that paper.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="papers" className="exam-papers">
      <h2>Past papers</h2>
      <p className="small muted" style={{ marginTop: -4 }}>
        Add a real past paper and Lockin splits it into questions, matches each to the lecture it tests, and writes a marking guide from that
        lecture. Then sit it, timed, and it&apos;s marked like your LAQs. Its questions stay out of your normal sittings, so the paper stays
        unseen until you sit it.
      </p>
      {ai ? (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {courses.length > 1 && (
            <select value={course} onChange={(e) => setCourse(e.target.value)} aria-label="Course" style={{ width: "auto" }}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
          )}
          <label className={`btn${busy ? " disabled" : ""}`} aria-disabled={busy}>
            <Icon name="upload" size={15} /> {busy ? "Adding…" : "Add a past paper"}
            <input
              type="file"
              hidden
              accept=".pdf,.docx,.txt,.md,application/pdf"
              disabled={busy || !course}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
          <span className="small faint">PDF, Word or text, with selectable text.</span>
          {error && (
            <span className="result err" role="alert">
              {error}
            </span>
          )}
        </div>
      ) : (
        <p className="small muted">Past papers are read and given marking guides by the AI. Choose one in Settings to add them.</p>
      )}

      {papers.length > 0 && (
        <div className="exam-paper-list">
          {papers.map((p) => {
            const working = p.job && (p.job.status === "PENDING" || p.job.status === "RUNNING");
            const failed = p.job?.status === "FAILED";
            const suggested = p.marks ?? Math.max(15, p.questions * 15);
            return (
              <div key={p.id} className="exam-paper">
                <div className="exam-paper-head">
                  <Icon name="file" size={16} />
                  <b>{p.label}</b>
                  <span className="small muted">
                    {p.courseCode}
                    {p.questions ? ` · ${p.questions} question${p.questions === 1 ? "" : "s"}` : ""}
                    {p.marks ? ` · ${p.marks} marks` : ""}
                    {p.sat ? ` · sat ${p.sat}×` : ""}
                  </span>
                  <span className="spacer" />
                  <form action={removePaper}>
                    <input type="hidden" name="paperId" value={p.id} />
                    <Submit className="icon-btn" confirm="Delete this past paper? Answers you've already given stay with their lectures.">
                      <Icon name="trash" size={15} />
                    </Submit>
                  </form>
                </div>
                {working ? (
                  <p className="small muted">
                    <span className="dot pulse" /> {p.job!.status === "RUNNING" ? "Reading it and writing marking guides…" : "Waiting its turn…"}
                  </p>
                ) : failed && !p.questions ? (
                  <div className="row small">
                    <span className="result err">{p.job!.error}</span>
                    <form action={retryPaper}>
                      <input type="hidden" name="paperId" value={p.id} />
                      <Submit className="btn sm">Try again</Submit>
                    </form>
                  </div>
                ) : p.questions ? (
                  <ActionForm action={sitPaper} className="row exam-paper-sit">
                    <input type="hidden" name="paperId" value={p.id} />
                    <label className="row small">
                      <input type="checkbox" name="timed" defaultChecked /> Timed,
                    </label>
                    <input name="minutes" type="number" min={1} max={600} defaultValue={suggested} aria-label="Minutes" style={{ width: 80 }} />
                    <span className="small muted">minutes</span>
                    <Submit className="btn sm primary" pending="Setting it…">
                      <Icon name="play" size={13} /> Sit this paper
                    </Submit>
                    <FormResult />
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
