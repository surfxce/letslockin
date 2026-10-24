import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { checksum, guessKind, measureHours, parseMaterial } from "@/lib/parse";
import { isRecording, MAX_RECORDING_BYTES, RECORDING_EXTS } from "@/lib/recordings/media";

const SUPPORTED = new Set([".txt", ".md", ".vtt", ".srt", ".pdf", ".pptx", ...RECORDING_EXTS]);
const MAX_FILES = 120;
const MAX_BYTES = 80 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "materials"]);

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  filename: string;
  modifiedOn: Date;
  bytes: number;
  kindGuess: string;
  text: string;
  /** Pages or slides, for a deck. */
  pages: number | null;
  measuredHours: number | null;
  warnings: string[];
  checksum: string;
}

export interface ScanResult {
  files: ScannedFile[];
  skipped: Array<{ path: string; why: string }>;
}

/**
 * Walks a folder, parses everything it recognises, and returns enough of each file
 * to group them. Nothing is written and nothing is copied — this is a look, not an
 * import, so pointing it at the wrong folder costs nothing.
 */
export async function scanFolder(root: string): Promise<ScanResult> {
  const info = await stat(root).catch(() => null);
  if (!info) throw new Error(`no such folder: ${root}`);
  if (!info.isDirectory()) throw new Error(`not a folder: ${root}`);

  const found: string[] = [];
  const skipped: ScanResult["skipped"] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 4 || found.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
          skipped.push({ path: path.relative(root, full), why: "unsupported file type" });
          continue;
        }
        if (found.length >= MAX_FILES) {
          skipped.push({ path: path.relative(root, full), why: `over the ${MAX_FILES}-file limit` });
          continue;
        }
        found.push(full);
      }
    }
  }
  await walk(root, 0);

  const files: ScannedFile[] = [];
  for (const absolutePath of found) {
    const st = await stat(absolutePath);
    // A recording is transcribed once it's imported; it's never read in here.
    if (isRecording(absolutePath)) {
      if (st.size > MAX_RECORDING_BYTES) {
        skipped.push({ path: path.relative(root, absolutePath), why: "a recording larger than 6GB" });
        continue;
      }
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        filename: path.basename(absolutePath),
        modifiedOn: st.mtime,
        bytes: st.size,
        kindGuess: "RECORDING",
        text: "",
        pages: null,
        measuredHours: null,
        warnings: [],
        checksum: `recording-${st.size}`,
      });
      continue;
    }
    if (st.size > MAX_BYTES) {
      skipped.push({ path: path.relative(root, absolutePath), why: "larger than 80MB" });
      continue;
    }
    const buffer = await readFile(absolutePath);
    try {
      const parsed = await parseMaterial(path.basename(absolutePath), buffer);
      // A deck of pictures has no text but is still worth importing: Claude reads its
      // pages as images, and offline its words are read with text recognition.
      if (!parsed.text.trim() && !parsed.pages) {
        skipped.push({ path: path.relative(root, absolutePath), why: "no extractable text" });
        continue;
      }
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        filename: path.basename(absolutePath),
        modifiedOn: st.mtime,
        bytes: st.size,
        kindGuess: guessKind(absolutePath, parsed.text),
        text: parsed.text,
        pages: parsed.pages ?? null,
        measuredHours: measureHours(parsed.text),
        warnings: parsed.warnings,
        checksum: checksum(buffer),
      });
    } catch (err) {
      skipped.push({
        path: path.relative(root, absolutePath),
        why: err instanceof Error ? err.message : "could not be parsed",
      });
    }
  }

  return { files, skipped };
}
