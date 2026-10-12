import { describe, expect, it } from "vitest";
import { parseLaqs, parseScores, parseSummary } from "./paste";

describe("parseSummary", () => {
  it("takes the title from a leading heading and drops chat filler", () => {
    const out = parseSummary(
      "Here's a summary of the lecture:\n\n# The lac operon & CAP\n\n## Structure\nThree genes.\n\nLet me know if you'd like flashcards!",
    );
    expect(out.title).toBe("The lac operon & CAP");
    expect(out.markdown).toBe("## Structure\nThree genes.");
  });

  it("strips 'Summary:' style prefixes from the title", () => {
    expect(parseSummary("# Summary: Cardiac cycle\n\nbody").title).toBe("Cardiac cycle");
    expect(parseSummary("# Lecture 4: Cardiac cycle\n\nbody").title).toBe("Cardiac cycle");
  });

  it("keeps plain text as it is when there is no heading", () => {
    expect(parseSummary("The operon is induced by allolactose.")).toEqual({
      title: null,
      markdown: "The operon is induced by allolactose.",
    });
  });
});

describe("parseLaqs", () => {
  it("reads the format the copy-paste prompt asks for", () => {
    const text = `Sure! Here are your long-answer questions.

### LAQ 1 (10 marks)
Explain how the lac operon responds when glucose is absent and lactose is present.

**Marking guide**
- Repressor released by allolactose (2 marks)
- cAMP high, CAP bound upstream (3 marks)
- Full transcription of lacZYA [3]
- Correct link to diauxic growth — 2 marks

**Model answer**
With lactose present, allolactose binds the repressor…

### LAQ 2 (10 marks)
Compare inducible and repressible operons using lac and trp.

**Marking guide**
- Default states differ (5 marks)
- Effector roles (5 marks)

**Model answer**
Lac is off by default…`;
    const out = parseLaqs(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      number: 1,
      marks: 10,
      stem: "Explain how the lac operon responds when glucose is absent and lactose is present.",
    });
    expect(out[0].criteria).toEqual([
      { point: "Repressor released by allolactose", marks: 2 },
      { point: "cAMP high, CAP bound upstream", marks: 3 },
      { point: "Full transcription of lacZYA", marks: 3 },
      { point: "Correct link to diauxic growth", marks: 2 },
    ]);
    expect(out[0].modelAnswer).toBe("With lactose present, allolactose binds the repressor…");
    expect(out[1].criteria).toHaveLength(2);
  });

  it("accepts the question on the header line itself", () => {
    const out = parseLaqs("**Question 1:** Describe CAP.\n\n**Question 2:** Explain the trp operon.");
    expect(out.map((q) => q.stem)).toEqual(["Describe CAP.", "Explain the trp operon."]);
  });

  it("turns a header topic into a bold title over the question", () => {
    const out = parseLaqs("## LAQ 1 — Cardiac output\nExplain how preload affects stroke volume.");
    expect(out[0].stem).toBe("**Cardiac output**\n\nExplain how preload affects stroke volume.");
  });

  it("falls back to a numbered list", () => {
    const out = parseLaqs("1. Explain diauxie.\n2. Compare lac and trp.\n   - point one");
    expect(out.map((q) => q.number)).toEqual([1, 2]);
    expect(out[1].stem).toContain("Compare lac and trp.");
  });

  it("does not mistake 'Answer the following' for an answer section", () => {
    const out = parseLaqs("LAQ 1\nAnswer the following with reference to the lac operon.\nModel answer: Allolactose…");
    expect(out[0].stem).toBe("Answer the following with reference to the lac operon.");
    expect(out[0].modelAnswer).toBe("Allolactose…");
  });

  it("treats unstructured text as a single question", () => {
    expect(parseLaqs("Explain the lac operon.")).toEqual([
      { number: 1, stem: "Explain the lac operon.", marks: null, criteria: [], modelAnswer: null },
    ]);
  });
});

describe("parseScores", () => {
  it("reads the format the marking prompt asks for", () => {
    const text = `Here's how you did:

LAQ 1: 7/10
- Good: Correctly named allolactose as the inducer
- Missed: cAMP–CAP is needed for full expression
- Wrong: The repressor binds the promoter, not the operator

LAQ 2: 4/10
- Missed: Trp acts as a corepressor

Overall geometric mean: 5.29/10`;
    const out = parseScores(text);
    expect(out.map((s) => [s.number, s.mark])).toEqual([
      [1, 7],
      [2, 4],
    ]);
    expect(out[0].feedback).toEqual([
      { kind: "good", text: "Correctly named allolactose as the inducer" },
      { kind: "missed", text: "cAMP–CAP is needed for full expression" },
      { kind: "wrong", text: "The repressor binds the promoter, not the operator" },
    ]);
  });

  it("normalises other scales to ten and reads a score on its own line", () => {
    const out = parseScores("### Question 1\n**Score:** 14/20\n\n**Missed:**\n- CAP\n- cAMP\n\n### Question 2\nMark: 3 out of 5");
    expect(out.map((s) => s.mark)).toEqual([7, 6]);
    expect(out[0].raw).toBe("14/20");
    expect(out[0].feedback).toEqual([
      { kind: "missed", text: "CAP" },
      { kind: "missed", text: "cAMP" },
    ]);
  });

  it("accepts a terse list", () => {
    expect(parseScores("1. 8/10\n2) 5.5/10\nQ3 - 9/10").map((s) => s.mark)).toEqual([8, 5.5, 9]);
  });

  it("ignores totals and returns nothing for unrelated text", () => {
    expect(parseScores("Total: 15/20")).toEqual([]);
    expect(parseScores("great job overall")).toEqual([]);
  });
});
