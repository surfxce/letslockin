import { describe, expect, it } from "vitest";

import { cleanTerm, findTermRanges, MAX_TERM } from "./glossary";

const pick = (text: string, terms: string[]) =>
  findTermRanges(text, terms).map((r) => [text.slice(r.start, r.end), r.index]);

describe("cleanTerm", () => {
  it("trims what a drag picks up at the edges", () => {
    expect(cleanTerm("  insulin   resistance.\n")).toBe("insulin resistance");
    expect(cleanTerm("“GLUT4”,")).toBe("GLUT4");
    expect(cleanTerm("(beta-cells)")).toBe("beta-cells");
    expect(cleanTerm("x".repeat(MAX_TERM + 50))).toHaveLength(MAX_TERM);
  });
});

describe("findTermRanges", () => {
  it("finds every occurrence, ignoring case and line breaks", () => {
    const text = "Insulin rises. Then insulin\nresistance develops, and INSULIN falls.";
    expect(pick(text, ["insulin"])).toEqual([
      ["Insulin", 0],
      ["insulin", 0],
      ["INSULIN", 0],
    ]);
    expect(pick(text, ["insulin resistance"])).toEqual([["insulin\nresistance", 0]]);
  });

  it("prefers the longer of two overlapping terms", () => {
    const text = "Insulin resistance blunts insulin action.";
    expect(pick(text, ["insulin", "insulin resistance"])).toEqual([
      ["Insulin resistance", 1],
      ["insulin", 0],
    ]);
  });

  it("matches whole words only", () => {
    expect(pick("GLUT21 and GLUT2 and xGLUT2", ["GLUT2"])).toEqual([["GLUT2", 0]]);
  });

  it("copes with punctuation and symbols in a term", () => {
    expect(pick("Na+/K+ ATPase pumps; the Na+/K+ ATPase (again)", ["Na+/K+ ATPase"])).toHaveLength(2);
    expect(pick("Ca²⁺ enters", ["Ca²⁺"])).toEqual([["Ca²⁺", 0]]);
  });

  it("ignores empty terms", () => {
    expect(findTermRanges("anything", ["", "  "])).toEqual([]);
  });
});
