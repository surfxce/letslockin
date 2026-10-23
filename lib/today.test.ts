import { describe, expect, it } from "vitest";

import { buildPlan, type PlanLecture } from "@/lib/today";

const now = new Date(2026, 9, 20, 9, 0);
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString();
const lecture = (id: string, over: Partial<PlanLecture> = {}): PlanLecture => ({
  id,
  title: id,
  courseId: "c1",
  courseCode: "BIOM",
  hasSummary: true,
  laqCount: 4,
  lastScore: 7,
  dueAt: day(5),
  sittingSize: 2,
  ...over,
});
const base = { now, budget: 60, examDays: new Map<string, number>(), courseCodes: new Map([["c1", "BIOM"], ["c2", "PHAR"]]), cardsDue: 0, cardsNew: 0, lastExamAt: null };

describe("buildPlan", () => {
  it("puts due cards, then due LAQs (longest overdue first), within the time", () => {
    const plan = buildPlan({
      ...base,
      cardsDue: 60,
      lectures: [lecture("today", { dueAt: day(0) }), lecture("late", { dueAt: day(-3) }), lecture("later", { dueAt: day(4) })],
    });
    expect(plan.items.map((i) => i.id)).toEqual(["cards", "laq:late", "laq:today"]);
    expect(plan.minutes).toBe(10 + 16 + 16);
  });

  it("moves what doesn't fit to later, but always plans something", () => {
    const plan = buildPlan({ ...base, budget: 10, lectures: [lecture("a", { dueAt: day(-1), sittingSize: 3 }), lecture("b", { dueAt: day(-1) })] });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].minutes).toBe(24);
    expect(plan.later.map((i) => i.id)).toEqual(["laq:b"]);
  });

  it("favours the course whose exam is sooner", () => {
    const plan = buildPlan({
      ...base,
      examDays: new Map([["c2", 5]]),
      lectures: [lecture("far", { dueAt: day(-5) }), lecture("soon", { courseId: "c2", courseCode: "PHAR", dueAt: day(-1) })],
    });
    expect(plan.items.map((i) => i.id)).toEqual(["laq:soon", "exam:c2"]);
    expect(plan.later.map((i) => i.id)).toEqual(["laq:far"]);
    expect(plan.exams).toEqual([{ courseId: "c2", code: "PHAR", days: 5 }]);
  });

  it("suggests weak areas and new cards to fill the day, and no exam right after one", () => {
    const plan = buildPlan({
      ...base,
      budget: 120,
      examDays: new Map([["c1", 20]]),
      lastExamAt: new Date(now.getTime() - 2 * 86_400_000),
      cardsNew: 50,
      lectures: [lecture("weak", { lastScore: 3.2 }), lecture("fine", { lastScore: 8 }), lecture("raw", { hasSummary: false })],
    });
    expect(plan.items.map((i) => i.id)).toEqual(["weak:weak", "new-cards"]);
    expect(plan.items[1].title).toBe("Learn 20 new AK cards");
    expect(plan.unprepared).toBe(1);
  });

  it("puts a waiting mini-lesson before a weak lecture's whole sitting", () => {
    const plan = buildPlan({
      ...base,
      lectures: [lecture("weak", { lastScore: 3.2 })],
      lessons: [{ id: "l1", concept: "Mesangial IgA", courseId: "c1", gapCount: 3 }],
    });
    expect(plan.items.map((i) => i.id)).toEqual(["lesson:l1", "weak:weak"]);
    expect(plan.items[0]).toMatchObject({ kind: "lesson", href: "/lessons/l1", minutes: 5, title: "Mini-lesson: Mesangial IgA" });
  });

  it("is empty when nothing is due", () => {
    expect(buildPlan({ ...base, lectures: [lecture("x")] }).items).toEqual([]);
  });
});
