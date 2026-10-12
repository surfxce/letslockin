import { describe, expect, it } from "vitest";
import { dueState, nextReview, rungAfter } from "./schedule";

const day = (d: number, h = 15) => new Date(2026, 2, d, h);

describe("rungAfter", () => {
  it("climbs on a good score, holds on a middling one, resets on a poor one", () => {
    expect(rungAfter(1, 8)).toBe(2);
    expect(rungAfter(2, 6)).toBe(2);
    expect(rungAfter(3, 4.9)).toBe(0);
    expect(rungAfter(4, 10)).toBe(4);
  });
});

describe("nextReview", () => {
  it("has nothing due before there are LAQs to sit", () => {
    expect(nextReview({ sittings: [], readySince: null }).dueAt).toBeNull();
  });

  it("asks for the first sitting the day after the LAQs are ready", () => {
    expect(nextReview({ sittings: [], readySince: day(3) }).dueAt).toEqual(new Date(2026, 2, 4));
  });

  it("spaces reviews out as scores hold up: 3, 7, 14 days", () => {
    const a = nextReview({ sittings: [{ at: day(1), score: 8 }], readySince: day(1) });
    expect(a.dueAt).toEqual(new Date(2026, 2, 4));
    const b = nextReview({
      sittings: [
        { at: day(1), score: 8 },
        { at: day(4), score: 9 },
      ],
      readySince: day(1),
    });
    expect(b.intervalDays).toBe(7);
    expect(b.dueAt).toEqual(new Date(2026, 2, 11));
  });

  it("brings a weak lecture back tomorrow", () => {
    const r = nextReview({
      sittings: [
        { at: day(1), score: 9 },
        { at: day(4), score: 9 },
        { at: day(11), score: 3 },
      ],
      readySince: day(1),
    });
    expect(r.dueAt).toEqual(new Date(2026, 2, 12));
  });

  it("orders sittings by date rather than trusting the input order", () => {
    const r = nextReview({
      sittings: [
        { at: day(11), score: 3 },
        { at: day(1), score: 9 },
      ],
      readySince: day(1),
    });
    expect(r.rung).toBe(0);
  });

  it("pulls a review forward to the day before the exam", () => {
    const r = nextReview({
      sittings: [
        { at: day(1), score: 9 },
        { at: day(4), score: 9 },
        { at: day(11), score: 9 },
      ],
      readySince: day(1),
      examDate: day(15, 9),
    });
    expect(r.dueAt).toEqual(new Date(2026, 2, 14));
  });
});

describe("dueState", () => {
  const now = day(10, 9);
  it("labels a due date against today", () => {
    expect(dueState(new Date(2026, 2, 8), now)).toEqual({ state: "overdue", days: -2 });
    expect(dueState(new Date(2026, 2, 10), now)).toEqual({ state: "today", days: 0 });
    expect(dueState(new Date(2026, 2, 12), now)).toEqual({ state: "soon", days: 2 });
    expect(dueState(new Date(2026, 2, 20), now)).toEqual({ state: "later", days: 10 });
    expect(dueState(null, now)).toEqual({ state: "none", days: null });
  });
});
