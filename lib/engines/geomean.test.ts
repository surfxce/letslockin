import { describe, expect, it } from "vitest";
import { geometricMean, roundMark } from "./geomean";

describe("geometricMean", () => {
  it("returns the mark itself for a single question", () => {
    expect(geometricMean([7])).toBe(7);
  });

  it("matches the hand-computed square root for two questions", () => {
    expect(geometricMean([4, 9])).toBe(Math.sqrt(4 * 9));
    expect(geometricMean([4, 9])).toBe(6);
  });

  it("cube-roots three questions", () => {
    expect(roundMark(geometricMean([2, 4, 8]))).toBe(4);
  });

  it("punishes an uneven pair harder than the arithmetic mean would", () => {
    // The case the whole system exists for: 0 and 10 averages to 5 but is worth 0.
    expect(geometricMean([0, 10])).toBe(0);
    expect(geometricMean([4, 4])).toBe(4);
    expect(geometricMean([1, 9])).toBeLessThan(5);
  });

  it("rejects empty and negative input", () => {
    expect(() => geometricMean([])).toThrow();
    expect(() => geometricMean([-1, 5])).toThrow();
    expect(() => geometricMean([Number.NaN])).toThrow();
  });
});
