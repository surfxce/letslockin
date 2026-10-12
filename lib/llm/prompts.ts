import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConceptRef,
  DigestInput,
  GenerateQuestionsInput,
  MarkInput,
  ParsePastPaperInput,
} from "@/lib/llm/provider";
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

export type PromptName = "digest-lecture" | "generate-questions" | "mark" | "parse-past-paper";

function conceptTable(concepts: ConceptRef[]): string {
  if (concepts.length === 0) return "(none yet)";
  return concepts.map((c) => `- ${c.id} :: ${c.name} — ${c.definition}`).join("\n");
}

export function digestVars(input: DigestInput): Record<string, string> {
  return {
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
