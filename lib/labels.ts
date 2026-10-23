/**
 * Where the labels are on a picture: the words text recognition finds, grouped into
 * labels — a run of words on one line with no wide gap — so cover-up cards can start
 * with a box already over each. Boxes are fractions of the picture (0–1).
 */

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Lines of words (as tesseract gives them) to label boxes. */
export function groupLabels(lines: OcrWord[][], width: number, height: number): LabelBox[] {
  const out: LabelBox[] = [];
  for (const line of lines) {
    const words = line.filter((w) => w.confidence >= 50 && /[\p{L}\p{N}]/u.test(w.text) && w.bbox.x1 > w.bbox.x0);
    if (!words.length) continue;
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const tall = median(words.map((w) => w.bbox.y1 - w.bbox.y0));
    let run: OcrWord[] = [];
    const flush = () => {
      if (!run.length) return;
      const text = run.map((w) => w.text).join(" ").trim();
      // A whole sentence is body text, not a label; one stray character is noise.
      const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
      if (run.length <= 7 && letters >= 2) {
        const x0 = Math.min(...run.map((w) => w.bbox.x0));
        const x1 = Math.max(...run.map((w) => w.bbox.x1));
        const y0 = Math.min(...run.map((w) => w.bbox.y0));
        const y1 = Math.max(...run.map((w) => w.bbox.y1));
        const pad = Math.max(2, (y1 - y0) * 0.25);
        const box = {
          x: Math.max(0, (x0 - pad) / width),
          y: Math.max(0, (y0 - pad) / height),
          w: Math.min(width, x1 + pad) / width - Math.max(0, (x0 - pad) / width),
          h: Math.min(height, y1 + pad) / height - Math.max(0, (y0 - pad) / height),
          text,
        };
        out.push(box);
      }
      run = [];
    };
    for (const w of words) {
      const last = run[run.length - 1];
      // A gap wider than about one and a half letters' height starts a new label.
      if (last && w.bbox.x0 - last.bbox.x1 > tall * 1.6) flush();
      run.push(w);
    }
    flush();
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 1;
}

type Recognizer = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
let shared: { worker: Promise<Recognizer>; timer: NodeJS.Timeout | null } | null = null;

/** One recognizer kept warm between requests, let go after a quiet minute. */
async function recognizer(): Promise<Recognizer> {
  if (!shared) {
    const start = async () => {
      const { createWorker } = await import("tesseract.js");
      const eng = (await import("@tesseract.js-data/eng")) as { langPath?: string; default?: { langPath: string } };
      return createWorker("eng", 1, { langPath: eng.default?.langPath ?? eng.langPath, gzip: true, cacheMethod: "none" });
    };
    shared = { worker: start(), timer: null };
  }
  if (shared.timer) clearTimeout(shared.timer);
  const current = shared;
  current.timer = setTimeout(() => {
    if (shared === current) shared = null;
    void current.worker.then((w) => w.terminate()).catch(() => undefined);
  }, 60_000);
  return current.worker;
}

/** The labels on a picture (PNG, JPEG or WebP bytes). */
export async function findLabels(image: Buffer): Promise<LabelBox[]> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  // Read at a size text recognition likes, as PNG whatever came in.
  const picture = await loadImage(image);
  const scale = Math.min(2, Math.max(1, 1400 / Math.max(picture.width, picture.height)));
  const canvas = createCanvas(Math.round(picture.width * scale), Math.round(picture.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  const worker = await recognizer();
  const { data } = await worker.recognize(canvas.toBuffer("image/png"), {}, { blocks: true });
  const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => l.words as OcrWord[])));
  return groupLabels(lines, canvas.width, canvas.height);
}
