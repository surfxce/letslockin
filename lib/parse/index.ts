import { createHash } from "node:crypto";
import path from "node:path";
import type { MaterialKind } from "@/lib/types";

export interface ParsedFile {
  text: string;
  /** What the parser could not do, shown in the UI so bad input is never invisible. */
  warnings: string[];
}

/**
 * Parsing happens once, at ingest. Every later model call reads the stored text,
 * so a bad extraction is caught and corrected before four phases sit on top of it.
 */
export async function parseMaterial(
  filename: string,
  buffer: Buffer,
): Promise<ParsedFile> {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".txt":
    case ".md":
      return { text: buffer.toString("utf8"), warnings: [] };
    case ".vtt":
    case ".srt":
      return parseCaptions(buffer.toString("utf8"));
    case ".pdf":
      return parsePdf(buffer);
    case ".pptx":
      return parsePptx(buffer);
    default:
      throw new Error(
        `cannot parse "${ext || filename}" — supported: .txt .md .vtt .srt .pdf .pptx`,
      );
  }
}

/**
 * Extension alone is not enough: .txt and .md are used for both transcripts and
 * exported slide notes, and getting it wrong means the pipeline summarises a slide
 * outline while believing it has the lecture. Look at the text when there is text.
 */
export function guessKind(filename: string, text?: string): MaterialKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pptx") return "SLIDES";
  if (ext === ".vtt" || ext === ".srt") return "TRANSCRIPT";

  if (text) {
    const head = text.slice(0, 4000);
    if (/^\s*WEBVTT/.test(text) || /\[(?:\d+:)?\d{2}:\d{2}\]/.test(head)) return "TRANSCRIPT";
    if (/^-{3} (?:Slide|Page) \d+/m.test(head) || /^\s*Slide \d+\s*[:.]/m.test(head)) {
      return "SLIDES";
    }
  }

  if (ext === ".txt" || ext === ".md") return "TRANSCRIPT";
  return "SLIDES"; // a lone PDF is far more often slides than a transcript
}

export function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/**
 * WebVTT/SRT into readable prose. Timestamps are kept at paragraph starts because
 * concept extraction cites them as sourceRefs, and "how many minutes did the
 * lecturer spend here" is the fallback yield signal when there are no past papers.
 */
function parseCaptions(raw: string): ParsedFile {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let pending: string | null = null;
  let lastStamp = "";
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const text = dedupeRepeats(buffer.join(" ").trim());
    if (text) out.push(`${pending ?? lastStamp} ${text}`.trim());
    buffer = [];
    pending = null;
  };

  for (const line of lines) {
    const time = line.match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,]\d{3}\s+-->/);
    if (time) {
      // Keep the hour: a two-hour lecture's 01:15:30 must not collapse to 15:30,
      // or its measured duration — and its question count — comes out halved.
      const hours = Number(time[1] ?? 0);
      const stamp = hours > 0 ? `[${hours}:${time[2]}:${time[3]}]` : `[${time[2]}:${time[3]}]`;
      if (stamp !== lastStamp) {
        flush();
        pending = stamp;
        lastStamp = stamp;
      }
      continue;
    }
    if (/^\s*$/.test(line) || /^WEBVTT/.test(line) || /^\d+$/.test(line.trim())) continue;
    buffer.push(line.replace(/<[^>]+>/g, "").trim());
  }
  flush();

  const text = out.join("\n\n");
  return {
    text,
    warnings: text.trim() ? [] : ["no caption text found — is this really a VTT/SRT file?"],
  };
}

/** Live captions repeat the previous line as they extend it; collapse that. */
function dedupeRepeats(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (out.length >= 2 && out[out.length - 1] === w && out[out.length - 2] === w) continue;
    out.push(w);
  }
  return out.join(" ");
}

async function parsePdf(buffer: Buffer): Promise<ParsedFile> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const body = pages
    .map((p, i) => `--- Page ${i + 1} ---\n${p.trim()}`)
    .filter((p) => p.split("\n").slice(1).join("").trim())
    .join("\n\n");

  const warnings: string[] = [];
  const empty = totalPages - body.split("--- Page ").length + 1;
  if (empty > 0) {
    warnings.push(
      `${empty} of ${totalPages} pages had no extractable text — likely scanned images, ` +
        `so their content is invisible to every later step. Consider correcting by hand.`,
    );
  }
  return { text: body, warnings };
}

/** A .pptx is a zip; slide text lives in <a:t> runs inside ppt/slides/slideN.xml. */
async function parsePptx(buffer: Buffer): Promise<ParsedFile> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slideFiles.length === 0) {
    throw new Error("no slides found inside the .pptx — is the file complete?");
  }

  const sections: string[] = [];
  const imageOnly: number[] = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name)!.async("string");
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const n = slideNumber(name);
    const body = runs.join(" ").replace(/\s+/g, " ").trim();
    if (!body) imageOnly.push(n);
    sections.push(`--- Slide ${n} ---\n${body || "(no text — image or diagram only)"}`);
  }

  const warnings: string[] = [];
  if (imageOnly.length) {
    warnings.push(
      `slide${imageOnly.length === 1 ? "" : "s"} ${imageOnly.join(", ")} carry no text ` +
        `(diagram or image only) — describe them by hand if they matter.`,
    );
  }
  return { text: sections.join("\n\n"), warnings };
}

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * How long the lecture actually ran, from the transcript's own last timestamp.
 * Deterministic, so the importer never asks the model to guess a duration it can
 * simply read — and duration is what sets the question count.
 */
export function measureHours(text: string): number | null {
  const stamps = [...text.matchAll(/\[(?:(\d+):)?(\d{2}):(\d{2})\]/g)];
  if (stamps.length === 0) return null;
  const last = stamps[stamps.length - 1];
  const seconds = Number(last[1] ?? 0) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  if (seconds < 300) return null; // too short to be a lecture; probably not a transcript
  return Math.round((seconds / 3600) * 2) / 2; // to the nearest half hour
}
