import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { materialsDir } from "@/lib/paths";
import { importAtRuntime } from "@/lib/runtime-import";
import { deckPages, slideOrder } from "@/lib/sources";

/**
 * A lecture's slides as pictures. Slides are numbered across the lecture — a second
 * deck carries on where the first ends — and that number is what summaries cite
 * ("![The ghrelin pathway](slide:12)") and what models are told.
 *
 * Pages are rendered the first time something asks for them and kept beside the
 * lecture's files, so pictures work in every mode, with no job to wait for.
 */

export interface Deck {
  materialId: string;
  name: string;
  /** Absolute path of the stored file. */
  file: string;
  /** Only a PDF can be shown as pages and read as pages by a model. */
  pdf: boolean;
  pages: number;
  /** Lecture-wide number of its first slide. */
  first: number;
}

/** Width of a rendered slide: sharp on a laptop screen, ~30–80 KB a page. */
const WIDTH = 1280;

export async function lectureDecks(lectureId: string): Promise<Deck[]> {
  const materials = await prisma.material.findMany({ where: { lectureId, kind: "SLIDES" } });
  const decks: Deck[] = [];
  let next = 1;
  for (const m of materials.sort(slideOrder)) {
    const file = path.join(materialsDir(), m.path);
    const pdf = /\.pdf$/i.test(m.originalName);
    let pages = m.pageCount;
    if (pages === null) {
      // Imported before page counts were kept: count once and remember.
      pages = pdf ? await countPdfPages(file).catch(() => deckPages(m)) : deckPages(m);
      await prisma.material.update({ where: { id: m.id }, data: { pageCount: pages } });
    }
    decks.push({ materialId: m.id, name: m.originalName, file, pdf, pages, first: next });
    next += pages;
  }
  return decks;
}

type WithDecks = { id: string; courseId: string; materials: Array<{ kind: string; checksum: string }> };

/**
 * The other lectures in the course holding one of this lecture's decks — a deck that
 * covers two lectures is copied into each — keyed by the deck's checksum.
 */
export async function sharedDecks(lecture: WithDecks): Promise<Map<string, Array<{ id: string; title: string }>>> {
  const decks = lecture.materials.filter((m) => m.kind === "SLIDES").map((m) => m.checksum);
  const by = new Map<string, Array<{ id: string; title: string }>>();
  if (decks.length === 0) return by;
  const copies = await prisma.material.findMany({
    where: { kind: "SLIDES", checksum: { in: decks }, lecture: { courseId: lecture.courseId, id: { not: lecture.id } } },
    select: { checksum: true, lecture: { select: { id: true, title: true, deliveredOn: true } } },
  });
  copies.sort((a, b) => (a.lecture?.deliveredOn.getTime() ?? 0) - (b.lecture?.deliveredOn.getTime() ?? 0));
  for (const c of copies) {
    if (!c.lecture) continue;
    const list = by.get(c.checksum) ?? [];
    if (!list.some((l) => l.id === c.lecture!.id)) list.push({ id: c.lecture.id, title: c.lecture.title });
    by.set(c.checksum, list);
  }
  return by;
}

/** Titles of the lectures sharing any of this lecture's decks, for the prompts. */
export async function sharingTitles(lecture: WithDecks): Promise<string[]> {
  const titles = [...(await sharedDecks(lecture)).values()].flat().map((l) => l.title);
  return [...new Set(titles)];
}

/** Which deck and page a lecture-wide slide number is. */
export function locate(decks: Deck[], slide: number): { deck: Deck; page: number } | null {
  const deck = decks.find((d) => slide >= d.first && slide < d.first + d.pages);
  return deck ? { deck, page: slide - deck.first + 1 } : null;
}

/** The slide numbers that can be shown as pictures, as [first, last] ranges. */
export function pictured(decks: Deck[]): Array<[number, number]> {
  return decks.filter((d) => d.pdf && d.pages > 0).map((d) => [d.first, d.first + d.pages - 1]);
}

/** One slide as a PNG, rendered on first request and cached. Null when it can't be shown. */
export async function slidePng(lectureId: string, slide: number): Promise<Buffer | null> {
  const at = locate(await lectureDecks(lectureId), slide);
  if (!at || !at.deck.pdf) return null;
  return pagePng(lectureId, at.deck, at.page);
}

/** Where a page's picture is kept once drawn. */
function pngPath(lectureId: string, materialId: string, page: number): string {
  return path.join(materialsDir(), lectureId, "slides", materialId, `${page}.png`);
}

/** A page's picture as a file, drawn first if it never was — for engines that take image files. */
export async function pagePngFile(
  lectureId: string,
  deck: { materialId: string; file: string },
  page: number,
): Promise<string> {
  const file = pngPath(lectureId, deck.materialId, page);
  if (!(await readFile(file).then(() => true, () => false))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await renderPage(deck.file, page));
  }
  return file;
}

export async function pagePng(lectureId: string, deck: Deck, page: number): Promise<Buffer> {
  const cached = pngPath(lectureId, deck.materialId, page);
  const hit = await readFile(cached).catch(() => null);
  if (hit) return hit;
  const png = await renderPage(deck.file, page);
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, png);
  return png;
}

type Unpdf = typeof import("unpdf");
type PDFDocumentProxy = Awaited<ReturnType<Unpdf["getDocumentProxy"]>>;

// Drawing a page with a picture on it makes the PDF engine load the canvas itself, so
// both are loaded as they ship rather than bundled (lib/runtime-import.ts).
const unpdf = () => importAtRuntime<Unpdf>("unpdf");
const canvas = () => importAtRuntime<typeof import("@napi-rs/canvas")>("@napi-rs/canvas");

// Opening a PDF parses the whole file; keep the last few open for the next page.
const open = new Map<string, Promise<PDFDocumentProxy>>();

async function document(file: string): Promise<PDFDocumentProxy> {
  let doc = open.get(file);
  if (!doc) {
    doc = (async () => {
      const { getDocumentProxy } = await unpdf();
      return getDocumentProxy(new Uint8Array(await readFile(file)));
    })();
    doc.catch(() => open.delete(file));
    open.set(file, doc);
    while (open.size > 4) open.delete(open.keys().next().value!);
  }
  return doc;
}

export async function renderPage(file: string, page: number): Promise<Buffer> {
  const { renderPageAsImage } = await unpdf();
  const png = await renderPageAsImage(await document(file), page, { canvasImport: canvas, width: WIDTH });
  return Buffer.from(png);
}

async function countPdfPages(file: string): Promise<number> {
  return (await document(file)).numPages;
}

/** Part of a slide's picture, for a summary that shows only the bit that matters. */
export async function cropPng(png: Buffer, crop: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const { createCanvas, loadImage } = await canvas();
  const image = await loadImage(png);
  const sx = Math.round(crop.x * image.width);
  const sy = Math.round(crop.y * image.height);
  const sw = Math.max(1, Math.min(image.width - sx, Math.round(crop.w * image.width)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.round(crop.h * image.height)));
  const out = createCanvas(sw, sh);
  out.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toBuffer("image/png");
}
