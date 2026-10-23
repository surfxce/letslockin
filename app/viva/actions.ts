"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Result } from "@/app/actions";
import { answerViva, deleteViva, endViva, skipVivaQuestion, startViva } from "@/lib/viva/service";

export async function beginViva(_prev: Result, fd: FormData): Promise<Result> {
  let id: string;
  try {
    id = await startViva({
      lectureIds: fd.getAll("lectureId").map(String),
      questions: Number(fd.get("questions") ?? 5),
      focus: fd.get("focus") === "weak" ? "weak" : "mixed",
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/viva");
  redirect(`/viva/${id}`);
}

export async function sayAnswer(vivaId: string, text: string): Promise<{ ok: boolean; message: string }> {
  return answerViva(vivaId, text);
}

export async function skipQuestion(vivaId: string) {
  await skipVivaQuestion(vivaId);
}

export async function stopViva(vivaId: string) {
  await endViva(vivaId);
  revalidatePath("/", "layout");
}

export async function removeViva(fd: FormData) {
  await deleteViva(String(fd.get("vivaId") ?? ""));
  revalidatePath("/viva");
}
