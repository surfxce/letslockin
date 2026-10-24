"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";

/**
 * "Yes, I've copied this down": the answers whose notes sheet is now in the student's
 * own notes, or (undo) not. Only marked answers have a sheet to copy.
 */
export async function setNotesCopied(responseIds: string[], copied: boolean): Promise<string | null> {
  const ids = responseIds.filter((id) => typeof id === "string" && id.length < 64).slice(0, 200);
  if (!ids.length) return null;
  const at = copied ? new Date() : null;
  await prisma.response.updateMany({ where: { id: { in: ids }, mark: { not: null } }, data: { notesCopiedAt: at } });
  revalidatePath("/", "layout");
  return at ? at.toISOString() : null;
}
