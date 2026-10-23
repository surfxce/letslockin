import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AskInput,
  ConceptRef,
  DigestInput,
  GenerateQuestionsInput,
  MarkInput,
  ParsePastPaperInput,
  SortFilesInput,
} from "@/lib/llm/provider";
import { laqStyleNote } from "@/lib/modes";
import { promptsDir } from "@/lib/paths";

/**
 * Turns a versioned prompt file and a call's input into the text a model sees.
 * Shared by every provider, so Claude and a local model are asked exactly the same
 * thing and their rows carry the same prompt version.
 */

export async function loadPrompt(name: string): Promise<{ text: string; version: string }> {
  // prompts/<name>.<semver>.md — the version is stamped onto every row the reply produces.
  const files = await readdir(promptsDir());
  const matches = files
    .filter((f) => f.startsWith(`${name}.`) && f.endsWith(".md"))
    .sort((a, b) => compareSemver(versionOf(name, b), versionOf(name, a)));
  if (matches.length === 0) throw new Error(`no prompt file for "${name}" in ${promptsDir()}`);
  const file = matches[0];
  return { text: await readFile(path.join(promptsDir(), file), "utf8"), version: versionOf(name, file) };
}

function versionOf(name: string, file: string): string {
  return file.slice(name.length + 1, -".md".length);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export async function renderPrompt(name: PromptName, vars: Record<string, string>) {
  const { text, version } = await loadPrompt(name);
  return { text: fill(text, vars), version: `${name}@${version}` };
}

export type PromptName =
  | "generate-flashcards"
  | "generate-mcqs"
  | "mistake-cards"
  | "paper-guides"
  | "digest-lecture"
  | "generate-questions"
  | "mixed-questions"
  | "transcribe-audio"
  | "fix-transcript"
  | "viva-turn"
  | "write-lesson"
  | "read-handwriting"
  | "mark"
  | "parse-past-paper"
  | "sort-files"
  | "answer-question"
  | "break-down"
  | "left-out";

function conceptTable(concepts: ConceptRef[]): string {
  if (concepts.length === 0) return "(none yet)";
  return concepts.map((c) => `- ${c.id} :: ${c.name} — ${c.definition}`).join("\n");
}

const sharedNote = (titles: string[] | undefined, what: string) =>
  titles?.length
    ? `\nThese slides are shared with ${titles.length === 1 ? "another lecture" : "other lectures"}: ` +
      `${titles.map((t) => `"${t}"`).join(", ")}. This lecture is only the part its transcript covers — ` +
      `${what} only that part, and leave out slides that belong to the other lecture.\n`
    : "";

/**
 * `visual` is set by a provider that shows the model the slides themselves (Claude
 * Code reading the PDFs); only then can it describe what is on them.
 */
export function digestVars(input: DigestInput, opts: { visual?: boolean } = {}): Record<string, string> {
  const pictured = input.slides?.decks.some((d) => d.pdf && d.pages > 0);
  return {
    slidesNote: sharedNote(input.slides?.sharedWith, "summarise and extract concepts for"),
    picturesNote: pictured
      ? `\nWhere a slide's figure, diagram, graph, table or photo would help someone revise — a pathway, a ` +
        `labelled structure, a graph with a trend — show it: put \`![<what it shows>](slide:<number>)\` on a line ` +
        `of its own, right where it belongs, using the slide numbers from the "--- Slide N ---" markers. Choose ` +
        `the few that teach something, about four per hour of lecture at most — never a title slide, a slide of ` +
        `plain text, a logo or a decorative picture.\n`
      : "",
    slideNotesStep: opts.visual
      ? "For every slide this lecture covers, write one or two sentences in `slideNotes`: the words on it, " +
        "including any inside pictures, and what any figure shows (\"Graph: plasma ghrelin peaks just before each " +
        "meal and falls after eating\"). The steps that write and mark exam questions cannot see the slides and " +
        "work from these. Skip title slides, aims and housekeeping, and slides that belong to another lecture."
      : "Leave `slideNotes` as an empty list.",
    currentTitle: input.currentTitle,
    titleNote: input.titleIsPlaceholder
      ? "(That title was made from a filename and is only a placeholder — replace it.)"
      : "(The student chose that title. Return it unchanged unless it is plainly wrong.)",
    durationHours: String(input.durationHours),
    lowerBound: String(Math.round(8 * input.durationHours)),
    upperBound: String(Math.round(20 * input.durationHours)),
    transcript: input.transcript,
    slidesText: input.slidesText ?? "(no slides supplied)",
    existingConcepts: conceptTable(input.existingConcepts),
    alreadySkipped: input.alreadySkipped.length
      ? `\nThese slides were already removed before you saw them and are recorded, so do not list them again:\n` +
        input.alreadySkipped.map((s) => `- ${s.what} (${s.where})`).join("\n")
      : "",
  };
}

export function generateVars(input: GenerateQuestionsInput): Record<string, string> {
  const allocation = input.allocation
    .filter((a) => a.count > 0)
    .map((a) => `- ${a.conceptId}: ${a.count}`)
    .join("\n");
  return {
    scopeNote: sharedNote(input.sharedWith, "ask about"),
    styleNote: laqStyleNote(input.style),
    lectureTitle: input.lectureTitle,
    type: input.type,
    transcript: input.transcript,
    slidesText: input.slidesText ?? "(no slides supplied)",
    concepts: conceptTable(input.concepts),
    allocation: allocation || "(none)",
    total: String(input.allocation.reduce((n, a) => n + a.count, 0)),
  };
}

export function markVars(input: MarkInput): Record<string, string> {
  return {
    questionStem: input.questionStem,
    rubric: JSON.stringify(input.rubric, null, 2),
    answerText: input.answerText,
    concepts: conceptTable(input.concepts),
  };
}

export function paperVars(input: ParsePastPaperInput): Record<string, string> {
  return { paperText: input.paperText, concepts: conceptTable(input.concepts) };
}

export function sortVars(input: SortFilesInput): Record<string, string> {
  return {
    files: input.files
      .map((f) => `[${f.number}] ${f.path} — ${f.detail}\n    ${f.excerpt.replace(/\s+/g, " ").trim() || "(no text)"}`)
      .join("\n"),
  };
}

/** Which prompt a quick question uses, and what fills it. */
export function askVars(input: AskInput): { prompt: PromptName; vars: Record<string, string> } {
  switch (input.kind) {
    case "question":
      return {
        prompt: "answer-question",
        vars: {
          lectureTitle: input.lectureTitle,
          summary: input.summary,
          question: input.question,
          headings: input.headings.length ? input.headings.map((h) => `- ${h}`).join("\n") : "(the summary has no headings)",
        },
      };
    case "breakdown":
      return {
        prompt: "break-down",
        vars: { lectureTitle: input.lectureTitle, summary: input.summary, selection: input.selection },
      };
    case "leftout":
      return {
        prompt: "left-out",
        vars: {
          lectureTitle: input.lectureTitle,
          what: input.what,
          where: input.where || "place not recorded",
          transcript: input.transcript,
          slidesText: input.slidesText ?? "(no slides supplied)",
        },
      };
  }
}
