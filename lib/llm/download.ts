import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { LocalModel } from "@/lib/llm/catalog";
import { importLlamaCpp } from "@/lib/llm/runtime";

/**
 * Where a model comes from: its Hugging Face URI, or, when LOCKIN_MODEL_MIRROR is set,
 * `<mirror>/<model id>.gguf` — for a LAN or campus copy, or where Hugging Face is
 * blocked.
 */
export function modelSource(model: LocalModel): string {
  const mirror = process.env.LOCKIN_MODEL_MIRROR?.replace(/\/+$/, "");
  if (mirror) return `${mirror}/${model.id}.gguf`;
  if (!model.uri) throw new Error(`${model.name} comes only as MLX, for Apple Silicon`);
  return model.uri;
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

/**
 * Downloads a model's MLX copy — a folder of weights, config and tokenizer files from
 * Hugging Face — into `<dir>/mlx/<model id>`. A file already complete is skipped and a
 * partial one carries on from where it stopped, so a stopped download resumes.
 */
export async function downloadMlxModel(
  model: LocalModel,
  dir: string,
  onProgress: (downloaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  if (!model.mlx) throw new Error(`${model.name} has no MLX version`);
  const dest = path.join(dir, "mlx", model.id);
  const listing = await fetch(`https://huggingface.co/api/models/${model.mlx}/tree/main?recursive=true`, { signal });
  if (listing.status === 404) throw new Error(`${model.name} has no MLX version on Hugging Face yet — use llama.cpp for it`);
  if (!listing.ok) throw new Error(`Hugging Face answered ${listing.status}`);
  const files = ((await listing.json()) as Array<{ type: string; path: string; size: number }>).filter(
    (f) => f.type === "file" && !/(^|\/)(README\.md|\.gitattributes)$/i.test(f.path) && !/\.(png|jpe?g|gif)$/i.test(f.path),
  );
  const total = files.reduce((n, f) => n + f.size, 0);
  const sizeOf = (file: string) => stat(file).then((s) => s.size, () => -1);

  let done = 0;
  for (const f of files) {
    const to = path.join(dest, f.path);
    if ((await sizeOf(to)) === f.size) {
      done += f.size;
      continue;
    }
    await mkdir(path.dirname(to), { recursive: true });
    const partial = `${to}.part`;
    const from = Math.max(0, await sizeOf(partial));
    const res = await fetch(`https://huggingface.co/${model.mlx}/resolve/main/${f.path}`, {
      signal,
      redirect: "follow",
      headers: from > 0 ? { Range: `bytes=${from}-` } : {},
    });
    if (!res.ok || !res.body) throw new Error(`${f.path} answered ${res.status}`);
    const resumed = res.status === 206;
    done += resumed ? from : 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (chunk: Buffer) => {
      done += chunk.length;
      onProgress(done, total);
    });
    await pipeline(body, createWriteStream(partial, { flags: resumed ? "a" : "w" }));
    await rename(partial, to);
  }
  onProgress(total, total);
  return { path: dest, bytes: total };
}
