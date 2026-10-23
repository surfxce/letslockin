import Link from "next/link";
import { notFound } from "next/navigation";

import { NotesSheet } from "@/app/attempts/[id]/NotesSheet";
import { prisma } from "@/lib/db";
import { feedbackFor, readRubric } from "@/lib/feedback";
import { shortDate } from "@/lib/format";
import { buildNotesSheet, notesFileName } from "@/lib/notes-sheet";
import { questionNumbers } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function LaqNotesPage({
  params,
}: {
  params: Promise<{ id: string; responseId: string }>;
}) {
  const { id, responseId } = await params;
  const response = await prisma.response.findFirst({
    where: { id: responseId, attemptId: id, mark: { not: null } },
    include: {
      attempt: { include: { lecture: true } },
      question: true,
      gaps: { include: { concept: { select: { name: true } } } },
    },
  });
  if (!response) notFound();

  const number = (await questionNumbers(response.attempt.lectureId)).get(response.questionId) ?? 0;
  const rubric = readRubric(response.question.rubric);
  const sheet = buildNotesSheet({
    lectureTitle: response.attempt.lecture.title,
    sittingDate: response.attempt.sittingDate,
    responses: [{
      number,
      stem: response.question.stem,
      mark: response.mark,
      items: feedbackFor(response).items,
      gaps: response.gaps.map((g) => ({ type: g.type, text: g.text, concept: g.concept.name })),
      blank: !response.answerText.trim(),
      guide: rubric.criteria.map((c) => c.point),
    }],
  });

  return (
    <main className="page narrow">
      <nav className="crumbs">
        <Link href="/">Lectures</Link>
        <span className="sep">/</span>
        <Link href={`/lectures/${response.attempt.lectureId}?tab=scores`}>{response.attempt.lecture.title}</Link>
        <span className="sep">/</span>
        <Link href={`/attempts/${id}`}>{shortDate(response.attempt.sittingDate)}</Link>
      </nav>
      <h1 className="page-title">LAQ {number} notes</h1>
      <p className="page-sub">What was wrong, partly right, and missed. Copy it straight into your notes.</p>
      <NotesSheet
        sheet={sheet}
        fileName={notesFileName(`${response.attempt.lecture.title} LAQ ${number}`, response.attempt.sittingDate)}
        copy={{ responseIds: [response.id], at: response.notesCopiedAt?.toISOString() ?? null }}
      />
      {sheet.markdown && (
        <section style={{ marginTop: 22 }}>
          <h2 className="section-title">Markdown</h2>
          <pre className="model-answer" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
            {sheet.markdown}
          </pre>
        </section>
      )}
      <p style={{ marginTop: 24 }}>
        <Link href={`/attempts/${id}`} className="link">Back to sitting</Link>
      </p>
    </main>
  );
}
