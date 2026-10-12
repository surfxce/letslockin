import { describe, expect, it } from "vitest";
import { laqPrompt, markingPrompt, SCORE_FORMAT, summaryPrompt } from "./offline";
import { parseScores } from "./paste";
import { lectureSources } from "./sources";

const sources = { transcript: "[00:00] The lac operon…", slidesText: "--- Slide 4 ---\nlacZ", skipped: [] };

describe("copy-and-paste prompts", () => {
  it("numbers new LAQs after the ones already saved, so pasted scores match", () => {
    expect(laqPrompt({ count: 2, firstNumber: 3, sources })).toContain("Number them LAQ 3 to LAQ 4");
    expect(laqPrompt({ count: 1, firstNumber: 1, sources })).toContain("1 long-answer exam question (LAQ)");
  });

  it("asks for the reply format the score box parses", () => {
    // The parsers and these prompts must change together; this is the contract.
    const reply = SCORE_FORMAT.replace("<number>", "2")
      .replace("<mark>", "7")
      .replace(/<[^>]+>/g, "a fact");
    expect(parseScores(reply)).toEqual([
      {
        number: 2,
        mark: 7,
        raw: "7/10",
        feedback: [
          { kind: "good", text: "a fact" },
          { kind: "missed", text: "a fact" },
          { kind: "wrong", text: "a fact" },
        ],
      },
    ]);
  });

  it("carries the lecture, and tells the chat to ignore module aims", () => {
    const prompt = summaryPrompt({ durationHours: 1, sources });
    expect(prompt).toContain("The lac operon");
    expect(prompt).toMatch(/Ignore the module's aims/);
  });

  it("puts each answer under its own LAQ number for marking", () => {
    const prompt = markingPrompt({
      lectureTitle: "Lac operon",
      items: [{ number: 3, stem: "Explain CAP.", rubric: { criteria: [{ point: "cAMP binds CAP", marks: 4 }] }, answer: "" }],
    });
    expect(prompt).toContain("### LAQ 3");
    expect(prompt).toContain("- cAMP binds CAP (4 marks)");
    expect(prompt).toContain("(left blank)");
  });
});

describe("lectureSources", () => {
  it("strips aims from slides but leaves the transcript whole", () => {
    const out = lectureSources([
      { kind: "TRANSCRIPT", extractedText: "[00:00] the aims of this module are…" },
      { kind: "SLIDES", extractedText: "--- Slide 1 ---\nLearning objectives\n\n--- Slide 2 ---\nlacZ" },
    ]);
    expect(out.transcript).toContain("the aims of this module");
    expect(out.slidesText).toBe("--- Slide 2 ---\nlacZ");
    expect(out.skipped).toEqual([{ what: "Learning objectives", where: "slide 1" }]);
  });

  it("falls back to slides alone, and refuses a lecture with no text", () => {
    expect(lectureSources([{ kind: "SLIDES", extractedText: "--- Slide 2 ---\nlacZ" }]).transcript).toContain("lacZ");
    expect(() => lectureSources([{ kind: "TRANSCRIPT", extractedText: "  " }])).toThrow(/no transcript or slides/);
  });
});
