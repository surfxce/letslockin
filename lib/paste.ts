/**
 * Copy-and-paste mode: the user runs the prompts in any AI chat and pastes the
 * replies back. Chat replies arrive in every shape — Markdown from a copy button,
 * plain text from a selection, a friendly preamble, a sign-off — so these parsers
 * look for structure loosely and never throw. What they return is shown as a live
 * preview before anything is saved, so a bad parse is visible, not silent.
 */

const PREAMBLE = /^(?:sure|certainly|of course|absolutely|great|okay|ok|here(?:'s| is| are)|below (?:is|are))\b/i;
const SIGN_OFF =
  /^(?:let me know|would you like|do you want|i can also|if you(?:'d| would) like|happy to|hope this helps|feel free|want me to|good luck)\b/i;

function normalise(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Drops a chatty first line ("Here's your summary:") and closing offer ("Let me know…"). */
function stripChat(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1 && PREAMBLE.test(paragraphs[0]) && paragraphs[0].length < 240) {
    paragraphs.shift();
  }
  while (paragraphs.length > 1 && SIGN_OFF.test(paragraphs[paragraphs.length - 1].replace(/^[*_]+/, ""))) {
    paragraphs.pop();
  }
  return paragraphs.join("\n\n").replace(/\n-{3,}\s*$/, "").trim();
}

function unbold(s: string): string {
  return s.replace(/\*\*|__/g, "").trim();
}

// ---------------------------------------------------------------------------
// Summary

export interface ParsedSummary {
  /** The lecture's title, when the reply opens with a "# Title" heading. */
  title: string | null;
  markdown: string;
}

export function parseSummary(raw: string): ParsedSummary {
  let text = stripChat(normalise(raw));
  let title: string | null = null;

  const first = text.match(/^#\s+(.+)\n?/);
  if (first) {
    title = unbold(first[1])
      .replace(/^(?:summary|lecture summary)\s*[:\-–—]\s*/i, "")
      .replace(/^lecture\s+\d+\s*[:\-–—]\s*/i, "")
      .trim();
    text = text.slice(first[0].length).trim();
  }
  return { title: title || null, markdown: text };
}

// ---------------------------------------------------------------------------
// LAQs

export interface ParsedCriterion {
  point: string;
  marks: number | null;
}

export interface ParsedLaq {
  number: number;
  stem: string;
  marks: number | null;
  criteria: ParsedCriterion[];
  modelAnswer: string | null;
}

/** "### LAQ 1", "**Question 2:** Explain…", "Q3 (10 marks)", "Long-answer question 4". */
const QUESTION_HEADER =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:LAQ|Q|Question|Long[- ]answer question)\s*#?\s*(\d{1,2})\b\s*(?:\*\*|__)?\s*[:.)\-–—]?\s*(?:\*\*|__)?\s*(.*)$/i;
const NUMBERED = /^(?:\*\*)?(\d{1,2})[.)]\s+(.*)$/;

const SECTION_LABEL =
  "(marking (?:guide|criteria|scheme|points|rubric)|rubric|mark(?:ing)? allocation|key points|model answer|sample answer|suggested answer|ideal answer|example answer|answer)";
/** "### Model answer", "**Marking guide:** …" — formatted, so anything may follow. */
const SECTION_FORMATTED = new RegExp(
  `^\\s*(?:#{1,6}\\s*|\\*\\*|__)(?:\\*\\*|__)?\\s*${SECTION_LABEL}\\s*(?:\\*\\*|__)?\\s*:?\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  "i",
);
/** "Model answer:" or a bare "Rubric" line. Without formatting, a colon or line end is
 *  required, so "Answer the following…" in a question stays part of the question. */
const SECTION_PLAIN = new RegExp(`^\\s*${SECTION_LABEL}\\s*(?::\\s*(.*))?$`, "i");

function sectionOf(line: string): RegExpMatchArray | null {
  return line.match(SECTION_FORMATTED) ?? line.match(SECTION_PLAIN);
}

const MARKS_IN_TEXT =
  /\s*[([]\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)?\s*[)\]]\s*$|\s*[-–—:]\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)\s*$/i;
const MARKS_PREFIX = /^\s*[([]?\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)\s*[)\]]?\s*[:\-–—]\s*/i;
const BULLET = /^\s*(?:[-*•▪●○]|\d{1,2}[.)]|[a-h][.)])\s+/i;

function splitMarks(text: string): { text: string; marks: number | null } {
  const suffix = text.match(MARKS_IN_TEXT);
  if (suffix) {
    return { text: text.slice(0, suffix.index).trim(), marks: Number(suffix[1] ?? suffix[2]) };
  }
  const prefix = text.match(MARKS_PREFIX);
  if (prefix) return { text: text.slice(prefix[0].length).trim(), marks: Number(prefix[1]) };
  return { text: text.trim(), marks: null };
}

export function parseLaqs(raw: string): ParsedLaq[] {
  const lines = stripChat(normalise(raw)).split("\n");

  // Where each question starts. Prefer explicit "LAQ n" headers; fall back to a
  // top-level numbered list; failing both, the whole paste is one question.
  let starts = lines
    .map((line, i) => ({ i, m: line.match(QUESTION_HEADER) }))
    .filter((s): s is { i: number; m: RegExpMatchArray } => !!s.m);
  if (starts.length === 0) {
    starts = lines
      .map((line, i) => ({ i, m: line.match(NUMBERED) }))
      .filter((s): s is { i: number; m: RegExpMatchArray } => !!s.m);
  }
  const blocks =
    starts.length > 0
      ? starts.map((s, n) => ({
          number: Number(s.m[1]),
          head: s.m[2] ?? "",
          body: lines.slice(s.i + 1, n + 1 < starts.length ? starts[n + 1].i : lines.length),
        }))
      : [{ number: 1, head: "", body: lines }];

  const out: ParsedLaq[] = [];
  for (const block of blocks) {
    // The header line may carry marks ("LAQ 1 (10 marks)"), a topic ("LAQ 1 — Cardiac
    // output"), or the whole question ("LAQ 1: Explain…").
    const head = splitMarks(unbold(block.head));
    const stem: string[] = [];
    const criteria: ParsedCriterion[] = [];
    const answer: string[] = [];
    let section: "stem" | "criteria" | "answer" = "stem";

    for (const line of block.body) {
      const heading = sectionOf(line);
      if (heading) {
        section = /answer/i.test(heading[1]) ? "answer" : "criteria";
        const inline = unbold(heading[2] ?? "");
        if (inline && section === "answer") answer.push(inline);
        else if (inline) {
          const point = splitMarks(inline);
          criteria.push({ point: point.text, marks: point.marks });
        }
        continue;
      }
      if (section === "stem") stem.push(line);
      else if (section === "answer") answer.push(line);
      else if (line.trim()) {
        const point = splitMarks(unbold(line.replace(BULLET, "")));
        if (point.text) criteria.push({ point: point.text, marks: point.marks });
      }
    }

    const body = splitMarks(stem.join("\n").replace(/^\s*-{3,}\s*$/gm, "").trim());
    const isTopic = head.text && body.text && head.text.length < 100 && !/[?.]$/.test(head.text);
    const text = isTopic
      ? `**${head.text}**\n\n${body.text}`
      : [head.text, body.text].filter(Boolean).join("\n");
    if (!text) continue;
    out.push({
      number: block.number,
      stem: text,
      marks: body.marks ?? head.marks,
      criteria,
      modelAnswer: answer.join("\n").replace(/^\s*-{3,}\s*$/gm, "").trim() || null,
    });
  }

  // Renumber when the source numbering is missing or repeats, so "LAQ n" stays unique.
  const numbers = out.map((q) => q.number);
  if (new Set(numbers).size !== numbers.length) out.forEach((q, i) => (q.number = i + 1));
  return out;
}

// ---------------------------------------------------------------------------
// Scores

export type FeedbackKind = "missed" | "wrong" | "good" | "note";

export interface ParsedScore {
  number: number;
  /** Out of ten, whatever the source used. */
  mark: number;
  /** As written, e.g. "7/10" or "14 out of 20". */
  raw: string;
  feedback: Array<{ kind: FeedbackKind; text: string }>;
}

const SCORE = /(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/i;
const NUMBERED_SCORE = /^\s*(?:\*\*)?(\d{1,2})\s*[:.)\-–—]\s*(?:\*\*)?\s*(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/i;
const TOTAL = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:total|overall|geometric|average|mean|final score)\b/i;

const KIND_LABELS: Array<[FeedbackKind, RegExp]> = [
  ["missed", /^(?:missed|missing|omitted|not covered|left out|what you missed|gaps?)\b/i],
  ["wrong", /^(?:wrong|incorrect|errors?|inaccura\w*|mistakes?|misconceptions?)\b/i],
  ["good", /^(?:good|strengths?|strong|correct|well done|what you did well|covered|you got)\b/i],
];

function kindOf(text: string): { kind: FeedbackKind | null; rest: string } {
  const plain = unbold(text);
  for (const [kind, re] of KIND_LABELS) {
    const m = plain.match(re);
    if (m) return { kind, rest: plain.slice(m[0].length).replace(/^\s*(?:\(s\))?\s*[:\-–—]\s*/, "").trim() };
  }
  return { kind: null, rest: plain };
}

export function parseScores(raw: string): ParsedScore[] {
  const lines = stripChat(normalise(raw)).split("\n");
  const out: ParsedScore[] = [];
  let current: { number: number; score: ParsedScore | null } | null = null;
  let kind: FeedbackKind = "note";

  const setScore = (number: number, got: number, of: number, raw: string) => {
    if (!(of > 0)) return null;
    const mark = Math.max(0, Math.min(10, Math.round((got / of) * 10 * 100) / 100));
    const score: ParsedScore = { number, mark, raw, feedback: [] };
    out.push(score);
    return score;
  };

  for (const line of lines) {
    if (!line.trim() || TOTAL.test(line)) continue;

    const header = line.match(QUESTION_HEADER);
    const numbered = header ? null : line.match(NUMBERED_SCORE);
    if (header || numbered) {
      const number = Number((header ?? numbered)![1]);
      current = { number, score: null };
      kind = "note";
      const s = numbered ? [numbered[0], numbered[2], numbered[3]] : line.match(SCORE);
      if (s) current.score = setScore(number, Number(s[1]), Number(s[2]), `${s[1]}/${s[2]}`);
      continue;
    }
    if (!current) continue;

    // A score on its own line under the header: "**Score:** 7/10".
    if (!current.score) {
      const s = line.match(SCORE);
      if (s && /score|mark|grade|result|awarded|\d\s*\//i.test(line)) {
        current.score = setScore(current.number, Number(s[1]), Number(s[2]), `${s[1]}/${s[2]}`);
        continue;
      }
    }
    if (!current.score) continue;

    const bare = line.replace(/^\s*(?:#{1,6}\s*)?/, "");
    const isBullet = BULLET.test(bare);
    const label = kindOf(bare.replace(BULLET, ""));
    if (!isBullet && label.kind && !label.rest) {
      kind = label.kind; // a sub-heading such as "**Missed:**"
      continue;
    }
    const text = (label.kind ? label.rest : unbold(bare.replace(BULLET, ""))).trim();
    if (text) current.score.feedback.push({ kind: label.kind ?? kind, text });
  }

  return out;
}
