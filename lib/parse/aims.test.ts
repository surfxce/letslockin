import { describe, expect, it } from "vitest";
import { isAimsSection, mergeSkipped, stripAims } from "./aims";

describe("isAimsSection", () => {
  it("recognises the labels courses actually use", () => {
    expect(isAimsSection("Module 3 aims\n• Describe gene regulation")).toBe(true);
    expect(isAimsSection("Learning objectives")).toBe(true);
    expect(isAimsSection("Intended Learning Outcomes: students will…")).toBe(true);
    expect(isAimsSection("Week 2 objectives - explain the cardiac cycle")).toBe(true);
    expect(isAimsSection("Today's outcomes")).toBe(true);
    expect(isAimsSection("Aims and objectives • Outline the lac operon")).toBe(true);
  });

  it("handles pptx text where the heading runs into the body", () => {
    expect(
      isAimsSection("Learning objectives By the end of this lecture you should be able to explain X"),
    ).toBe(true);
    expect(isAimsSection("By the end of this lecture you should be able to: describe Y")).toBe(true);
  });

  it("only drops a bare 'Aims' slide when it reads like a list of aims", () => {
    expect(isAimsSection("Aims\n• Describe the lac operon\n• Explain CAP")).toBe(true);
    // An experiment's aim is lecture content, not module boilerplate.
    expect(isAimsSection("Aim: to test whether lactose induces lacZ in E. coli")).toBe(false);
  });

  it("keeps content that merely starts with the same word", () => {
    expect(isAimsSection("Objectives of antibiotic therapy: eradicate the organism")).toBe(false);
    expect(isAimsSection("Outcome measures in randomised trials")).toBe(false);
    expect(isAimsSection("Module 3: Gene expression")).toBe(false);
    expect(isAimsSection("The lac operon has three structural genes")).toBe(false);
  });
});

describe("stripAims", () => {
  const deck = [
    "--- Slide 1 ---\nBIOL3010 Genetics",
    "--- Slide 2 ---\nModule 3 aims • Describe prokaryotic gene regulation • Explain operons",
    "--- Slide 3 ---\nLearning objectives By the end of this lecture you should be able to explain CAP",
    "--- Slide 4 ---\nThe lac operon: lacZ, lacY, lacA",
  ].join("\n\n");

  it("drops aims slides and reports where they were", () => {
    const { text, skipped } = stripAims(deck);
    expect(text).toContain("Slide 1");
    expect(text).toContain("The lac operon");
    expect(text).not.toContain("Module 3 aims");
    expect(text).not.toContain("Learning objectives");
    expect(skipped).toEqual([
      {
        what: "Module 3 aims",
        where: "slide 2",
        about: "Module 3 aims • Describe prokaryotic gene regulation • Explain operons",
      },
      {
        what: "Learning objectives",
        where: "slide 3",
        about: "Learning objectives By the end of this lecture you should be able to explain CAP",
      },
    ]);
  });

  it("works on PDF pages and exported 'Slide N:' notes", () => {
    expect(stripAims("--- Page 1 ---\nLearning outcomes\n\n--- Page 2 ---\nContent").skipped).toEqual([
      { what: "Learning outcomes", where: "page 1", about: "Learning outcomes" },
    ]);
    expect(stripAims("Slide 1: Learning objectives\nSlide 2: Allolactose").text).toBe(
      "Slide 2: Allolactose",
    );
  });

  it("drops a Markdown aims section up to the next heading of the same level", () => {
    const md = "# Lac operon\nintro\n## Learning objectives\n- explain X\n### detail\nmore\n## Regulation\nbody";
    const { text, skipped } = stripAims(md);
    expect(text).toBe("# Lac operon\nintro\n## Regulation\nbody");
    expect(skipped).toEqual([{ what: "Learning objectives", where: "section", about: "- explain X\n### detail\nmore" }]);
  });

  it("leaves text with no structure alone", () => {
    const transcript = "[00:00] So the aims of this module are to understand operons";
    expect(stripAims(transcript)).toEqual({ text: transcript, skipped: [] });
  });
});

describe("mergeSkipped", () => {
  it("folds repeats of the same label into one entry", () => {
    expect(
      mergeSkipped([
        { what: "Module aims", where: "slide 2" },
        { what: "Module aims", where: "slide 3" },
      ]),
    ).toEqual([{ what: "Module aims", where: "slides 2, 3" }]);
  });
});
