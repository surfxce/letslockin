"use server";

import { revalidatePath } from "next/cache";

import { knownLeftOut, MAX_ASK, saveLeftOut, type AskPayload, type AskResult } from "@/lib/ask";
import { prisma } from "@/lib/db";
import { cleanTerm } from "@/lib/glossary";
import { enqueue } from "@/lib/jobs";
import {
  API_SERVICE_LIST,
  CLOUD_ENGINES,
  CLOUD_MODELS,
  LAQ_STYLES,
  perHour,
  usesAi,
  type ApiService,
  type CloudEngine,
  type CloudModel,
  type LaqStyle,
} from "@/lib/modes";
import { activeLocalModel } from "@/lib/models";
import { getSettings, setApiKey, setSetting } from "@/lib/settings";
import { readSkipped } from "@/lib/sources";
import { cleanCrop, setFigureCrop, type Crop } from "@/lib/markdown";
import { addLeftOut, insertAtStart, insertIntoSection, insertUnder } from "@/lib/summary-edit";

/**
 * What the study tools on a lecture page call: asking about the lecture, editing and
 * adding to its summary, and its glossary. Every write refreshes the page it came from.
 */

function refreshAll() {
  revalidatePath("/", "layout");
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Asking

export type AskRequest =
  | { lectureId: string; kind: "question"; question: string }
  | { lectureId: string; kind: "breakdown"; selection: string }
  | { lectureId: string; kind: "leftout"; what: string };

/** Queued for the worker (poll /api/jobs/<jobId>), answered at once, or refused. */
export type AskStart = { jobId: string } | { done: AskResult } | { error: string };

export async function startAsk(req: AskRequest): Promise<AskStart> {
  const lecture = await prisma.lecture.findUnique({
    where: { id: req.lectureId },
    include: { materials: true },
  });
  if (!lecture) return { error: "This lecture no longer exists." };

  let payload: AskPayload;
  if (req.kind === "leftout") {
    const item = readSkipped(lecture.skipped).find((s) => s.what === req.what);
    if (!item) return { error: "That part is no longer listed — the lecture was prepared again." };
    // Known already, or an aims slide whose words are in the deck: no model needed.
    const known = item.about ?? knownLeftOut(lecture.materials, item.what);
    if (known) {
      if (!item.about) await saveLeftOut(lecture.id, item.what, known);
      return { done: { kind: "leftout", answer: known, section: null, what: item.what, found: true } };
    }
    payload = { kind: "leftout", lectureId: lecture.id, what: item.what, where: item.where };
  } else {
    if (!lecture.summaryMd?.trim()) return { error: "This lecture has no summary yet — prepare it first." };
    const text = (req.kind === "question" ? req.question : req.selection).trim();
    if (!text) return { error: req.kind === "question" ? "Type a question first." : "Select some text first." };
    if (text.length > MAX_ASK) {
      return { error: `That's too long — keep it under ${MAX_ASK.toLocaleString("en")} characters.` };
    }
    payload =
      req.kind === "question"
        ? { kind: "question", lectureId: lecture.id, question: text }
        : { kind: "breakdown", lectureId: lecture.id, selection: text };
  }

  const { mode } = await getSettings();
  if (!usesAi(mode)) return { error: "No AI runs in copy & paste mode — copy the prompt into your AI chat instead." };
  if (mode === "local" && !(await activeLocalModel())) {
    return { error: "Download an offline model first, in Settings → Offline AI." };
  }
  const job = await enqueue("ASK", { ...payload }, lecture.id);
  return { jobId: job.id };
}

// ---------------------------------------------------------------------------
// The summary

export type EditResult = { ok: boolean; message: string; conflict?: boolean };

/**
 * Saves an edited summary. `base` is the summary the editor opened with: if it has
 * changed since (an answer added from another window, a rewrite finished), nothing is
 * overwritten unless the student says so.
 */
export async function saveSummaryEdit(input: {
  lectureId: string;
  markdown: string;
  base: string;
  force?: boolean;
}): Promise<EditResult> {
  const markdown = input.markdown.replace(/\s+$/, "") + "\n";
  if (!markdown.trim()) return { ok: false, message: "A summary can't be empty. Use Replace this summary to start again." };
  const lecture = await prisma.lecture.findUnique({ where: { id: input.lectureId }, select: { summaryMd: true } });
  if (!lecture) return { ok: false, message: "This lecture no longer exists." };
  if (!input.force && (lecture.summaryMd ?? "").trim() !== input.base.trim()) {
    return {
      ok: false,
      conflict: true,
      message: "The summary changed since you started editing (an answer was added, or it was rewritten).",
    };
  }
  await prisma.lecture.update({ where: { id: input.lectureId }, data: { summaryMd: markdown } });
  refreshAll();
  return { ok: true, message: "Saved." };
}

/** Where an added block goes: under a heading, under the line some text is on, or at the top. */
export type Placement = { section: string | null } | { under: string } | { start: true };

export async function addToSummary(input: {
  lectureId: string;
  markdown: string;
  place: Placement;
}): Promise<EditResult> {
  const block = input.markdown.trim();
  if (!block) return { ok: false, message: "Nothing to add." };
  try {
    const lecture = await prisma.lecture.findUniqueOrThrow({ where: { id: input.lectureId }, select: { summaryMd: true } });
    const md = lecture.summaryMd ?? "";
    const next =
      "under" in input.place
        ? insertUnder(md, input.place.under, block)
        : "start" in input.place
          ? insertAtStart(md, block)
          : insertIntoSection(md, input.place.section, block);
    await prisma.lecture.update({ where: { id: input.lectureId }, data: { summaryMd: next } });
  } catch (err) {
    return { ok: false, message: message(err) };
  }
  refreshAll();
  return { ok: true, message: "Added to the summary." };
}

/** Puts a left-out part back into the summary, and remembers that it was. */
export async function addLeftOutToSummary(input: { lectureId: string; what: string }): Promise<EditResult> {
  const lecture = await prisma.lecture.findUnique({
    where: { id: input.lectureId },
    select: { summaryMd: true, skipped: true },
  });
  if (!lecture) return { ok: false, message: "This lecture no longer exists." };
  const list = readSkipped(lecture.skipped);
  const item = list.find((s) => s.what === input.what);
  if (!item?.about) return { ok: false, message: "Lockin doesn't know what that part said yet." };
  if (item.added) return { ok: true, message: "Already in the summary." };
  await prisma.lecture.update({
    where: { id: input.lectureId },
    data: {
      summaryMd: addLeftOut(lecture.summaryMd ?? "", item.what, item.about),
      skipped: JSON.stringify(list.map((s) => (s.what === item.what ? { ...s, added: true } : s))),
    },
  });
  refreshAll();
  return { ok: true, message: "Added to the summary." };
}

/**
 * Crops one slide picture in the summary to the part the student chose, or shows the
 * whole slide again (crop null). `figure` is the picture's place among the summary's
 * slide pictures, as the page numbered them.
 */
export async function setSlideCrop(input: {
  lectureId: string;
  figure: number;
  slide: number;
  crop: Crop | null;
}): Promise<EditResult> {
  const crop = input.crop ? cleanCrop(input.crop) : null;
  if (input.crop && !crop) return { ok: false, message: "That's too small to show — drag out a bigger box." };
  const lecture = await prisma.lecture.findUnique({ where: { id: input.lectureId }, select: { summaryMd: true } });
  if (!lecture?.summaryMd) return { ok: false, message: "This lecture has no summary." };
  const next = setFigureCrop(lecture.summaryMd, input.figure, input.slide, crop);
  if (next === null) {
    return { ok: false, message: "Couldn't find that picture in the summary — it may have just changed. Try again." };
  }
  if (next !== lecture.summaryMd) {
    await prisma.lecture.update({ where: { id: input.lectureId }, data: { summaryMd: next } });
  }
  refreshAll();
  return { ok: true, message: crop ? "Cropped." : "Showing the whole slide." };
}

// ---------------------------------------------------------------------------
// The glossary

export interface GlossaryEntry {
  id: string;
  term: string;
  explanation: string;
}

/** Adds a term, or replaces the explanation of one already there (whatever its case). */
export async function addGlossaryTerm(input: {
  lectureId: string;
  term: string;
  explanation: string;
}): Promise<{ ok: true; entry: GlossaryEntry } | { ok: false; message: string }> {
  const term = cleanTerm(input.term);
  const explanation = input.explanation.trim();
  if (!term) return { ok: false, message: "Select a word or phrase first." };
  if (!explanation) return { ok: false, message: "There's no explanation to keep yet." };
  const existing = (await prisma.glossaryTerm.findMany({ where: { lectureId: input.lectureId } })).find(
    (g) => g.term.toLowerCase() === term.toLowerCase(),
  );
  const row = existing
    ? await prisma.glossaryTerm.update({ where: { id: existing.id }, data: { explanation } })
    : await prisma.glossaryTerm.create({ data: { lectureId: input.lectureId, term, explanation } });
  refreshAll();
  return { ok: true, entry: { id: row.id, term: row.term, explanation: row.explanation } };
}

export async function removeGlossaryTerm(id: string): Promise<void> {
  await prisma.glossaryTerm.deleteMany({ where: { id } });
  refreshAll();
}

// ---------------------------------------------------------------------------
// LAQ settings

export async function setLaqSettings(input: {
  laqsPerHour?: number;
  sittingPerHour?: number;
  laqStyle?: LaqStyle;
}): Promise<void> {
  if (input.laqsPerHour !== undefined) await setSetting("laqsPerHour", perHour(input.laqsPerHour));
  if (input.sittingPerHour !== undefined) await setSetting("sittingPerHour", perHour(input.sittingPerHour));
  if (input.laqStyle && LAQ_STYLES.includes(input.laqStyle)) await setSetting("laqStyle", input.laqStyle);
  refreshAll();
}

/** Which Claude does the work, and whether the offline model steps in when it fails. */
export async function setCloudSettings(input: { cloudModel?: CloudModel; fallbackLocal?: boolean }): Promise<void> {
  if (input.cloudModel && CLOUD_MODELS.includes(input.cloudModel)) await setSetting("cloudModel", input.cloudModel);
  if (input.fallbackLocal !== undefined) await setSetting("fallbackLocal", !!input.fallbackLocal);
  refreshAll();
}

/** Which cloud AI "auto" mode uses, and how it is set up. */
export async function setEngineSettings(input: {
  cloudEngine?: CloudEngine;
  codexModel?: string;
  agyModel?: string;
  apiService?: ApiService;
  apiBaseUrl?: string;
  apiModel?: string;
  apiVision?: boolean;
}): Promise<void> {
  if (input.cloudEngine && CLOUD_ENGINES.includes(input.cloudEngine)) await setSetting("cloudEngine", input.cloudEngine);
  if (input.apiService && API_SERVICE_LIST.includes(input.apiService)) await setSetting("apiService", input.apiService);
  for (const k of ["codexModel", "agyModel", "apiBaseUrl", "apiModel"] as const) {
    if (typeof input[k] === "string") await setSetting(k, input[k]!.trim().slice(0, 300));
  }
  if (input.apiVision !== undefined) await setSetting("apiVision", !!input.apiVision);
  refreshAll();
}

/** Saves the API key, or forgets it when given nothing. Never sent back to a page. */
export async function saveApiKey(key: string | null): Promise<{ ok: boolean; message: string }> {
  const clean = (key ?? "").trim();
  if (clean.length > 500 || /\s/.test(clean)) return { ok: false, message: "That doesn't look like an API key." };
  await setApiKey(clean || null);
  refreshAll();
  return { ok: true, message: clean ? "Key saved." : "Key removed." };
}

/**
 * Asks the chosen cloud AI one tiny question, so a sign-in, key or model name that is
 * wrong shows up here rather than half-way through preparing a lecture.
 */
export async function testCloudEngine(): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  try {
    const { cloudProvider } = await import("@/lib/llm");
    const provider = await cloudProvider();
    await provider.ask({
      kind: "breakdown",
      lectureTitle: "A quick test",
      summary: "Insulin lowers blood glucose by moving GLUT4 to the surface of muscle and fat cells.",
      selection: "GLUT4",
    });
    return { ok: true, message: `Working — ${provider.lastModel} answered in ${((Date.now() - started) / 1000).toFixed(0)}s.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
