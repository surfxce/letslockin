"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Result } from "@/app/actions";
import { deleteCase, requestCase, startCase } from "@/lib/cases/service";

export async function writeCaseAction(_prev: Result, fd: FormData): Promise<Result> {
  try {
    await requestCase(fd.getAll("lectureId").map(String));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/cases");
  return { ok: true, message: "Writing it — it'll be here in a minute or two." };
}

export async function runCase(fd: FormData) {
  const id = await startCase(String(fd.get("caseId") ?? ""));
  revalidatePath("/cases");
  redirect(`/viva/${id}`);
}

export async function removeCase(fd: FormData) {
  await deleteCase(String(fd.get("caseId") ?? ""));
  revalidatePath("/cases");
}
