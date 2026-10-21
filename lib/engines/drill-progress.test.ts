import { describe, expect, it } from "vitest";
import { drillScores } from "./drill-progress";

const answer = (questionId: string, conceptId: string, mark: number) => ({
  questionId, mark, question: { concepts: [{ conceptId }] },
});

describe("drillScores", () => {
  it("lets a weak concept recover as later LAQs replace its old mark", () => {
    const scores = drillScores([
      { responses: [answer("q1", "weak", 0), answer("q2", "strong", 9)] },
      { responses: [answer("q3", "weak", 4)] },
      { responses: [answer("q4", "weak", 9)] },
    ]);
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBe(6);
    expect(scores[2]).toBe(9);
  });

  it("counts unlinked questions and ignores marks still pending", () => {
    expect(drillScores([
      { responses: [{ questionId: "q", mark: 4, question: { concepts: [] } }] },
      { responses: [{ questionId: "q", mark: null, question: { concepts: [] } }] },
    ])).toEqual([4, 4]);
  });

  it("combines multiple LAQs on one concept within a sitting", () => {
    expect(drillScores([{ responses: [answer("q1", "c", 4), answer("q2", "c", 9)] }])).toEqual([6]);
  });
});
