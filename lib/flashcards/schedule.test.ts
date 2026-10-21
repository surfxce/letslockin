import { describe, expect, it } from "vitest";
import { scheduleCard, intervalLabel, type Schedule } from "./schedule";
import { FlashcardSetSchema, cardText } from "./schema";
const now = new Date("2026-10-20T12:00:00Z");
const fresh: Schedule = { state: "new", intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0 };

describe("AK spaced repetition", () => {
  it("relearns a missed card in one minute and partial recall in five", () => {
    expect(scheduleCard(fresh, 1, now).dueAt.getTime() - +now).toBe(60_000);
    expect(scheduleCard(fresh, 2, now).dueAt.getTime() - +now).toBe(300_000);
  });
  it("graduates good and easy new cards to one and four days", () => {
    expect(scheduleCard(fresh, 3, now)).toMatchObject({ state: "review", intervalDays: 1, repetitions: 1 });
    expect(scheduleCard(fresh, 4, now)).toMatchObject({ state: "review", intervalDays: 4 });
  });
  it("increases intervals in rating order for established cards", () => {
    const card = { ...fresh, state: "review", intervalDays: 10, repetitions: 5 };
    expect([2, 3, 4].map(r => scheduleCard(card, r as 2 | 3 | 4, now).intervalDays)).toEqual([12, 25, 34]);
    expect(scheduleCard(card, 1, now)).toMatchObject({ state: "learning", lapses: 1, ease: 2.3 });
  });
  it("repeated failures do not push ease below 1.3 or count learning as lapses", () => {
    let card = { ...fresh, state: "review", intervalDays: 10 };
    for (let i = 0; i < 30; i++) card = scheduleCard(card, 1, now);
    expect(card.ease).toBe(1.3);
    expect(card.lapses).toBe(1);
    expect(scheduleCard(card, 3, now).intervalDays).toBe(1);
  });
  it("bounds intervals and rejects invalid ratings", () => {
    expect(scheduleCard({ ...fresh, state: "review", intervalDays: 3000 }, 4, now).intervalDays).toBe(3650);
    expect(() => scheduleCard(fresh, 0 as 1, now)).toThrow();
    expect(intervalLabel(1 / 1440)).toBe("1 min");
    expect(intervalLabel(4)).toBe("4 days");
  });
});
describe("flashcard output contract", () => {
  it("requires both sides, limits content and rejects invalid image numbers", () => {
    expect(FlashcardSetSchema.safeParse({ cards: [] }).success).toBe(false);
    expect(FlashcardSetSchema.safeParse({ cards: [{ front: { text: "x", slide: -1 }, back: { text: "y", slide: null } }] }).success).toBe(false);
    expect(FlashcardSetSchema.safeParse({ cards: [{ front: { text: "x", slide: 2 } }] }).success).toBe(false);
  });
  it("keeps images out of model-written text, including reference images", () => {
    expect(cardText('**Answer** ![x](https://example.com/x) ![ref][x] ![shortcut] <img src=x>')).toBe("**Answer**");
    expect(cardText("1 < 2")).toBe("1 &lt; 2");
  });
});
