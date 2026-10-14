import type { FeedbackItem } from "@/lib/feedback";
import { dateInput, longDate } from "@/lib/format";
import { plainInline } from "@/lib/summary-edit";

/**
 * After marking: a short sheet of what to write into your notes — the facts you got
 * wrong (stated correctly) and the ones you left out — built from the marking itself,
 * so it costs no extra AI call. Pure and client-safe.
 */

export interface NotesSheetInput {
  lectureTitle: string;
  sittingDate: Date | string;
  /** In LAQ order. */
  responses: Array<{
    number: number;
    /** Markdown, as stored on the question. */
    stem: string;
    /** null while it is still being marked. */
    mark: number | null;
    /** feedbackFor(response).items */
    items: FeedbackItem[];
    /** AI marking's concept-tagged gaps; empty for pasted marking. */
    gaps: Array<{ type: string; text: string; concept: string }>;
    /** Submitted with nothing written: the whole marking guide was missed. */
    blank?: boolean;
    /** The marking guide's points, used for an answer left blank. */
    guide?: string[];
  }>;
}

export interface NotesSection {
  heading: string;
  /** A concept from AI marking, or one question ("LAQ 2 — …") from pasted marking. */
  by: "concept" | "question";
  /** The LAQs these points came from. */
  from: number[];
  /** What was wrong, as the correct fact. Copied first. */
  wrong: string[];
  /** What was left out. */
  missed: string[];
}

export interface NotesSheet {
  sections: NotesSection[];
  /** For Notion, Obsidian and anything else that reads Markdown. "" when there is nothing to copy. */
  markdown: string;
  /** For pasting anywhere else. "" when there is nothing to copy. */
  plain: string;
  /** Points on the sheet. */
  count: number;
}

export const WRONG_MARK = "✗";
export const MISSED_MARK = "+";

const STEM_WORDS = 8;
const BLANK_TEXT = /^left blank\.?$/i;
/** Pasted marking often says what went well without a label; that is not for the sheet. */
const PRAISE = /^(?:good|great|well done|nice|excellent|solid|strong|clear|correct|accurate|covered|you got|you correctly)\b/i;
/** The marker's "(1/2)" on a partly earned point; the sheet is facts, not scores. */
const PART_SCORE = /\s*\(\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*\)\s*:\s*/;

export function buildNotesSheet(input: NotesSheetInput): NotesSheet {
  const groups = new Map<string, NotesSection>();
  const group = (key: string, heading: string, number: number) => {
    let g = groups.get(key);
    if (!g) {
      g = { heading, by: key.startsWith("concept:") ? "concept" : "question", from: [], wrong: [], missed: [] };
      groups.set(key, g);
    }
    if (!g.from.includes(number)) g.from.push(number);
    return g;
  };

  for (const r of input.responses) {
    if (r.mark === null) continue;
    const laqKey = `laq:${r.number}`;
    const laqHeading = `LAQ ${r.number} — ${stemOpening(r.stem)}`;

    // AI marking: the gaps are the wrong/missed items, tagged with what they are about.
    const gaps = r.gaps.filter((g) => isGap(g.type) && tidy(g.text));
    if (gaps.length > 0) {
      for (const gap of gaps) {
        const name = tidy(gap.concept) || laqHeading;
        const g = group(`concept:${name.toLowerCase()}`, name, r.number);
        (gap.type.toUpperCase() === "WRONG" ? g.wrong : g.missed).push(tidy(gap.text));
      }
      continue;
    }

    if (r.blank) {
      const guide = (r.guide ?? []).map(tidy).filter(Boolean);
      const g = group(laqKey, laqHeading, r.number);
      if (guide.length) g.missed.push(...guide);
      else g.missed.push("Left blank — learn this one from the marking guide.");
      continue;
    }

    const wrong = r.items.filter((i) => i.kind === "wrong").map((i) => tidy(i.text));
    const missed = r.items.filter((i) => i.kind === "missed" && !BLANK_TEXT.test(i.text.trim())).map((i) => tidy(i.text));
    // A note earns a place only when it is all the marking says about lost marks.
    if (!wrong.some(Boolean) && !missed.some(Boolean) && r.mark < 10) {
      for (const i of r.items) {
        const text = tidy(i.text.replace(PART_SCORE, " — "));
        if (i.kind === "note" && text && !PRAISE.test(text)) missed.push(text);
      }
    }
    if (!wrong.some(Boolean) && !missed.some(Boolean)) continue;
    const g = group(laqKey, laqHeading, r.number);
    g.wrong.push(...wrong.filter(Boolean));
    g.missed.push(...missed.filter(Boolean));
  }

  // The same fact from two questions (or two concepts) goes down once, where it first appears.
  const seen = new Set<string>();
  const once = (list: string[]) =>
    list.filter((text) => {
      const k = factKey(text);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const sections: NotesSection[] = [];
  for (const g of groups.values()) {
    const wrong = once(g.wrong);
    const missed = once(g.missed);
    if (wrong.length || missed.length) sections.push({ ...g, wrong, missed });
  }

  const count = sections.reduce((n, s) => n + s.wrong.length + s.missed.length, 0);
  if (count === 0) return { sections, markdown: "", plain: "", count };

  const title = `Notes to copy — ${input.lectureTitle.trim() || "Lecture"}, ${longDate(input.sittingDate)}`;
  const key = `${WRONG_MARK} had it wrong — the correct fact · ${MISSED_MARK} missed — add it`;

  const md: string[] = [`## ${title}`, "", `*${key}*`];
  const plain: string[] = [title, key];
  for (const s of sections) {
    md.push("", `### ${s.heading}`, "");
    plain.push("", plainInline(s.heading));
    for (const t of s.wrong) {
      md.push(`- ${WRONG_MARK} ${t}`);
      plain.push(`${WRONG_MARK} ${plainInline(t)}`);
    }
    for (const t of s.missed) {
      // "- + …" would be read as a list inside a list; escaped, it shows as "+".
      md.push(`- \\${MISSED_MARK} ${t}`);
      plain.push(`${MISSED_MARK} ${plainInline(t)}`);
    }
  }
  return { sections, markdown: `${md.join("\n")}\n`, plain: `${plain.join("\n")}\n`, count };
}

/** A file name for the downloaded sheet, safe on Windows and macOS. */
export function notesFileName(lectureTitle: string, sittingDate: Date | string): string {
  const name = lectureTitle
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  return `${name || "Lecture"} — notes ${dateInput(sittingDate)}.md`;
}

/** "LAQ 2 — A 54-year-old woman presents with polyuria and…": enough to know which. */
export function stemOpening(stem: string): string {
  const text = plainInline(stem.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/gm, ""));
  const words = text.split(" ").filter(Boolean);
  if (words.length <= STEM_WORDS) return text || "Question";
  return `${words.slice(0, STEM_WORDS).join(" ").replace(/[\s,;:.\-–—(]+$/, "")}…`;
}

function isGap(type: string): boolean {
  return /^(?:wrong|missed)$/i.test(type.trim());
}

/** One line, no stray bullet the marker left at the front. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-*•·]|\d{1,2}[.)])\s+/, "");
}

/** Case, accents, punctuation and spacing ignored: "GLUT-4 moves to the membrane." ≈ "glut4 moves to the membrane". */
function factKey(s: string): string {
  return plainInline(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
