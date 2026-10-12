import Link from "next/link";
import { redirect } from "next/navigation";

import { createLecture } from "@/app/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";
import { prisma } from "@/lib/db";
import { dateInput } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function NewLecture({ searchParams }: { searchParams: Promise<{ course?: string }> }) {
  const { course: courseId } = await searchParams;
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "asc" },
    include: { modules: { orderBy: { position: "asc" }, select: { title: true } } },
  });
  if (courses.length === 0) redirect("/courses/new");
  const course = courses.find((c) => c.id === courseId) ?? courses[0];
  const { mode } = await getSettings();

  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <Link href={`/?course=${course.id}`}>{course.code}</Link>
        <span className="sep">/</span>
        <span>New lecture</span>
      </nav>
      <h1 className="page-title">New lecture</h1>
      <p className="page-sub">
        Drop in its transcript and slides, or paste the transcript text. Leave the title blank and one is written from
        what the lecture covers.
      </p>

      <ActionForm action={createLecture} className="form">
        <label className="field">
          <span>Files</span>
          <input type="file" name="files" multiple accept=".txt,.md,.vtt,.srt,.pdf,.pptx" />
          <span className="hint">Transcripts (.vtt .srt .txt) and slides (.pdf .pptx). Several at once is fine.</span>
        </label>
        <label className="field">
          <span>Or paste the transcript</span>
          <textarea name="transcriptText" rows={6} placeholder="Copied from Echo360, Panopto, Zoom, Teams…" />
        </label>
        <label className="field">
          <span>Title</span>
          <input name="title" placeholder="Optional — written for you from the content" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Course</span>
            <select name="courseId" defaultValue={course.id}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Module</span>
            <input name="module" list="modules" placeholder="None" />
            <datalist id="modules">
              {course.modules.map((m) => (
                <option key={m.title} value={m.title} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Delivered on</span>
            <input name="deliveredOn" type="date" defaultValue={dateInput(new Date())} />
          </label>
          <label className="field">
            <span>Hours</span>
            <input name="durationHours" type="number" step="0.5" min="0.5" defaultValue="1" />
          </label>
        </div>
        {mode === "auto" && (
          <label className="check">
            <input type="checkbox" name="prepare" defaultChecked />
            <span>Prepare it with AI straight away — summary, then LAQs</span>
          </label>
        )}
        <div className="row">
          <Submit pending="Adding…">Add lecture</Submit>
          <FormResult />
        </div>
      </ActionForm>
    </main>
  );
}
