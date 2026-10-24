import { prisma } from "@/lib/db";
import type { LlmProvider } from "@/lib/llm/provider";
import { MCQS_PER_LECTURE, shuffleOptions } from "@/lib/mcq/schema";

/** Queues MCQ writing for lectures that have a summary and no MCQs yet. */
export async function queueMcqs(lectureIds: string[]) {
  const lectures = await prisma.lecture.findMany({
    where: { id: { in: lectureIds }, summaryMd: { not: null }, mcqs: { none: {} } },
    select: { id: true },
  });
  const queued: string[] = [];
  for (const { id } of lectures) {
    const existing = await prisma.job.findFirst({ where: { lectureId: id, kind: "MCQS", status: { in: ["PENDING", "RUNNING"] } } });
    if (existing) continue;
    await prisma.job.create({ data: { lectureId: id, kind: "MCQS", payload: JSON.stringify({ lectureId: id }) } });
    queued.push(id);
  }
  return queued;
}

/** Writes a lecture's exam MCQs from its summary. They stay hidden until an exam. */
export async function writeMcqs(lectureId: string, provider: LlmProvider) {
  // A crash after saving but before marking the job DONE is safe to retry.
  if (await prisma.mcq.count({ where: { lectureId } })) return { generated: 0, note: "this lecture already has MCQs" };
  const lecture = await prisma.lecture.findUniqueOrThrow({
    where: { id: lectureId },
    select: { title: true, summaryMd: true, concepts: { where: { mergedIntoId: null }, select: { id: true, name: true, definition: true } } },
  });
  if (!lecture.summaryMd?.trim()) throw new Error("this lecture has no summary yet — prepare it first");

  const { questions } = await provider.generateMcqs({
    lectureTitle: lecture.title,
    summary: lecture.summaryMd,
    concepts: lecture.concepts,
    count: MCQS_PER_LECTURE,
  });

  const known = new Set(lecture.concepts.map((c) => c.id));
  const seen = new Set<string>();
  let generated = 0;
  for (const q of questions.slice(0, MCQS_PER_LECTURE)) {
    const key = q.stem.toLowerCase().replace(/\s+/g, " ");
    // Options a model repeats can't be told apart, so the question is dropped.
    if (seen.has(key) || new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) continue;
    seen.add(key);
    const shuffled = shuffleOptions(q.options, q.answer);
    await prisma.mcq.create({
      data: {
        lectureId,
        stem: q.stem,
        options: JSON.stringify(shuffled.options),
        answer: shuffled.answer,
        explanation: q.explanation,
        conceptId: q.conceptId && known.has(q.conceptId) ? q.conceptId : null,
        promptVersion: provider.lastPromptVersion,
        model: provider.lastModel,
      },
    });
    generated++;
  }
  return { generated };
}

/** A saved MCQ's options; an unreadable row has none and is left out of exams. */
export function readOptions(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) && value.every((o) => typeof o === "string") ? value : [];
  } catch {
    return [];
  }
}
