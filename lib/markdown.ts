import { marked } from "marked";

/** Where a lecture's slide pictures come from, and which slide numbers have one. */
export interface SlideImages {
  /** e.g. "/api/lectures/<id>/slides" — slide n is `${base}/${n}`. */
  base: string;
  /** [first, last] slide numbers that can be shown, from lib/slides.ts. */
  ranges: Array<[number, number]>;
  /** Puts a Crop button on each slide picture — only on the lecture page's own summary. */
  croppable?: boolean;
  /** For a printed copy: pictures load straight away and aren't links to the slide. */
  print?: boolean;
}

/** The part of a slide a picture shows, as fractions of its width and height. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A crop kept within the slide, and big enough to see; null when it isn't. */
export function cleanCrop(c: Partial<Crop> | null | undefined): Crop | null {
  if (!c) return null;
  const nums = [c.x, c.y, c.w, c.h].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const r = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const x = r(nums[0]);
  const y = r(nums[1]);
  const w = r(Math.min(nums[2], 1 - x));
  const h = r(Math.min(nums[3], 1 - y));
  return w >= 0.02 && h >= 0.02 ? { x, y, w, h } : null;
}

export function formatCrop(c: Crop): string {
  return [c.x, c.y, c.w, c.h].join(",");
}

export function parseCrop(text: string | null | undefined): Crop | null {
  const [x, y, w, h] = (text ?? "").split(",").map(Number);
  return cleanCrop({ x, y, w, h });
}

const CROP_PART = /#crop=([^\s)]*)$/i;

/** The crops a marker carries, by slide: `slide:7-8#crop=7:0.1,0.2,0.5,0.4`. */
export function markerCrops(src: string): Map<number, Crop> {
  let s = src;
  try {
    s = decodeURIComponent(src);
  } catch {
    // Not percent-encoded after all.
  }
  const out = new Map<number, Crop>();
  for (const part of (s.match(CROP_PART)?.[1] ?? "").split(";")) {
    const [n, rect] = part.split(":");
    const crop = parseCrop(rect);
    if (crop && Number.isInteger(Number(n))) out.set(Number(n), crop);
  }
  return out;
}

/** Where a slide's picture is, cropped when it has a crop. */
export function slidePictureUrl(base: string, slide: number, crop?: Crop | null): string {
  return crop ? `${base}/${slide}?crop=${formatCrop(crop)}` : `${base}/${slide}`;
}

/** The most slides one picture marker shows ("slide:7-8" shows both). */
const MAX_PER_FIGURE = 4;

const SLIDE_WORD = String.raw`(?:slides?|pages?|p)\s*[:#._-]?\s*`;
const SLIDE_REF = new RegExp(
  String.raw`^\s*${SLIDE_WORD}(\d{1,3})(?:\s*(?:-|–|—|,|&|\+|to|and)\s*(?:${SLIDE_WORD})?(\d{1,3}))?\s*$`,
  "i",
);

/**
 * The slide numbers a picture marker points at. Models are asked for exactly
 * `slide:12` but also write `Slide:12`, `slide:7-8`, `slides 7 and 8` or `p12`; all of
 * those mean slides, so they are read as such rather than shown as broken images.
 */
export function slideNumbers(src: string): number[] | null {
  let s = src;
  try {
    s = decodeURIComponent(src);
  } catch {
    // Not percent-encoded after all.
  }
  s = s.replace(CROP_PART, "");
  const m = s.match(SLIDE_REF);
  if (!m) return null;
  const first = Number(m[1]);
  const last = m[2] ? Number(m[2]) : first;
  if (first < 1) return null;
  if (last < first || last - first >= MAX_PER_FIGURE) return [first];
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * Summaries are model-generated from the user's own lecture files on a local
 * single-user app, but they are still untrusted text, so strip the handful of
 * things that could execute before they reach dangerouslySetInnerHTML.
 *
 * A summary shows a slide with `![what it shows](slide:12)`. That becomes the slide's
 * picture with its caption — or, when there is no picture of that slide to show (a
 * PowerPoint, or a number past the end), the caption alone. An image pointing at
 * anything else that is not a real address becomes its caption too: a summary never
 * shows a broken image.
 */
export function renderMarkdown(md: string, slides?: SlideImages): string {
  // "](slide 7)" with a space is not an image to a Markdown parser; angle brackets make it one.
  const prepared = md.replace(
    /(!\[[^\]]*\]\()\s*((?:slides?|pages?)\b[^)<>\n"]*?\s[^)<>\n"]*?)\s*("[^"\n]*")?\s*\)/gi,
    (_, open: string, ref: string, title?: string) => `${open}<${ref}>${title ? ` ${title}` : ""})`,
  );
  const html = marked.parse(prepared, { async: false }) as string;
  // Slide pictures are numbered in order, so a crop can find its way back to its marker.
  let figure = -1;
  return html
    .replace(/<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")?\s*\/?>/g, (tag, src: string, alt: string) => {
      if (/^(?:https?:|data:image\/|\/)/i.test(src)) return tag; // a real picture
      const numbers = slideNumbers(src);
      if (numbers) figure++;
      return slideFigure(numbers, alt, slides, numbers ? { index: figure, crops: markerCrops(src) } : undefined);
    })
    // A figure on its own line was wrapped in a paragraph, which can't hold one.
    .replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, "$1");
}

function slideFigure(
  numbers: number[] | null,
  caption: string,
  slides?: SlideImages,
  marker?: { index: number; crops: Map<number, Crop> },
): string {
  const label = !numbers
    ? ""
    : numbers.length === 1
      ? ` <span>· slide ${numbers[0]}</span>`
      : ` <span>· slides ${numbers[0]}–${numbers[numbers.length - 1]}</span>`;
  const shown = (numbers ?? []).filter((n) => slides?.ranges.some(([a, b]) => n >= a && n <= b));
  if (!slides || shown.length === 0) {
    return `<figure class="slide-fig missing"><figcaption>${caption || "Slide"}${label}</figcaption></figure>`;
  }
  const pictures = shown
    .map((n) => {
      const crop = marker?.crops.get(n) ?? null;
      const src = slidePictureUrl(slides.base, n, crop);
      if (slides.print) return `<img src="${src}" alt="${caption}">`;
      const picture = `<a href="${slides.base}/${n}" target="_blank" rel="noopener"><img src="${src}" alt="${caption}" loading="lazy"></a>`;
      if (!slides.croppable || !marker) return picture;
      const button =
        `<button type="button" class="slide-crop" data-fig="${marker.index}" data-slide="${n}" ` +
        `data-crop="${crop ? formatCrop(crop) : ""}" title="Crop this slide">Crop</button>`;
      return `<span class="slide-shot">${picture}${button}</span>`;
    })
    .join("");
  const multi = shown.length > 1 ? " multi" : "";
  return `<figure class="slide-fig${multi}">${pictures}<figcaption>${caption}${label}</figcaption></figure>`;
}

/**
 * Sets (or with null, clears) the crop of one slide in the summary's `figure`-th slide
 * picture, counted in order as renderMarkdown counts them. The marker is rewritten in
 * its plain form, `slide:12#crop=12:x,y,w,h`. Null when that picture isn't there or
 * doesn't show that slide.
 */
export function setFigureCrop(md: string, figure: number, slide: number, crop: Crop | null): string | null {
  let k = -1;
  let inFence = false;
  let found = false;
  const out = md
    .split("\n")
    .map((line) => {
      if (/^ {0,3}(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/(`+)[\s\S]*?\1|(!\[[^\]]*\]\()([^)]*)\)/g, (whole, tick?: string, open?: string, inner?: string) => {
        if (tick || open === undefined || inner === undefined) return whole;
        const title = inner.match(/\s+("[^"]*")\s*$/);
        const ref = (title ? inner.slice(0, title.index) : inner).trim().replace(/^<(.*)>$/, "$1");
        const numbers = slideNumbers(ref);
        if (!numbers) return whole;
        k++;
        if (k !== figure || !numbers.includes(slide)) return whole;
        found = true;
        const crops = markerCrops(ref);
        if (crop) crops.set(slide, crop);
        else crops.delete(slide);
        const plain = numbers.length === 1 ? `slide:${numbers[0]}` : `slide:${numbers[0]}-${numbers[numbers.length - 1]}`;
        const part = crops.size ? `#crop=${[...crops].map(([n, c]) => `${n}:${formatCrop(c)}`).join(";")}` : "";
        return `${open}${plain}${part}${title ? ` ${title[1]}` : ""})`;
      });
    })
    .join("\n");
  return found ? out : null;
}
