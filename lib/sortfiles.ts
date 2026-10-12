import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SortFile } from "@/lib/llm/provider";
import { guessKind, measureHours, parseMaterial } from "@/lib/parse";

/**
 * What a model needs to put a file in the right lecture, and no more: the opening of
 * a transcript, and the first line of each slide — a deck's slide titles read like
 * its table of contents. Kept short so sorting a whole folder is one quick call.
 */
export function excerptOf(
  kind: string,
  text: string,
  opts: { budget: number; pages?: number | null; hours?: number | null },
): { detail: string; excerpt: string } {
  const cap = (s: string) => (s.length > opts.budget ? `${s.slice(0, opts.budget - 1)}…` : s);

  if (kind === "SLIDES") {
    const pages = text
      .split(/^-{3} (?:Page|Slide) \d+ -{3}$/m)
      .slice(1)
      .map((p) => p.trim().split("\n")[0]?.trim() ?? "");
    const firstLines = pages.map((l) => (/^\(no text/.test(l) ? "" : l.slice(0, 70))).filter(Boolean);
    const total = opts.pages ?? pages.length;
    const blank = total - firstLines.length;
    return {
      detail: `slides, ${total} page${total === 1 ? "" : "s"}${blank > 0 ? `, ${blank} without text` : ""}`,
      excerpt: cap(firstLines.join(" · ") || text.replace(/\s+/g, " ").trim()),
    };
  }

  const spoken = text
    .replace(/^WEBVTT.*$/m, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\S+/g, "")
    .replace(/\[(?:\d+:)?\d{2}:\d{2}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (kind === "TRANSCRIPT") {
    const minutes = opts.hours ? Math.round(opts.hours * 60) : null;
    return { detail: `transcript${minutes ? `, ${minutes} min` : ""}`, excerpt: cap(spoken) };
  }
  return { detail: kind.toLowerCase().replace("_", " "), excerpt: cap(spoken) };
}

/** Reads the chosen files again and describes each for the sorting model, numbered from 1. */
export async function describeForSort(root: string, relPaths: string[], budget: number): Promise<SortFile[]> {
  const out: SortFile[] = [];
  for (const [i, rel] of relPaths.entries()) {
    const abs = path.resolve(root, rel);
    const parsed = await parseMaterial(path.basename(abs), await readFile(abs));
    const kind = guessKind(abs, parsed.text);
    out.push({
      number: i + 1,
      path: rel,
      ...excerptOf(kind, parsed.text, { budget, pages: parsed.pages, hours: measureHours(parsed.text) }),
    });
  }
  return out;
}
