import type {
  DigestInput,
  GenerateQuestionsInput,
  LlmProvider,
  MarkInput,
} from "@/lib/llm/provider";
import type { Digest, Marking, PaperItems, QuestionSet } from "@/lib/llm/schemas";

/**
 * A stand-in that returns plausible, deterministic output after a short delay, so the
 * queue, progress display and every screen can be exercised without the Claude CLI.
 * Set LOCKIN_PROVIDER=fake. It never pretends to understand the lecture: titles and
 * concepts are lifted from the text, and marks follow answer length.
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  lastPromptVersion = "fake@0";

  constructor(private readonly delayMs = Number(process.env.LOCKIN_FAKE_DELAY_MS ?? 1500)) {}

  private wait() {
    return new Promise((r) => setTimeout(r, this.delayMs));
  }

  async digest(input: DigestInput): Promise<Digest> {
    await this.wait();
    const sentences = input.transcript
      .replace(/\[(?:\d+:)?\d{2}:\d{2}\]/g, "")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 30);
    const phrases = keyPhrases(sentences.join(" ")).slice(0, 6);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return {
      title: input.titleIsPlaceholder
        ? phrases.slice(0, 2).map(cap).join(" & ") || "Untitled lecture"
        : input.currentTitle,
      skipped: [],
      summaryMd: [
        "## Key points",
        ...sentences.slice(0, 6).map((s) => `- ${s}`),
        "",
        "## In more detail",
        sentences.slice(6, 12).join(" ") || "(The fake provider only repeats the transcript.)",
      ].join("\n"),
      concepts: phrases.map((phrase) => {
        const name = cap(phrase);
        const existing = input.existingConcepts.find((c) => c.name.toLowerCase() === phrase);
        return {
          existingId: existing?.id ?? null,
          name,
          definition: sentences.find((s) => s.toLowerCase().includes(phrase)) ?? `${name}, as covered in this lecture.`,
          sourceRef: null,
        };
      }),
    };
  }

  async generateQuestions(input: GenerateQuestionsInput): Promise<QuestionSet> {
    await this.wait();
    const byId = new Map(input.concepts.map((c) => [c.id, c]));
    return {
      questions: input.allocation.flatMap(({ conceptId, count }) =>
        Array.from({ length: count }, (_, i) => {
          const c = byId.get(conceptId)!;
          return {
            stem:
              i === 0
                ? `Explain ${c.name} and why it matters in this lecture.`
                : `Using an example, describe how ${c.name} would change under different conditions.`,
            type: input.type,
            conceptIds: [conceptId],
            rubric: {
              modelAnswer: c.definition,
              criteria: [
                { point: `Defines ${c.name} accurately`, marks: 4 },
                { point: "Explains the mechanism in the lecturer's terms", marks: 4 },
                { point: "Gives a relevant example", marks: 2 },
              ],
              totalMarks: 10 as const,
            },
          };
        }),
      ),
    };
  }

  async mark(input: MarkInput): Promise<Marking> {
    await this.wait();
    const words = input.answerText.trim().split(/\s+/).filter(Boolean).length;
    const mark = Math.min(10, Math.round(words / 6));
    const concept = input.concepts[0];
    return {
      mark,
      criteria: [
        { point: "Coverage", awarded: Math.min(6, Math.round(mark * 0.6)), outOf: 6, note: null },
        { point: "Accuracy", awarded: mark - Math.min(6, Math.round(mark * 0.6)), outOf: 4, note: null },
      ],
      gaps:
        concept && mark < 8
          ? [{ conceptId: concept.id, type: "MISSED" as const, text: concept.definition }]
          : [],
    };
  }

  async parsePastPaper(): Promise<PaperItems> {
    await this.wait();
    return { items: [] };
  }
}

const STOP = new Set(
  "the and that this with from have for are was but not you your our they them then than when what which there their about into just also only some more most very will would could should been being does doing done like make sure know right okay today time thing things want going really here where because other first second next quick much many each every both lot lots get gets got way ways one two three four come comes".split(" "),
);

/** The transcript's most repeated two-word terms, then single words: a crude stand-in for "topics". */
function keyPhrases(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
  const count = (items: string[]) => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const bigrams = words
    .slice(1)
    .map((w, i) => [words[i], w] as const)
    .filter(([a, b]) => !STOP.has(a) && !STOP.has(b))
    .map(([a, b]) => `${a} ${b}`);
  const singles = words.filter((w) => !STOP.has(w) && w.length > 4);
  const picked = count(bigrams).slice(0, 4);
  for (const w of count(singles)) {
    if (picked.length >= 8) break;
    if (!picked.some((p) => p.includes(w))) picked.push(w);
  }
  return picked;
}
