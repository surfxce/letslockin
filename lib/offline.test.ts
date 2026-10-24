import { describe, expect, it } from "vitest";
import { laqPrompt, markingPrompt, SCORE_FORMAT, summaryPrompt } from "./offline";
import { parseScores } from "./paste";
import { lectureSources, readSlideNotes, slideNotesText } from "./sources";

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

describe("copy-and-paste prompts with slides", () => {
  const slides = {
    decks: [
      { name: "A4-A5 slides.pdf", first: 1, pages: 30, pdf: true },
      { name: "extra.pptx", first: 31, pages: 4, pdf: false },
    ],
    sharedWith: ["Appetite and Satiety Part 2"],
  };

  it("asks for the PDFs to be attached and read, and for slide pictures in a summary", () => {
    const prompt = summaryPrompt({ durationHours: 1, sources, slides });
    expect(prompt).toContain("I've attached the slides: A4-A5 slides.pdf (slides 1–30).");
    expect(prompt).not.toContain("extra.pptx");
    expect(prompt).toContain("![<what it shows>](slide:<number>)");
    expect(prompt).toContain('shared with another lecture ("Appetite and Satiety Part 2")');
  });

  it("keeps LAQs to this lecture's part of a shared deck, without asking for pictures", () => {
    const prompt = laqPrompt({ count: 2, firstNumber: 1, sources, slides });
    expect(prompt).toContain("ask about only that part");
    expect(prompt).not.toContain("(slide:<number>)");
  });

  it("says nothing about slides when there are none", () => {
    expect(summaryPrompt({ durationHours: 1, sources })).not.toContain("attached");
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
    expect(out.skipped).toEqual([expect.objectContaining({ what: "Learning objectives", where: "slide 1" })]);
  });

  it("falls back to slides alone, and refuses a lecture with no text", () => {
    expect(lectureSources([{ kind: "SLIDES", extractedText: "--- Slide 2 ---\nlacZ" }]).transcript).toContain("lacZ");
    expect(() => lectureSources([{ kind: "TRANSCRIPT", extractedText: "  " }])).toThrow(/no transcript or slides/);
  });

  it("numbers slides across decks, in upload order, as the slide pictures are", () => {
    const out = lectureSources([
      { kind: "TRANSCRIPT", extractedText: "[00:00] hello" },
      { kind: "SLIDES", id: "b", createdAt: new Date(2), pageCount: 2, extractedText: "--- Page 1 ---\nSatiety" },
      { kind: "SLIDES", id: "a", createdAt: new Date(1), pageCount: 3, extractedText: "--- Page 2 ---\nGhrelin" },
    ]);
    expect(out.slidesText).toBe("--- Slide 2 ---\nGhrelin\n\n--- Slide 4 ---\nSatiety");
  });

  it("takes a deck of pictures with no text, for a model that can see it", () => {
    const out = lectureSources([{ kind: "SLIDES", pageCount: 12, extractedText: "" }]);
    expect(out.transcript).toMatch(/work from the slides/);
  });
});

describe("slide notes", () => {
  it("reads only well-formed notes", () => {
    expect(readSlideNotes('[{"slide":2,"notes":" Ghrelin "},{"slide":"x","notes":"no"},{"slide":3,"notes":""}]')).toEqual([
      { slide: 2, notes: "Ghrelin" },
    ]);
    expect(readSlideNotes("not json")).toEqual([]);
    expect(slideNotesText([{ slide: 2, notes: "Ghrelin" }])).toBe("--- Slide 2 ---\nGhrelin");
  });
});
