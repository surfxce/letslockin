import { describe, expect, it } from "vitest";
import { allocate, priority } from "./allocation";

const c = (conceptId: string, mastery: number, y = 0.5) => ({ conceptId, mastery, yield: y });

describe("priority", () => {
  it("gives an untested concept the full weight", () => {
    expect(priority(c("a", 0))).toBe(10);
  });

  it("drops a mastered concept out entirely", () => {
    expect(priority(c("a", 10))).toBe(0);
  });

  it("keeps a low-yield weakness above zero, because of the 0.5 floor", () => {
    expect(priority(c("a", 2, 0))).toBeGreaterThan(0);
  });

  it("prefers the weaker of two equally likely concepts", () => {
    expect(priority(c("weak", 3))).toBeGreaterThan(priority(c("strong", 8)));
  });

  it("prefers the more examinable of two equally weak concepts", () => {
    expect(priority(c("hot", 4, 1))).toBeGreaterThan(priority(c("cold", 4, 0)));
  });
});

describe("allocate", () => {
  it("spends the lecture's budget on the highest-priority concepts first", () => {
    const out = allocate([c("weak", 1), c("mid", 5), c("strong", 9)], 2);
    expect(out.map((a) => a.conceptId)).toEqual(["weak", "mid"]);
    expect(out.every((a) => a.count === 1)).toBe(true);
  });

  it("only doubles up once every concept has a question", () => {
    const out = allocate([c("weak", 1), c("mid", 5)], 3);
    expect(out.reduce((n, a) => n + a.count, 0)).toBe(3);
    expect(out.find((a) => a.conceptId === "weak")!.count).toBe(2);
  });

  it("never asks about a concept that is already at ten", () => {
    expect(allocate([c("done", 10), c("weak", 2)], 4).map((a) => a.conceptId)).toEqual(["weak"]);
  });

  it("returns nothing when there is no budget or nothing to ask", () => {
    expect(allocate([c("a", 0)], 0)).toEqual([]);
    expect(allocate([], 4)).toEqual([]);
  });
});
