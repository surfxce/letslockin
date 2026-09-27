"use server";

import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { pickQuestions } from "@/lib/engines/attempt";
import { materialsDir } from "@/lib/paths";
import { enqueue, ingestFile } from "@/lib/materials";
import type { MaterialKind } from "@/lib/types";

export async function createCourse(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const examDateRaw = String(formData.get("examDate") ?? "").trim();
  if (!code || !title) throw new Error("course code and title are both required");

  const course = await prisma.course.create({
    data: { code, title, examDate: examDateRaw ? new Date(examDateRaw) : null },
  });
  redirect(`/courses/${course.id}`);
}

export async function createLecture(formData: FormData) {
  const courseId = String(formData.get("courseId"));
  const title = String(formData.get("title") ?? "").trim();
  const deliveredOn = String(formData.get("deliveredOn") ?? "").trim();
  const durationHours = Number(formData.get("durationHours") ?? 1);
  if (!title) throw new Error("lecture title is required");

  const lecture = await prisma.lecture.create({
    data: {
      courseId,
      title,
      deliveredOn: deliveredOn ? new Date(deliveredOn) : new Date(),
      durationHours: Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 1,
    },
  });
  redirect(`/lectures/${lecture.id}`);
}

export async function uploadMaterial(formData: FormData) {
  const lectureId = String(formData.get("lectureId"));
  const kind = String(formData.get("kind") || "") as MaterialKind | "";
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) throw new Error("choose at least one file");

  for (const file of files) {
    await ingestFile({ file, lectureId, kind: kind || undefined });
  }
  revalidatePath(`/lectures/${lectureId}`);
}

export async function correctText(formData: FormData) {
  const materialId = String(formData.get("materialId"));
  const extractedText = String(formData.get("extractedText") ?? "");
  const material = await prisma.material.update({
    where: { id: materialId },
    data: { extractedText },
  });
  revalidatePath(`/lectures/${material.lectureId}`);
}

export async function deleteMaterial(formData: FormData) {
  const materialId = String(formData.get("materialId"));
  const material = await prisma.material.delete({ where: { id: materialId } });
  revalidatePath(`/lectures/${material.lectureId}`);
}

/** Queues work for the worker rather than blocking the request on a model call. */
export async function runJob(formData: FormData) {
  const lectureId = String(formData.get("lectureId"));
  const kind = String(formData.get("kind"));
  await enqueue(kind, { lectureId });
  revalidatePath(`/lectures/${lectureId}`);
}

export async function createModule(formData: FormData) {
  const courseId = String(formData.get("courseId"));
  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("module title is required");
  const count = await prisma.module.count({ where: { courseId } });
  await prisma.module.create({ data: { courseId, title, position: count } });
  revalidatePath(`/courses/${courseId}`);
}

export async function startImport(formData: FormData) {
  const courseId = String(formData.get("courseId"));
  const root = String(formData.get("root") ?? "").trim();
  if (!root) throw new Error("give the folder a path");
  await enqueue("IDENTIFY", { courseId, root: root.replace(/^~/, process.env.HOME ?? "~") });
  revalidatePath(`/courses/${courseId}/import`);
}

/**
 * Applies the reviewed proposal. Everything here comes from the form the user just
 * edited, not from the model's output — the proposal is a suggestion that the review
 * screen turns into a decision.
 */
export async function confirmImport(formData: FormData) {
  const courseId = String(formData.get("courseId"));
  const root = String(formData.get("root"));
  const jobId = String(formData.get("jobId"));
  const summarise = formData.get("summarise") === "on";

  const indexes = formData
    .getAll("include")
    .map((v) => String(v))
    .filter(Boolean);

  const moduleCache = new Map<string, string>();
  async function moduleIdFor(raw: string): Promise<string | null> {
    if (!raw) return null;
    if (!raw.startsWith("new:")) return raw;
    const title = raw.slice(4).trim();
    if (!title) return null;
    const cached = moduleCache.get(title);
    if (cached) return cached;
    const position = await prisma.module.count({ where: { courseId } });
    const mod = await prisma.module.upsert({
      where: { courseId_title: { courseId, title } },
      update: {},
      create: { courseId, title, position },
    });
    moduleCache.set(title, mod.id);
    return mod.id;
  }

  // Check every file is still where the scan found it before writing anything —
  // a file moved between scanning and confirming should not leave half an import.
  const planned = indexes.map((i) => ({
    i,
    title: String(formData.get(`title.${i}`) ?? "").trim(),
    paths: formData.getAll(`paths.${i}`).map((v) => String(v).trim()).filter(Boolean),
  }));
  const missing: string[] = [];
  for (const { paths } of planned) {
    for (const rel of paths) {
      await access(path.join(root, rel)).catch(() => missing.push(rel));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `these files are no longer at ${root}: ${missing.join(", ")}. Scan the folder again.`,
    );
  }

  let created = 0;
  for (const { i, title, paths } of planned) {
    if (!title) continue;
    const deliveredOn = String(formData.get(`date.${i}`) ?? "").trim();
    const durationHours = Number(formData.get(`hours.${i}`) ?? 1);

    const lecture = await prisma.lecture.create({
      data: {
        courseId,
        moduleId: await moduleIdFor(String(formData.get(`module.${i}`) ?? "")),
        title,
        deliveredOn: deliveredOn ? new Date(deliveredOn) : new Date(),
        durationHours: Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 1,
      },
    });

    try {
      for (const rel of paths) {
        const abs = path.join(root, rel);
        const buffer = await readFile(abs);
        const file = new File([new Uint8Array(buffer)], path.basename(abs));
        await ingestFile({ file, lectureId: lecture.id });
      }
    } catch (err) {
      // A lecture with no material is worse than no lecture at all — it looks
      // importable and every pipeline step on it fails.
      await prisma.lecture.delete({ where: { id: lecture.id } }).catch(() => undefined);
      throw err;
    }
    if (summarise) {
      await enqueue("SUMMARISE", { lectureId: lecture.id });
      await enqueue("EXTRACT_CONCEPTS", { lectureId: lecture.id });
    }
    created++;
  }

  // Keeps a finished import off the review screen next time it is opened.
  await prisma.job.update({ where: { id: jobId }, data: { status: "DONE", error: null } })
    .catch(() => undefined);

  revalidatePath(`/courses/${courseId}`);
  redirect(`/courses/${courseId}?imported=${created}`);
}

export async function updateCourse(formData: FormData) {
  const id = String(formData.get("courseId"));
  const code = String(formData.get("code") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const examDate = String(formData.get("examDate") ?? "").trim();
  if (!code || !title) throw new Error("course code and title are both required");
  await prisma.course.update({
    where: { id },
    data: { code, title, examDate: examDate ? new Date(examDate) : null },
  });
  revalidatePath(`/courses/${id}`);
  redirect(`/courses/${id}/settings?saved=1`);
}

export async function deleteCourse(formData: FormData) {
  const id = String(formData.get("courseId"));
  const confirmation = String(formData.get("confirm") ?? "").trim();
  const course = await prisma.course.findUniqueOrThrow({ where: { id } });
  if (confirmation !== course.code) {
    throw new Error(`type ${course.code} to confirm — this deletes every lecture, attempt and mark on it`);
  }
  const lectures = await prisma.lecture.findMany({ where: { courseId: id }, select: { id: true } });
  await prisma.course.delete({ where: { id } });
  // Cascades clear the rows; the uploaded files have to go too.
  for (const l of lectures) {
    await rm(path.join(materialsDir(), l.id), { recursive: true, force: true });
  }
  revalidatePath("/");
  redirect("/");
}

export async function updateLecture(formData: FormData) {
  const id = String(formData.get("lectureId"));
  const title = String(formData.get("title") ?? "").trim();
  const moduleId = String(formData.get("moduleId") ?? "");
  const deliveredOn = String(formData.get("deliveredOn") ?? "").trim();
  const durationHours = Number(formData.get("durationHours") ?? 1);
  if (!title) throw new Error("lecture title is required");
  await prisma.lecture.update({
    where: { id },
    data: {
      title,
      moduleId: moduleId || null,
      ...(deliveredOn ? { deliveredOn: new Date(deliveredOn) } : {}),
      durationHours: Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 1,
    },
  });
  revalidatePath(`/lectures/${id}`);
}

export async function deleteLecture(formData: FormData) {
  const id = String(formData.get("lectureId"));
  const lecture = await prisma.lecture.delete({ where: { id } });
  await rm(path.join(materialsDir(), id), { recursive: true, force: true });
  revalidatePath(`/courses/${lecture.courseId}`);
  redirect(`/courses/${lecture.courseId}`);
}

export async function deleteModule(formData: FormData) {
  const id = String(formData.get("moduleId"));
  // Lectures survive; they fall back to Unassigned rather than being deleted with it.
  const mod = await prisma.module.delete({ where: { id } });
  revalidatePath(`/courses/${mod.courseId}`);
}

export async function startAttempt(formData: FormData) {
  const lectureId = String(formData.get("lectureId"));
  const questionIds = await pickQuestions(lectureId);
  if (questionIds.length === 0) {
    throw new Error("generate questions for this lecture first");
  }
  const attempt = await prisma.attempt.create({
    data: {
      lectureId,
      responses: { create: questionIds.map((questionId) => ({ questionId, answerText: "" })) },
    },
  });
  redirect(`/attempts/${attempt.id}`);
}

export async function submitAttempt(formData: FormData) {
  const attemptId = String(formData.get("attemptId"));
  const responses = await prisma.response.findMany({
    where: { attemptId },
    select: { id: true },
  });

  const blank: string[] = [];
  for (const r of responses) {
    const answerText = String(formData.get(`answer.${r.id}`) ?? "").trim();
    if (!answerText) blank.push(r.id);
    await prisma.response.update({ where: { id: r.id }, data: { answerText } });
  }
  if (blank.length === responses.length) {
    throw new Error("answer at least one question before submitting");
  }

  for (const r of responses) {
    if (!blank.includes(r.id)) await enqueue("MARK", { responseId: r.id });
  }
  revalidatePath(`/attempts/${attemptId}`);
}
