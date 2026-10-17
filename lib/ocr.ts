import { prisma } from "@/lib/db";
import { lectureDecks, pagePng } from "@/lib/slides";
import { blankPages, cleanOcr, mergePages } from "@/lib/slidetext";

/**
 * Reads the words on slides that are pictures — scanned decks, slides exported as
 * images — with text recognition that runs on this computer, and keeps them in the
 * deck's stored text. For models that can't look at images (the offline ones); Claude
 * reads the pages itself. Each page is read once: one with no words is marked so.
 *
 * Worker only: text recognition runs in worker threads and takes a second or two to
 * start, then a fraction of a second a page.
 */
export async function readSlidePictures(
  lectureId: string,
  hooks: { onStart?: () => Promise<void> | void; onProgress?: (detail: string) => void } = {},
): Promise<{ pages: number; withWords: number }> {
  const decks = (await lectureDecks(lectureId)).filter((d) => d.pdf && d.pages > 0);
  type OcrWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
  let worker: OcrWorker | null = null;
  let pages = 0;
  let withWords = 0;
  try {
    for (const deck of decks) {
      const material = await prisma.material.findUnique({ where: { id: deck.materialId }, select: { extractedText: true } });
      const text = material?.extractedText ?? "";
      const blank = blankPages(text, deck.pages);
      if (blank.length === 0) continue;
      if (!worker) {
        await hooks.onStart?.();
        worker = await startRecognition();
      }
      const read: Array<{ page: number; text: string }> = [];
      for (const [i, page] of blank.entries()) {
        hooks.onProgress?.(`reading words in slide pictures — slide ${deck.first + page - 1} (${i + 1} of ${blank.length})`);
        const { data } = await worker.recognize(await pagePng(lectureId, deck, page));
        read.push({ page, text: cleanOcr(data.text) });
      }
      await prisma.material.update({ where: { id: deck.materialId }, data: { extractedText: mergePages(text, read) } });
      pages += read.length;
      withWords += read.filter((r) => r.text).length;
    }
  } finally {
    await worker?.terminate();
  }
  return { pages, withWords };
}

async function startRecognition() {
  const { createWorker } = await import("tesseract.js");
  // English data ships with the app (an npm package), so nothing is downloaded.
  const eng = (await import("@tesseract.js-data/eng")) as { langPath?: string; default?: { langPath: string } };
  const langPath = eng.default?.langPath ?? eng.langPath;
  return createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none" });
}
