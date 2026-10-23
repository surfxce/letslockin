import { describe, expect, it } from "vitest";

import { pickExamItems, shuffle, suggestedMinutes, type ExamCandidate } from "@/lib/exam/pick";

/** A repeatable stand-in for Math.random. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const item = (id: string, lectureId: string, seen = 0, lastMark: number | null = null): ExamCandidate => ({ id, lectureId, seen, lastMark });

describe("pickExamItems", () => {
  const pool = [
    item("a1", "A"), item("a2", "A"), item("a3", "A"),
    item("b1", "B"), item("b2", "B"),
    item("c1", "C"),
  ];

  it("takes one from every lecture before a second from any", () => {
    const picked = pickExamItems(pool, 3, { focus: "mixed", random: seeded(3) });
    expect(new Set(picked.map((id) => id[0])).size).toBe(3);
    const five = pickExamItems(pool, 5, { focus: "mixed", random: seeded(4) });
    expect(five.filter((id) => id.startsWith("c"))).toEqual(["c1"]);
    expect(five.filter((id) => id.startsWith("a"))).toHaveLength(2);
  });

  it("stops at what there is", () => {
    expect(pickExamItems(pool, 50, { focus: "mixed", random: seeded() })).toHaveLength(6);
    expect(pickExamItems(pool, 0, { focus: "mixed" })).toEqual([]);
    expect(pickExamItems([], 4, { focus: "weak" })).toEqual([]);
  });

  it("prefers questions not seen yet", () => {
    const seenOnes = [item("x1", "X", 3, 9), item("x2", "X", 0), item("x3", "X", 1, 4)];
    for (let seed = 1; seed < 20; seed++) {
      expect(pickExamItems(seenOnes, 1, { focus: "mixed", random: seeded(seed) })).toEqual(["x2"]);
    }
  });

  it("aims at the weakest lectures and answers with weak focus", () => {
    const scores = new Map<string, number | null>([["A", 8.5], ["B", 3.2], ["C", null]]);
    const marked = [item("a1", "A", 1, 9), item("b1", "B", 1, 7), item("b2", "B", 1, 2), item("c1", "C")];
    expect(pickExamItems(marked, 2, { focus: "weak", lectureScore: scores, random: seeded(7) })).toEqual(["c1", "b2"]);
  });

  it("brings back a question failed before ahead of a new one with weak focus", () => {
    const list = [item("n1", "N"), item("f1", "N", 1, 0), item("g1", "N", 1, 9)];
    for (let seed = 1; seed < 10; seed++) {
      expect(pickExamItems(list, 3, { focus: "weak", random: seeded(seed) })).toEqual(["f1", "n1", "g1"]);
    }
  });
});

describe("shuffle", () => {
  it("keeps every item", () => {
    expect(shuffle([1, 2, 3, 4, 5], seeded(9)).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("suggestedMinutes", () => {
  it("rounds up to five minutes", () => {
    expect(suggestedMinutes(10, 4)).toBe(75);
    expect(suggestedMinutes(1, 0)).toBe(5);
  });
});
