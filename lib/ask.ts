import { prisma } from "@/lib/db";
import type { LlmProvider } from "@/lib/llm/provider";
import { lectureSources, readSkipped } from "@/lib/sources";
import { matchHeading, summaryHeadings } from "@/lib/summary-edit";

/**
 * Quick questions from a lecture page, answered by the worker in a lane of its own
 * while the student waits: a question about the lecture, a passage broken down, or
 * what a left-out part said. Questions and break-downs see only the summary.
 */

export type AskKind = "question" | "breakdown" | "leftout";

export interface AskPayload {
  kind: AskKind;
  lectureId: string;
  /** question */
  question?: string;
  /** breakdown: the text the student selected. */
  selection?: string;
  /** leftout: which part, by its label and place. */
  what?: string;
  where?: string;
}

export interface AskResult {
  kind: AskKind;
  answer: string;
  /** question: the summary heading it belongs under, if one fits. */
  section: string | null;
  question?: string;
  selection?: string;
  what?: string;
  /** leftout: false when the part could not be found, so there is nothing to add. */
  found?: boolean;
  /** Who answered, for display (set by the worker). */
  model?: string;
}

/** The longest question or selection sent — a passage, not a whole summary. */
export const MAX_ASK = 1500;

const NOT_FOUND = /couldn'?t find this part/i;

/** The left-out parts of a lecture whose text is known without asking a model:
 *  aims slides dropped before the summary was written. */
export function knownLeftOut(materials: Parameters<typeof lectureSources>[0], what: string): string | null {
  try {
    return lectureSources(materials).skipped.find((s) => s.what === what && s.about)?.about ?? null;
  } catch {
    return null;
  }
}

/** Saves what a left-out part said onto the lecture, so it is there next time. */
export async function saveLeftOut(lectureId: string, what: string, about: string) {
  const lecture = await prisma.lecture.findUnique({ where: { id: lectureId }, select: { skipped: true } });
  if (!lecture) return;
  const list = readSkipped(lecture.skipped).map((s) => (s.what === what ? { ...s, about } : s));
  await prisma.lecture.update({ where: { id: lectureId }, data: { skipped: JSON.stringify(list) } });
}

export async function runAsk(payload: AskPayload, provider: LlmProvider): Promise<AskResult> {
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: payload.lectureId },
    include: { materials: true },
  });

  if (payload.kind === "leftout") {
    const what = String(payload.what ?? "");
    const known = knownLeftOut(lecture.materials, what);
    if (known) {
      await saveLeftOut(lecture.id, what, known);
      return { kind: "leftout", answer: known, section: null, what, found: true };
    }
    const sources = lectureSources(lecture.materials);
    const { answer } = await provider.ask({
      kind: "leftout",
      lectureTitle: lecture.title,
      what,
      where: String(payload.where ?? ""),
      transcript: sources.transcript,
      slidesText: sources.slidesText,
    });
    const found = !NOT_FOUND.test(answer);
    if (found) await saveLeftOut(lecture.id, what, answer.trim());
    return { kind: "leftout", answer: answer.trim(), section: null, what, found };
  }

  const summary = lecture.summaryMd?.trim();
  if (!summary) throw new Error("this lecture has no summary yet — prepare it first");

  if (payload.kind === "breakdown") {
    const selection = String(payload.selection ?? "").slice(0, MAX_ASK);
    const { answer } = await provider.ask({ kind: "breakdown", lectureTitle: lecture.title, summary, selection });
    return { kind: "breakdown", answer: answer.trim(), section: null, selection };
  }

  const question = String(payload.question ?? "").slice(0, MAX_ASK);
  const headings = summaryHeadings(summary);
  const { answer, section } = await provider.ask({
    kind: "question",
    lectureTitle: lecture.title,
    summary,
    question,
    headings,
  });
  // A heading the summary doesn't have is no place to file the answer.
  return { kind: "question", answer: answer.trim(), section: matchHeading(summary, section), question };
}
