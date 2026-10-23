import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { prisma } from "@/lib/db";
import { sniffImage } from "@/lib/flashcards/images";
import { HandwritingSchema, MAX_HANDWRITING_PAGES, type HandwritingRead } from "@/lib/handwriting/schema";
import { enqueue } from "@/lib/jobs";
import type { LlmProvider } from "@/lib/llm/provider";
import { usesAi } from "@/lib/modes";
import { dataDir } from "@/lib/paths";
import { getSettings } from "@/lib/settings";

/** A phone photo is 3–8 MB; past this it isn't one page of writing. */
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
/** Longest side sent to the AI: handwriting stays sharp, and the request stays small. */
const LONGEST_SIDE = 2000;

export function handwritingDir(): string {
  return path.join(dataDir(), "handwriting");
}

/** HEIC, as iPhones save photos: an ISO media file whose brand is HEIF's. */
function isHeic(bytes: Uint8Array): boolean {
  const brand = Buffer.from(bytes.subarray(4, 12)).toString("latin1");
  return brand.startsWith("ftyp") && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand.slice(4));
}

/**
 * One photo as the AI is sent it: upright (as the camera held it), no larger than it
 * needs to be, as a JPEG. HEIC is converted with the Mac's own tool first.
 */
export async function preparePhoto(bytes: Uint8Array): Promise<Buffer> {
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error("That photo is too big (40 MB at most).");
  let source: Uint8Array = bytes;
  if (isHeic(bytes)) source = await heicToJpeg(bytes);
  else if (!sniffImage(bytes)) throw new Error("That isn't a photo Lockin can read — use JPEG, PNG, HEIC or WebP.");
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  // Decoding turns the picture the way the camera was held (its orientation tag).
  const image = await loadImage(Buffer.from(source));
  const scale = Math.min(1, LONGEST_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(image, 0, 0, width, height);
  return canvas.encode("jpeg", 88);
}

async function heicToJpeg(bytes: Uint8Array): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("HEIC photos can only be read on a Mac. Save it as a JPEG and try again.");
  const work = await mkdtemp(path.join(tmpdir(), "lockin-heic-"));
  try {
    const from = path.join(work, "photo.heic");
    const to = path.join(work, "photo.jpg");
    await writeFile(from, bytes);
    await promisify(execFile)("/usr/bin/sips", ["-s", "format", "jpeg", from, "--out", to], { timeout: 60_000 });
    return await readFile(to);
  } catch (err) {
    throw new Error(`That HEIC photo couldn't be converted: ${err instanceof Error ? err.message : err}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Keeps the photos of one answer, in order, until the AI has read them. */
export async function savePhotos(photos: Uint8Array[]): Promise<string[]> {
  if (!photos.length) throw new Error("Add a photo of your answer first.");
  if (photos.length > MAX_HANDWRITING_PAGES) throw new Error(`That's more than ${MAX_HANDWRITING_PAGES} pages — one answer at a time.`);
  const prepared = [];
  for (const [i, bytes] of photos.entries()) {
    try {
      prepared.push(await preparePhoto(bytes));
    } catch (err) {
      throw new Error(photos.length > 1 ? `Photo ${i + 1}: ${err instanceof Error ? err.message : err}` : String(err instanceof Error ? err.message : err));
    }
  }
  const dir = path.join(handwritingDir(), randomBytes(9).toString("hex"));
  await mkdir(dir, { recursive: true });
  const files = prepared.map((_, i) => path.join(dir, `page-${i + 1}.jpg`));
  await Promise.all(prepared.map((p, i) => writeFile(files[i], p)));
  return files;
}

export interface HandwritingPayload {
  files: string[];
  question: string;
}

/**
 * Photos of a handwritten answer to one question, to be typed out by the AI. Returns
 * the job to watch. The question helps the AI read medical words; it never adds any.
 */
export async function queueHandwriting(questionId: string, photos: Uint8Array[]): Promise<string> {
  if (!usesAi((await getSettings()).mode)) throw new Error("Reading handwriting needs an AI — set one up in Settings.");
  const question = await prisma.question.findUnique({ where: { id: questionId }, select: { stem: true, lectureId: true } });
  if (!question) throw new Error("That question isn't here any more.");
  const files = await savePhotos(photos);
  const job = await enqueue("HANDWRITING", { files, question: question.stem } satisfies HandwritingPayload, question.lectureId);
  return job.id;
}

/** Run by the worker: the AI reads the photos. They're deleted whatever happens. */
export async function runHandwriting(payload: HandwritingPayload, provider: LlmProvider): Promise<HandwritingRead> {
  const read = await provider.readHandwriting({ question: payload.question, pages: payload.files });
  return { text: read.text.replace(/\r\n?/g, "\n").trim(), unclear: [...new Set(read.unclear)].filter((u) => read.text.includes(u)) };
}

export async function forgetPhotos(payload: unknown) {
  const files = (payload as Partial<HandwritingPayload> | null)?.files;
  if (!Array.isArray(files) || !files.length) return;
  const dir = path.dirname(String(files[0]));
  // Only ever a folder of ours.
  if (path.dirname(dir) === handwritingDir()) await rm(dir, { recursive: true, force: true });
}

/** Photos left behind by a job that never finished: gone after a day. */
export async function sweepPhotos(now = Date.now()) {
  const root = handwritingDir();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name);
    const info = await stat(dir).catch(() => null);
    if (info && now - info.mtimeMs > 86_400_000) await rm(dir, { recursive: true, force: true });
  }
}

export type HandwritingState =
  | { status: "waiting" }
  | { status: "done"; text: string; unclear: string[]; model: string | null }
  | { status: "failed"; error: string };

export async function handwritingState(jobId: string): Promise<HandwritingState> {
  const job = await prisma.job.findFirst({ where: { id: jobId, kind: "HANDWRITING" }, select: { status: true, result: true, error: true, model: true } });
  if (!job) return { status: "failed", error: "That reading isn't here any more — add the photos again." };
  if (job.status === "FAILED") return { status: "failed", error: job.error ?? "The AI couldn't read it." };
  if (job.status !== "DONE") return { status: "waiting" };
  const read = HandwritingSchema.safeParse(JSON.parse(job.result ?? "{}"));
  if (!read.success) return { status: "failed", error: "The AI's reading couldn't be used. Try again." };
  return { status: "done", ...read.data, model: job.model };
}

/**
 * For a phone with no AI of its own to call: the computer reads the photos and the
 * phone waits for the text.
 */
export async function relayHandwriting(questionId: string, photos: Uint8Array[], waitMs = 180_000): Promise<HandwritingRead & { model: string | null }> {
  const jobId = await queueHandwriting(questionId, photos);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    const state = await handwritingState(jobId);
    if (state.status === "done") return { text: state.text, unclear: state.unclear, model: state.model };
    if (state.status === "failed") throw new Error(state.error);
  }
  await prisma.job.updateMany({ where: { id: jobId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: "The phone stopped waiting" } });
  throw new Error("The computer took too long to read it. Try again.");
}
