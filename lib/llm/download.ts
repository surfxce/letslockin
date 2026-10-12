import { mkdir } from "node:fs/promises";

import type { LocalModel } from "@/lib/llm/catalog";
import { importLlamaCpp } from "@/lib/llm/runtime";

/**
 * Where a model comes from: its Hugging Face URI, or, when LOCKIN_MODEL_MIRROR is set,
 * `<mirror>/<model id>.gguf` — for a LAN or campus copy, or where Hugging Face is
 * blocked.
 */
export function modelSource(model: LocalModel): string {
  const mirror = process.env.LOCKIN_MODEL_MIRROR?.replace(/\/+$/, "");
  return mirror ? `${mirror}/${model.id}.gguf` : model.uri;
}

/**
 * Downloads a model file, resuming a partial one. Runs in the worker. node-llama-cpp
 * resolves the Hugging Face URI to the right file and downloads it over several
 * connections.
 */
export async function downloadModelFile(
  model: LocalModel,
  dir: string,
  onProgress: (downloaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const { createModelDownloader } = await importLlamaCpp();
  const downloader = await createModelDownloader({
    modelUri: modelSource(model),
    dirPath: dir,
    // Keep the partial file when stopped, so the next attempt carries on from there.
    deleteTempFileOnCancel: false,
    skipExisting: true,
    onProgress: ({ downloadedSize, totalSize }) => onProgress(downloadedSize, totalSize),
  });
  const path = await downloader.download({ signal });
  return { path, bytes: downloader.totalSize };
}
