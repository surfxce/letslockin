import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { throwIfCancelled, timeoutOrCancel } from "@/lib/llm/cancel";
import type { LocalModel } from "@/lib/llm/catalog";
import type { SlidesInfo } from "@/lib/llm/provider";
import type { SlideNote } from "@/lib/sources";

/**
 * Letting an offline model see the slides. Gemma 4 takes images, but the library that
 * runs it inside Lockin (node-llama-cpp) has no way to pass one in — so for this step
 * Lockin runs llama.cpp's own server, which does: the same model file plus its small
 * vision part (the "mmproj"), shown one slide at a time. What it sees becomes the
 * slide notes the summary and LAQs are written from, as Claude's are.
 *
 * Everything here is downloaded once, next to the models, and found again by name. If
 * any of it is missing or fails, preparing carries on with text recognition instead.
 */

const SERVER_NAMES = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];

export interface VisionParts {
  server: string;
  model: string;
  mmproj: string;
}

function visionDir(modelsDir: string) {
  return path.join(modelsDir, "vision");
}

/** Where a model's vision part is kept. */
export function mmprojPath(modelsDir: string, modelId: string) {
  return path.join(visionDir(modelsDir), `${modelId}.mmproj.gguf`);
}

const runtimeDir = (modelsDir: string) => path.join(visionDir(modelsDir), "llama.cpp");

// ---------------------------------------------------------------------------
// Finding what is installed

/** llama-server from PATH (Homebrew's `brew install llama.cpp`), when it is there. */
function onPath(): Promise<string | null> {
  const name = process.env.LOCKIN_LLAMA_SERVER ?? "llama-server";
  return new Promise((resolve) => {
    execFile(name, ["--version"], { timeout: 8000 }, (err) => resolve(err ? null : name));
  });
}

async function findFile(dir: string, names: string[]): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = await findFile(path.join(dir, e.name), names);
      if (hit) return hit;
    }
  }
  return null;
}

let found: { at: number; server: string | null } | null = null;

/** The llama-server to use: one already installed, else the one downloaded for Lockin.
 *  Remembered for a minute — Settings asks on every page. */
export async function findServer(modelsDir: string): Promise<string | null> {
  if (found && Date.now() - found.at < 60_000) return found.server;
  const server = (await onPath()) ?? (await findFile(runtimeDir(modelsDir), SERVER_NAMES));
  found = { at: Date.now(), server };
  return server;
}

/** What a model needs to see slides, if it is all here. */
export async function visionParts(modelsDir: string, modelId: string, modelPath: string): Promise<VisionParts | null> {
  const mmproj = mmprojPath(modelsDir, modelId);
  if (!existsSync(mmproj) || !existsSync(modelPath)) return null;
  const server = await findServer(modelsDir);
  return server ? { server, model: modelPath, mmproj } : null;
}

// ---------------------------------------------------------------------------
// Downloading

/** llama.cpp's build for this computer, from a release's list of files. */
export function pickAsset(names: string[], platform = process.platform, arch = process.arch): string | null {
  const want =
    platform === "darwin"
      ? [`macos-${arch === "arm64" ? "arm64" : "x64"}`]
      : platform === "win32"
        ? [`win-cpu-${arch === "arm64" ? "arm64" : "x64"}`]
        : [`ubuntu-${arch === "arm64" ? "arm64" : "x64"}`];
  for (const w of want) {
    const hit = names.find((n) => new RegExp(`-bin-${w}\\.(zip|tar\\.gz)$`).test(n));
    if (hit) return hit;
  }
  return null;
}

/** A model's vision part, from a repository's list of files: the smallest good one. */
export function pickMmproj(files: string[]): string | null {
  const mm = files.filter((f) => /mmproj[^/]*\.gguf$/i.test(f));
  return (
    mm.find((f) => /q8_0/i.test(f)) ??
    mm.find((f) => /(^|[-_.])f16/i.test(f)) ??
    mm.find((f) => /bf16/i.test(f)) ??
    mm[0] ??
    null
  );
}

/** Repositories that may hold a model's vision part: its own first, then the usual publishers. */
export function mmprojRepos(uri: string): string[] {
  const repo = uri.replace(/^hf:/, "").split(":")[0];
  const base = repo.split("/")[1] ?? "";
  return [...new Set([repo, `ggml-org/${base}`, `unsloth/${base}`])];
}

async function download(url: string, to: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const res = await fetch(url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  const partial = `${to}.part`;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.(done, total);
  });
  await pipeline(body, createWriteStream(partial));
  await rename(partial, to);
}

/** Downloads a model's vision part, unless it is already here. */
export async function installMmproj(
  modelsDir: string,
  model: LocalModel,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const to = mmprojPath(modelsDir, model.id);
  if (existsSync(to)) return to;
  await mkdir(path.dirname(to), { recursive: true });
  const mirror = process.env.LOCKIN_MODEL_MIRROR?.replace(/\/+$/, "");
  if (mirror) {
    await download(`${mirror}/${model.id}.mmproj.gguf`, to, onProgress, signal);
    return to;
  }
  for (const repo of mmprojRepos(model.uri)) {
    const info = await fetch(`https://huggingface.co/api/models/${repo}`, { signal }).catch(() => null);
    if (!info?.ok) continue;
    const files = ((await info.json()) as { siblings?: Array<{ rfilename: string }> }).siblings?.map((s) => s.rfilename) ?? [];
    const file = pickMmproj(files);
    if (!file) continue;
    await download(`https://huggingface.co/${repo}/resolve/main/${file}`, to, onProgress, signal);
    return to;
  }
  throw new Error(`no vision part (mmproj) found for ${model.name} on Hugging Face`);
}

/** Downloads llama.cpp's server for this computer, unless one is already here. */
export async function installServer(modelsDir: string, signal?: AbortSignal): Promise<string> {
  const existing = await findServer(modelsDir);
  if (existing) return existing;
  const release = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    signal,
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!release.ok) throw new Error(`couldn't look up llama.cpp's latest release (${release.status})`);
  const { assets = [] } = (await release.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
  const name = pickAsset(assets.map((a) => a.name));
  const asset = assets.find((a) => a.name === name);
  if (!asset) throw new Error(`llama.cpp has no ready-made build for ${process.platform} ${process.arch}`);

  const dir = runtimeDir(modelsDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, asset.name);
  await download(asset.browser_download_url, archive, undefined, signal);
  if (asset.name.endsWith(".zip")) await unzip(archive, dir);
  else await new Promise<void>((resolve, reject) =>
    execFile("tar", ["-xzf", archive, "-C", dir], (err) => (err ? reject(err) : resolve())),
  );
  await rm(archive, { force: true });
  const server = await findFile(dir, SERVER_NAMES);
  if (!server) throw new Error("llama.cpp's download had no llama-server in it");
  found = { at: Date.now(), server };
  return server;
}

async function unzip(file: string, dir: string) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await readFile(file));
  for (const entry of Object.values(zip.files)) {
    const to = path.join(dir, entry.name);
    if (!to.startsWith(dir + path.sep)) continue; // a path that climbs out of the folder is not written
    if (entry.dir) {
      await mkdir(to, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, await entry.async("nodebuffer"));
    // Zip files from GitHub keep no permissions worth trusting; programs and libraries need to run.
    if (process.platform !== "win32") await chmod(to, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Looking at the slides

const PROMPT =
  "This is one slide from a university lecture. For a student's revision notes, write every word on it — " +
  "including words inside pictures, diagrams and tables — and then what each figure, diagram, graph, table or " +
  "photo shows: labels, arrows, axes and trends. Be factual and brief: one to four sentences. If the slide is " +
  "only a title, a logo or decoration, say so in a few words.";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(base: string, child: ChildProcess, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`llama-server stopped while loading (exit ${child.exitCode})`);
    const ok = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server took too long to load the model");
}

/**
 * Shows the offline model every PDF slide of a lecture, one at a time, and writes down
 * what it sees. Starts llama.cpp's server for the purpose and stops it after.
 */
export async function lookAtSlides(
  parts: VisionParts,
  slides: SlidesInfo,
  onProgress?: (detail: string) => void,
): Promise<SlideNote[]> {
  const { slidePictures } = await import("@/lib/llm/base");
  const pictures = await slidePictures(slides);
  if (pictures.length === 0) return [];

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  onProgress?.("loading the model's vision");
  const child = spawn(
    parts.server,
    ["-m", parts.model, "--mmproj", parts.mmproj, "--host", "127.0.0.1", "--port", String(port), "-c", "8192", "-ngl", "999"],
    { cwd: path.dirname(parts.server), stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  child.stderr?.on("data", (c) => (log = (log + c).slice(-2000)));
  try {
    await waitUntilUp(base, child, 5 * 60_000);
    const notes: SlideNote[] = [];
    for (const [i, p] of pictures.entries()) {
      throwIfCancelled();
      onProgress?.(`looking at slide ${i + 1} of ${pictures.length}`);
      const png = (await readFile(p.file)).toString("base64");
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT },
                { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
              ],
            },
          ],
          max_tokens: 350,
          temperature: 0.1,
        }),
        signal: timeoutOrCancel(5 * 60_000),
      });
      if (!res.ok) throw new Error(`llama-server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (text) notes.push({ slide: p.slide, notes: text });
    }
    return notes;
  } catch (err) {
    const tail = log.trim().split("\n").at(-1);
    throw new Error(`${err instanceof Error ? err.message : err}${tail ? ` (${tail})` : ""}`);
  } finally {
    // Wait for it to be gone: the summary loads the same model next, and two copies at
    // once is enough to push a laptop into swap.
    if (child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await gone;
      clearTimeout(forced);
    }
  }
}

/** Size on disk, for Settings. */
export async function bytesOf(file: string): Promise<number> {
  return (await stat(file).catch(() => null))?.size ?? 0;
}
