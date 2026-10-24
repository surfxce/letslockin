import Link from "next/link";

import { createCourse } from "@/app/actions";
import { ActionForm, FormResult, Submit } from "@/app/ui/forms";

export default function NewCourse() {
  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <span>New course</span>
      </nav>
      <h1 className="page-title">New course</h1>
      <p className="page-sub">Next you will point it at the folder its lecture files are in.</p>
      <ActionForm action={createCourse} className="form">
        <div className="form-grid">
          <label className="field">
            <span>Course code</span>
            <input name="code" placeholder="BIOL3010" required autoFocus autoComplete="off" />
          </label>
          <label className="field" style={{ gridColumn: "span 2" }}>
            <span>Name</span>
            <input name="title" placeholder="Genetics" required autoComplete="off" />
          </label>
        </div>
        <label className="field">
          <span>Exam date</span>
          <input name="examDate" type="date" style={{ maxWidth: 200 }} />
          <span className="hint">Optional. Reviews are pulled in so each lecture gets one before the exam.</span>
        </label>
        <div className="row">
          <Submit pending="Creating…">Create course</Submit>
          <FormResult />
        </div>
      </ActionForm>
    </main>
  );
}
