import { marked } from "marked";

/** Where a lecture's slide pictures come from, and which slide numbers have one. */
export interface SlideImages {
  /** e.g. "/api/lectures/<id>/slides" — slide n is `${base}/${n}`. */
  base: string;
  /** [first, last] slide numbers that can be shown, from lib/slides.ts. */
  ranges: Array<[number, number]>;
}

/**
 * Summaries are model-generated from the user's own lecture files on a local
 * single-user app, but they are still untrusted text, so strip the handful of
 * things that could execute before they reach dangerouslySetInnerHTML.
 *
 * A summary shows a slide with `![what it shows](slide:12)`. That becomes the slide's
 * picture with its caption — or, when there is no picture of that slide to show (a
 * PowerPoint, or a number past the end), the caption alone, so nothing breaks.
 */
export function renderMarkdown(md: string, slides?: SlideImages): string {
  const html = marked.parse(md, { async: false }) as string;
  return html
    .replace(/<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<img src="slide:(\d+)" alt="([^"]*)"(?: title="[^"]*")?\s*\/?>/g, (_, n: string, alt: string) =>
      slideFigure(Number(n), alt, slides),
    )
    // A figure on its own line was wrapped in a paragraph, which can't hold one.
    .replace(/<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>/g, "$1");
}

function slideFigure(n: number, caption: string, slides?: SlideImages): string {
  const label = `slide ${n}`;
  const shown = slides?.ranges.some(([a, b]) => n >= a && n <= b);
  if (!slides || !shown) {
    return `<figure class="slide-fig missing"><figcaption>${caption || "Slide"} <span>· ${label}</span></figcaption></figure>`;
  }
  const src = `${slides.base}/${n}`;
  return (
    `<figure class="slide-fig"><a href="${src}" target="_blank" rel="noopener">` +
    `<img src="${src}" alt="${caption}" loading="lazy"></a>` +
    `<figcaption>${caption} <span>· ${label}</span></figcaption></figure>`
  );
}
