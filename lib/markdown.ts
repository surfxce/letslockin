import { marked } from "marked";

/** Where a lecture's slide pictures come from, and which slide numbers have one. */
export interface SlideImages {
  /** e.g. "/api/lectures/<id>/slides" — slide n is `${base}/${n}`. */
  base: string;
  /** [first, last] slide numbers that can be shown, from lib/slides.ts. */
  ranges: Array<[number, number]>;
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
  return html
    .replace(/<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")?\s*\/?>/g, (tag, src: string, alt: string) => {
      if (/^(?:https?:|data:image\/|\/)/i.test(src)) return tag; // a real picture
      return slideFigure(slideNumbers(src), alt, slides);
    })
    // A figure on its own line was wrapped in a paragraph, which can't hold one.
    .replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, "$1");
}

function slideFigure(numbers: number[] | null, caption: string, slides?: SlideImages): string {
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
      const src = `${slides.base}/${n}`;
      return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${caption}" loading="lazy"></a>`;
    })
    .join("");
  const multi = shown.length > 1 ? " multi" : "";
  return `<figure class="slide-fig${multi}">${pictures}<figcaption>${caption}${label}</figcaption></figure>`;
}
