import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { mlxAvailable } from "@/lib/llm/mlx";
import { prisma } from "@/lib/db";
import { findModel, type LocalModel } from "@/lib/llm/catalog";
import { dataDir } from "@/lib/paths";
import { getSettings, setSetting } from "@/lib/settings";

/**
 * Local models on disk, and their downloads. The worker downloads (so a download
 * survives page reloads and runs beside lecture preparation); the server only reads
 * what is installed and asks for downloads by queueing a DOWNLOAD job.
 */

const REGISTRY_KEY = "localModels";

export interface InstalledModel {
  id: string;
  path: string;
  bytes: number;
  downloadedAt: string;
  /** "mlx": a folder for the Swift engine on Apple Silicon. Absent: a GGUF file for llama.cpp. */
  format?: "mlx" | "gguf";
}

export function modelsDir(): string {
  return process.env.LOCKIN_MODELS_DIR ?? path.join(dataDir(), "models");
}

async function readRegistry(): Promise<InstalledModel[]> {
  const row = await prisma.setting.findUnique({ where: { key: REGISTRY_KEY } });
  try {
    const list = row ? (JSON.parse(row.value) as InstalledModel[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeRegistry(list: InstalledModel[]) {
  const value = JSON.stringify(list);
  await prisma.setting.upsert({ where: { key: REGISTRY_KEY }, update: { value }, create: { key: REGISTRY_KEY, value } });
}

/**
 * Installed models whose files are still there — a deleted file is not installed. A model
 * whose folder was moved (from running Lockin out of its code folder into the desktop
 * app's data folder, say) is found again in this models folder and its path corrected.
 */
export async function installedModels(): Promise<InstalledModel[]> {
  const list = await readRegistry();
  let moved = false;
  const found = list.map((m) => {
    if (existsSync(m.path)) return m;
    const here =
      m.format === "mlx" ? path.join(modelsDir(), "mlx", m.id) : path.join(modelsDir(), path.basename(m.path));
    if (!existsSync(here)) return m;
    moved = true;
    return { ...m, path: here };
  });
  if (moved) await writeRegistry(found);
  return found.filter((m) => existsSync(m.path));
}

export async function registerModel(model: InstalledModel) {
  const list = (await readRegistry()).filter((m) => m.id !== model.id);
  await writeRegistry([...list, model]);
}

/** Deletes a model's file and forgets it. If it was the one in use, nothing is. */
export async function removeModel(id: string) {
  const list = await readRegistry();
  const entry = list.find((m) => m.id === id);
  if (entry) await rm(entry.path, { force: true, recursive: true });
  await writeRegistry(list.filter((m) => m.id !== id));
  if ((await getSettings()).localModel === id) await setSetting("localModel", null);
}

/** The model "local" mode uses, if it is downloaded. */
export async function activeLocalModel(): Promise<{ model: LocalModel; path: string } | null> {
  const { localModel } = await getSettings();
  const model = findModel(localModel);
  const installed = (await installedModels()).find((m) => m.id === localModel);
  return model && installed ? { model, path: installed.path } : null;
}

/** The offline model to fall back on when Claude fails: the one chosen for local mode,
 *  else any that is downloaded. */
export async function fallbackLocalModel(): Promise<{ model: LocalModel; path: string } | null> {
  const active = await activeLocalModel();
  if (active) return active;
  for (const m of await installedModels()) {
    const model = findModel(m.id);
    if (model) return { model, path: m.path };
  }
  return null;
}

export interface DownloadState {
  jobId: string;
  modelId: string;
  name: string;
  status: string;
  downloaded: number;
  total: number;
  /** What is downloading: its MLX copy, or after the model itself, its vision part then llama.cpp's server. */
  part: "mlx" | "vision" | "server" | null;
  error: string | null;
}

function toState(job: { id: string; payload: string; status: string; result: string | null; error: string | null }): DownloadState {
  const payload = JSON.parse(job.payload) as { modelId: string; visionOnly?: boolean; mlx?: boolean };
  let progress: { downloaded: number; total: number; part?: string } = { downloaded: 0, total: 0 };
  try {
    if (job.result) progress = { ...progress, ...JSON.parse(job.result) };
  } catch {
    // Progress is cosmetic; a bad value just shows 0%.
  }
  return {
    jobId: job.id,
    modelId: payload.modelId,
    name: findModel(payload.modelId)?.name ?? payload.modelId,
    status: job.status,
    downloaded: progress.downloaded,
    total: progress.total,
    part:
      progress.part === "server"
        ? "server"
        : progress.part === "vision" || payload.visionOnly
          ? "vision"
          : payload.mlx
            ? "mlx"
            : null,
    error: job.error,
  };
}

/** Downloads waiting or running, and any that finished or failed in the last hour. */
export async function downloads(): Promise<DownloadState[]> {
  const jobs = await prisma.job.findMany({
    where: {
      kind: "DOWNLOAD",
      OR: [{ status: { in: ["PENDING", "RUNNING"] } }, { finishedAt: { gte: new Date(Date.now() - 3_600_000) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, payload: true, status: true, result: true, error: true },
  });
  // Only the latest attempt per model matters.
  const seen = new Set<string>();
  return jobs.map(toState).filter((d) => (seen.has(d.modelId) ? false : (seen.add(d.modelId), true)));
}

/**
 * Queues a download. When it finishes, the worker links it: it becomes the model in
 * use. `visionOnly` fetches just the part that lets a downloaded model see slides.
 */
export async function requestDownload(modelId: string, opts: { visionOnly?: boolean; mlx?: boolean } = {}) {
  const model = findModel(modelId);
  if (!model) throw new Error(`unknown model ${modelId}`);
  // On Apple Silicon with the engine, a model comes as its faster MLX copy.
  const mlx = !opts.visionOnly && !!model.mlx && (opts.mlx ?? mlxAvailable());
  const active = await prisma.job.findFirst({
    where: { kind: "DOWNLOAD", status: { in: ["PENDING", "RUNNING"] }, payload: { contains: `"${modelId}"` } },
  });
  if (active) return active.id;
  const job = await prisma.job.create({
    data: {
      kind: "DOWNLOAD",
      payload: JSON.stringify(
        opts.visionOnly ? { modelId, visionOnly: true } : mlx ? { modelId, link: true, mlx: true } : { modelId, link: true },
      ),
      priority: 0,
    },
  });
  return job.id;
}

/** The worker notices within a couple of seconds and stops; the partial file is kept for a resume. */
export async function cancelDownload(jobId: string) {
  await prisma.job.updateMany({
    where: { id: jobId, kind: "DOWNLOAD", status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "FAILED", error: "Cancelled", finishedAt: new Date() },
  });
}
