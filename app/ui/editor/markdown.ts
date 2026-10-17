import { getSchema, type AnyExtension, type JSONContent } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import type { SlideImages } from "@/lib/markdown";
import { plainInline } from "@/lib/summary-edit";

import { InlineImage, prepareImages, SlideFigure, unprepare } from "./images";
import { ListLevels } from "./blocks";

/**
 * Moving a summary between its Markdown and the formatted editor. The editor's own
 * Markdown writer is careful but fussy — it writes `&amp;` for "&" and `\[` for "[" —
 * so what it writes is tidied back towards what a person would type, and every tidy-up
 * is checked to mean exactly the same before it is kept.
 */

/** Everything the formatted editor knows how to hold, without the Markdown extension itself. */
export function summaryExtensions(slides?: SlideImages): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Markdown has no underline: Ctrl+U would make something the summary can't keep.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    TableKit.configure({ table: { resizable: false } }),
    SlideFigure.configure({ slides }),
    InlineImage,
    ListLevels,
  ];
}

// ---------------------------------------------------------------------------
// Parsing

const BLOCK_PARENTS = new Set(["doc", "blockquote", "listItem", "tableCell", "tableHeader"]);
const INLINE = new Set(["text", "hardBreak", "inlineImage"]);

/**
 * The parser leaves a picture that stood on a line of its own as an inline node among
 * blocks (and, rarely, a stray bit of text). Each such picture becomes a slide figure —
 * one per line it stood on, even when two lines were next to each other — and any other
 * stray inline content is wrapped in a paragraph, as the schema needs.
 */
export function normaliseDoc(node: JSONContent): JSONContent {
  if (node.type === "text" && node.text) return { ...node, text: unprepare(node.text) };
  if (!node.content) return node;
  const children = node.content.map(normaliseDoc);
  if (!BLOCK_PARENTS.has(node.type ?? "")) return { ...node, content: children };

  const content: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = () => {
    if (run.length) content.push({ type: "paragraph", content: run });
    run = [];
  };
  for (const child of children) {
    if (child.type === "inlineImage") {
      flush();
      // A list item must start with a line of text, so a picture there stays inline.
      content.push(
        node.type === "listItem" && content.length === 0
          ? { type: "paragraph", content: [child] }
          : { type: "slideFigure", attrs: child.attrs },
      );
    } else if (INLINE.has(child.type ?? "")) {
      run.push(child);
    } else {
      flush();
      content.push(child);
    }
  }
  flush();
  return { ...node, content };
}

/**
 * Builds the document against the schema, filling in whatever a node is missing to be
 * valid (a list item that starts with a heading gets its empty first line). The editor
 * would otherwise take an invalid document as it is and misbehave later.
 */
export function repairDoc(schema: Schema, json: JSONContent): PMNode {
  const build = (j: JSONContent): PMNode | null => {
    try {
      if (j.type === "text") return j.text ? schema.nodeFromJSON(j) : null;
      const type = schema.nodes[j.type ?? ""];
      if (!type) return j.content ? schema.text(plainText(j) || " ") : null;
      const kids = (j.content ?? []).map(build).filter((n): n is PMNode => n !== null);
      const marks = (j.marks ?? []).map((m) => schema.markFromJSON(m));
      const made = type.createAndFill(j.attrs ?? null, kids, marks);
      if (made) return made;
      // Content that can't be fitted: keep its words as plain paragraphs or text.
      const text = kids.map((k) => k.textContent).join(" ").trim();
      if (type.isTextblock) return type.create(j.attrs ?? null, text ? schema.text(text) : null);
      return type.createAndFill(j.attrs ?? null, text ? schema.nodes.paragraph.create(null, schema.text(text)) : null);
    } catch {
      return null;
    }
  };
  const doc = build(json);
  if (doc && doc.type === schema.topNodeType) {
    try {
      doc.check();
      return doc;
    } catch {
      // Fall through to the empty document below.
    }
  }
  return schema.topNodeType.createAndFill()!;
}

function plainText(j: JSONContent): string {
  if (j.text) return j.text;
  return (j.content ?? []).map(plainText).join(" ");
}

// ---------------------------------------------------------------------------
// Writing

const FENCE = /^ {0,3}(```|~~~)/;

/** Applies `fn` to the parts of the Markdown that are not code (fenced blocks or code spans). */
export function outsideCode(md: string, fn: (s: string) => string): string {
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const f = line.match(FENCE);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      let out = "";
      let last = 0;
      for (const m of line.matchAll(/(`+)[^`]*?\1/g)) {
        out += fn(line.slice(last, m.index)) + m[0];
        last = m.index! + m[0].length;
      }
      return out + fn(line.slice(last));
    })
    .join("\n");
}

/** Layout only: no blank-line markers, no runs of blank lines, one newline at the end. */
export function tidyLayout(md: string): string {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const f = line.match(FENCE);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const blank = !line.trim() || /^\s*(?:&nbsp;| )\s*$/.test(line);
    if (blank && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(blank ? "" : line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" };
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ENTITIES[e]);
/** Drops a backslash before any of `chars`, unless the backslash is itself escaped. */
const unescape = (chars: string) => {
  const re = new RegExp(String.raw`(^|[^\\])((?:\\\\)*)\\([${chars.replace(/[\]\\^-]/g, "\\$&")}])`, "g");
  return (s: string) => {
    // Twice, because adjacent escapes share the character the pattern looks behind at.
    const once = s.replace(re, "$1$2$3");
    return once.replace(re, "$1$2$3");
  };
};

/** Tidy-ups to try, most useful first; each is kept only if it changes nothing a reader sees. */
const SIMPLIFY: Array<(s: string) => string> = [
  decodeEntities,
  unescape("~"),
  unescape("[]"),
  unescape("_"),
  unescape("*"),
];

export interface SummaryCodec {
  /** Markdown to an editor document, valid for the schema. */
  parse(md: string): JSONContent;
  /** An editor document back to Markdown, written the way a person would. */
  serialize(doc: JSONContent): string;
  /** What the summary would become after a trip through the formatted editor. */
  roundTrip(md: string): string;
}

export function createCodec(manager: MarkdownManager, schema: Schema): SummaryCodec {
  const read = (md: string) => normaliseDoc(manager.parse(prepareImages(md)));
  const parse = (md: string) => repairDoc(schema, read(md)).toJSON() as JSONContent;
  /** What Markdown means, to compare two ways of writing it. */
  const signature = (md: string) => {
    try {
      return JSON.stringify(read(md));
    } catch {
      return null;
    }
  };
  const serialize = (doc: JSONContent) => {
    let best = tidyLayout(manager.serialize(doc));
    const target = signature(best);
    if (target === null) return best;
    // Usually every tidy-up is safe, and one check settles it.
    const all = SIMPLIFY.reduce((md, step) => outsideCode(md, step), best);
    if (all === best || signature(all) === target) return all;
    for (const step of SIMPLIFY) {
      const next = outsideCode(best, step);
      if (next !== best && signature(next) === target) best = next;
    }
    return best;
  };
  return { parse, serialize, roundTrip: (md) => serialize(parse(md)) };
}

let shared: SummaryCodec | null = null;

/**
 * One codec for every summary, made on first use rather than when the module loads. It
 * needs no editor, so Markdown can be checked before the formatted editor exists.
 */
export function summaryCodec(): SummaryCodec {
  if (!shared) {
    const extensions = summaryExtensions();
    shared = createCodec(
      new MarkdownManager({ extensions, indentation: { style: "space", size: 2 } }),
      getSchema(extensions),
    );
  }
  return shared;
}

// ---------------------------------------------------------------------------
// What a reader would lose

/** The words a reader sees in a summary, in order: Markdown's own marks left out. */
export function summaryWords(md: string): string[] {
  const words: string[] = [];
  let fence: string | null = null;
  for (const raw of md.split("\n")) {
    const f = raw.match(FENCE);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    let line = raw;
    if (!fence) {
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // table rule
      if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|=+)\s*$/.test(line)) continue; // rule or underline
      line = line
        .replace(/^\s*(?:>\s?)*/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/\s+#+\s*$/, "")
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "");
      // A task box is something a reader sees, though it isn't a word.
      const box = line.match(/^\[([ xX])\]\s+/);
      if (box) {
        words.push(box[1] === " " ? "☐" : "☑");
        line = line.slice(box[0].length);
      }
      line = plainInline(decodeEntities(line.replace(/(?<!\\)\|/g, " ")));
    }
    for (const w of line.split(/\s+/)) {
      const word = w.replace(/^[^\p{L}\p{N}☐☑]+|[^\p{L}\p{N}☐☑]+$/gu, "");
      if (word) words.push(word);
    }
  }
  return words;
}

/** Words in `before` that `after` no longer has, counting repeats. */
export function lostWords(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const w of summaryWords(after)) left.set(w, (left.get(w) ?? 0) + 1);
  const lost: string[] = [];
  for (const w of summaryWords(before)) {
    const n = left.get(w) ?? 0;
    if (n > 0) left.set(w, n - 1);
    else lost.push(w);
  }
  return lost;
}
