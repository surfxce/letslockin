"use server";

import { revalidatePath } from "next/cache";

import { setSetting } from "@/lib/settings";

export async function setDailyMinutes(minutes: number) {
  if (!Number.isFinite(minutes)) return;
  await setSetting("dailyMinutes", Math.min(600, Math.max(10, Math.round(minutes))));
  revalidatePath("/", "layout");
}
