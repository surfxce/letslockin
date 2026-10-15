import { Node, type JSONContent, type MarkdownToken } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";

import { markerCrops, slideNumbers, slidePictureUrl, type SlideImages } from "@/lib/markdown";
import { plainInline } from "@/lib/summary-edit";

/**
 * Pictures in a summary, as the editor holds them. A summary shows a slide with a line
 * like `![Fed-state map](slide:7)`; the editor must give that line back exactly as it
 * found it, so each picture keeps its own Markdown (`raw`) and is written back from it
 * untouched. A picture on a line of its own is a block (`slideFigure`) that previews
 * the slide the way the read view does; one inside a sentence stays inline
 * (`inlineImage`).
 */

export interface ImageAttrs {
  /** The link destination as written, e.g. "slide:7-8" or "https://…/a.png". */
  src: string;
  /** The caption as written, Markdown and all. */
  alt: string;
  title: string | null;
  /** The picture's Markdown exactly as it was in the summary, when it came from there. */
  raw: string | null;
}

/** Marks the angle brackets prepareImages added, so they can be taken off again. */
const MARK = "\uE000";

/**
 * "](slide 7)" with a space is not an image to a Markdown parser; lib/markdown.ts puts
 * angle brackets round it before rendering. The editor does the same, marked so the
 * brackets come off again and the line goes back as the student wrote it.
 */
export function prepareImages(md: string): string {
  return md.replace(
    /(!\[[^\]]*\]\()\s*((?:slides?|pages?)\b[^)<>\n"]*?\s[^)<>\n"]*?)\s*("[^"\n]*")?\s*\)/gi,
    (whole: string, open: string, ref: string, title?: string) =>
      // `slide:3 "Title"` only looked spaced because of its title, and parses as it is.
      /\s/.test(ref.trim()) ? `${open}<${MARK}${ref.trim()}>${title ? ` ${title}` : ""})` : whole,
  );
}

/** Takes prepareImages' brackets back out of text they ended up in (a code span, say). */
export function unprepare(text: string): string {
  return text.includes(MARK) ? text.replace(/<\uE000([^>]*)>/g, "$1") : text;
}

export function attrsFromToken(token: MarkdownToken): ImageAttrs {
  const raw = unprepare(String(token.raw ?? "")).trim();
  return {
    src: String(token.href ?? "").replace(MARK, ""),
    alt: String(token.text ?? ""),
    title: typeof token.title === "string" && token.title ? token.title : null,
    raw: raw || null,
  };
}

/** A picture's Markdown: exactly what it was, or written fresh for one made in the editor. */
export function imageMarkdown(attrs: Partial<ImageAttrs>): string {
  if (attrs.raw) return attrs.raw;
  const src = attrs.src ?? "";
  const dest = /[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, "")}>` : src;
  const title = attrs.title ? ` "${attrs.title.replace(/"/g, "'")}"` : "";
  return `![${(attrs.alt ?? "").replace(/([[\]])/g, "\\$1")}](${dest}${title})`;
}

/** The same test lib/markdown.ts uses: a real picture, rather than a slide or a caption. */
const isPicture = (src: string) => /^(?:https?:|data:image\/|\/)/i.test(src);

function slideLabel(numbers: number[] | null): string {
  if (!numbers) return "";
  return numbers.length === 1 ? ` · slide ${numbers[0]}` : ` · slides ${numbers[0]}–${numbers[numbers.length - 1]}`;
}

/** What a picture shows: a real picture, the slides that can be shown, or nothing but its caption. */
export function figureParts(attrs: ImageAttrs, slides?: SlideImages) {
  const caption = plainInline(attrs.alt);
  if (isPicture(attrs.src)) return { kind: "picture" as const, caption, pictures: [attrs.src], label: "" };
  const numbers = slideNumbers(attrs.src);
  const shown = (numbers ?? []).filter((n) => slides?.ranges.some(([a, b]) => n >= a && n <= b));
  return {
    kind: shown.length ? ("slides" as const) : ("missing" as const),
    caption,
    pictures: slides ? shown.map((n) => slidePictureUrl(slides.base, n, markerCrops(attrs.src).get(n))) : [],
    label: slideLabel(numbers),
  };
}

const dataAttrs = (attrs: ImageAttrs) => ({
  "data-md-image": "",
  "data-src": attrs.src,
  "data-alt": attrs.alt,
  ...(attrs.title ? { "data-title": attrs.title } : {}),
  ...(attrs.raw ? { "data-raw": attrs.raw } : {}),
});

const attrsFromDom = (el: HTMLElement): ImageAttrs => ({
  src: el.getAttribute("data-src") ?? "",
  alt: el.getAttribute("data-alt") ?? "",
  title: el.getAttribute("data-title"),
  raw: el.getAttribute("data-raw"),
});

const IMAGE_ATTRIBUTES = {
  src: { default: "", rendered: false },
  alt: { default: "", rendered: false },
  title: { default: null, rendered: false },
  raw: { default: null, rendered: false },
};

function figureSpec(attrs: ImageAttrs, slides?: SlideImages): DOMOutputSpec {
  const parts = figureParts(attrs, slides);
  const caption: DOMOutputSpec = ["figcaption", {}, parts.caption || "Slide", ["span", {}, parts.label]];
  if (parts.kind === "missing") {
    return ["figure", { class: "slide-fig missing ed-figure", ...dataAttrs(attrs) }, caption];
  }
  const multi = parts.pictures.length > 1 ? " multi" : "";
  return [
    "figure",
    { class: `slide-fig${multi} ed-figure`, ...dataAttrs(attrs) },
    ...parts.pictures.map((src): DOMOutputSpec => ["img", { src, alt: parts.caption, loading: "lazy", draggable: "false" }]),
    caption,
  ];
}

/** A picture on a line of its own: a slide preview that can be moved or deleted, not typed into. */
export const SlideFigure = Node.create<{ slides?: SlideImages }>({
  name: "slideFigure",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { slides: undefined };
  },

  addAttributes() {
    return IMAGE_ATTRIBUTES;
  },

  parseHTML() {
    return [{ tag: "figure[data-md-image]", getAttrs: (el) => attrsFromDom(el as HTMLElement) }];
  },

  renderHTML({ node }) {
    return figureSpec(node.attrs as ImageAttrs, this.options.slides);
  },

  addNodeView() {
    const slides = this.options.slides;
    return ({ node }) => {
      const attrs = node.attrs as ImageAttrs;
      const parts = figureParts(attrs, slides);
      const dom = document.createElement("figure");
      dom.className = `slide-fig ed-figure${parts.kind === "missing" ? " missing" : parts.pictures.length > 1 ? " multi" : ""}`;
      for (const src of parts.pictures) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = parts.caption;
        img.loading = "lazy";
        img.draggable = false;
        // A slide that can't be drawn shows its caption alone, as in the read view.
        img.addEventListener("error", () => {
          img.remove();
          if (!dom.querySelector("img")) dom.className = "slide-fig missing ed-figure";
        });
        dom.append(img);
      }
      const caption = document.createElement("figcaption");
      caption.textContent = parts.caption || "Slide";
      const label = document.createElement("span");
      label.textContent = parts.kind === "picture" ? "" : parts.label;
      caption.append(label);
      const md = document.createElement("code");
      md.className = "ed-figure-md";
      md.textContent = imageMarkdown(attrs);
      caption.append(md);
      dom.append(caption);
      dom.title = "A slide picture — drag to move it, or select it and press Delete to remove it";
      return { dom };
    };
  },

  renderMarkdown(node: JSONContent) {
    return imageMarkdown((node.attrs ?? {}) as ImageAttrs);
  },
});

/**
 * A picture inside a sentence. Markdown's "image" token always arrives here first;
 * normaliseDoc turns the ones standing on their own into a SlideFigure.
 */
export const InlineImage = Node.create({
  name: "inlineImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return IMAGE_ATTRIBUTES;
  },

  parseHTML() {
    return [{ tag: "span[data-md-image]", getAttrs: (el) => attrsFromDom(el as HTMLElement) }];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as ImageAttrs;
    const caption = plainInline(attrs.alt) || "picture";
    const numbers = isPicture(attrs.src) ? null : slideNumbers(attrs.src);
    return ["span", { class: "ed-inline-img", ...dataAttrs(attrs) }, `▣ ${caption}${slideLabel(numbers)}`];
  },

  markdownTokenName: "image",

  parseMarkdown(token: MarkdownToken, helpers) {
    return helpers.createNode("inlineImage", attrsFromToken(token));
  },

  renderMarkdown(node: JSONContent) {
    return imageMarkdown((node.attrs ?? {}) as ImageAttrs);
  },
});
