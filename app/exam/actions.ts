"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Result } from "@/app/actions";
import { createExam, deleteExam, saveExamAnswer, submitExam } from "@/lib/exam/service";
import { queueMcqs } from "@/lib/mcq/service";
import { createPaperExam, deletePaper } from "@/lib/papers/service";
import { prisma } from "@/lib/db";
import { usesAi } from "@/lib/modes";
import { getSettings } from "@/lib/settings";

function refreshAll() {
  revalidatePath("/", "layout");
}

export async function startExam(_prev: Result, fd: FormData): Promise<Result> {
  let id: string;
  try {
    const minutes = Number(fd.get("minutes"));
    id = await createExam({
      lectureIds: fd.getAll("lectureId").map(String),
      mcqs: Number(fd.get("mcqs") ?? 0),
      laqs: Number(fd.get("laqs") ?? 0),
      timeLimitMin: fd.get("timed") === "on" && minutes > 0 ? minutes : null,
      focus: fd.get("focus") === "weak" ? "weak" : "mixed",
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  refreshAll();
  redirect(`/exam/${id}`);
}

/** Queues MCQ writing for the chosen lectures that have none yet. */
export async function writeMissingMcqs(lectureIds: string[]): Promise<Result> {
  if (!usesAi((await getSettings()).mode)) return { ok: false, message: "MCQs are written by the AI. Choose one in Settings first." };
  const queued = await queueMcqs(lectureIds.slice(0, 2000));
  refreshAll();
  return queued.length
    ? { ok: true, message: `Writing MCQs for ${queued.length} lecture${queued.length === 1 ? "" : "s"} — they'll be ready for your next exam.` }
    : { ok: false, message: "Nothing to write: those lectures need preparing first, or are already queued." };
}

export async function saveExamChoice(itemId: string, choice: number | null): Promise<{ ok: boolean }> {
  return { ok: await saveExamAnswer(itemId, { choice: choice === null ? null : Math.max(0, Math.min(4, Math.round(choice))) }) };
}

export async function saveExamDraft(itemId: string, text: string): Promise<{ ok: boolean }> {
  return { ok: await saveExamAnswer(itemId, { text }) };
}

export async function handInExam(_prev: Result, fd: FormData): Promise<Result> {
  const examId = String(fd.get("examId") ?? "");
  const choices = new Map<string, number | null>();
  const texts = new Map<string, string>();
  for (const [key, value] of fd.entries()) {
    if (key.startsWith("choice.")) {
      const n = Number(value);
      choices.set(key.slice(7), Number.isInteger(n) && n >= 0 && n <= 4 ? n : null);
    } else if (key.startsWith("answer.")) {
      texts.set(key.slice(7), String(value));
    }
  }
  const result = await submitExam(examId, { choices, texts });
  refreshAll();
  return result;
}

export async function removeExam(fd: FormData) {
  await deleteExam(String(fd.get("examId") ?? ""));
  refreshAll();
  if (fd.get("back") === "1") redirect("/exam");
}

export async function sitPaper(_prev: Result, fd: FormData): Promise<Result> {
  let id: string;
  try {
    const minutes = Number(fd.get("minutes"));
    id = await createPaperExam(String(fd.get("paperId") ?? ""), fd.get("timed") === "on" && minutes > 0 ? minutes : null);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  refreshAll();
  redirect(`/exam/${id}`);
}

export async function removePaper(fd: FormData) {
  await deletePaper(String(fd.get("paperId") ?? ""));
  refreshAll();
}

export async function retryPaper(fd: FormData) {
  const paperId = String(fd.get("paperId") ?? "");
  const busy = await prisma.job.findFirst({ where: { kind: "PAPER", status: { in: ["PENDING", "RUNNING"] }, payload: { contains: paperId } } });
  if (!busy) await prisma.job.create({ data: { kind: "PAPER", payload: JSON.stringify({ paperId }) } });
  refreshAll();
}
