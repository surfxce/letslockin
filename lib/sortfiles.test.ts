import { describe, expect, it } from "vitest";

import { excerptOf } from "./sortfiles";

describe("excerptOf", () => {
  it("reads a deck by the first line of each slide, and counts slides with no text", () => {
    const text = "--- Page 1 ---\nAppetite & Satiety\nDr Lee\n\n--- Page 3 ---\nGhrelin\nrises before meals";
    expect(excerptOf("SLIDES", text, { budget: 500, pages: 4 })).toEqual({
      detail: "slides, 4 pages, 2 without text",
      excerpt: "Appetite & Satiety · Ghrelin",
    });
  });

  it("reads a transcript's opening words without its timing", () => {
    const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nGood morning everyone.\n\n2\n00:00:04.500 --> 00:00:07.000\nToday: appetite.";
    expect(excerptOf("TRANSCRIPT", vtt, { budget: 500, hours: 0.75 })).toEqual({
      detail: "transcript, 45 min",
      excerpt: "Good morning everyone. Today: appetite.",
    });
  });

  it("stays within its budget", () => {
    const { excerpt } = excerptOf("TRANSCRIPT", "word ".repeat(500), { budget: 40 });
    expect(excerpt.length).toBeLessThanOrEqual(40);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
