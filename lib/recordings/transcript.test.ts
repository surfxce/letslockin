import { describe, expect, it } from "vitest";

import { applyFixes, formatTranscript, parseTimedLines, pieces, stamp, vocabulary } from "@/lib/recordings/transcript";
import { measureHours } from "@/lib/parse";

describe("recording transcripts", () => {
  it("writes times as caption transcripts do", () => {
    expect(stamp(0)).toBe("[00:00]");
    expect(stamp(425.9)).toBe("[07:05]");
    expect(stamp(3723)).toBe("[1:02:03]");
  });

  it("reads timed lines from an AI that listened, moved on by the part's start", () => {
    const text = [
      "Here is the transcript:",
      "```",
      "[00:00] Good morning everyone.",
      "[00:07] Today, the glomerulus.",
      "which filters the blood",
      "**[01:02]** - IgA deposits in the mesangium.",
      "(1:00:05) Last point.",
      "```",
    ].join("\n");
    expect(parseTimedLines(text, 1200)).toEqual([
      { start: 1200, text: "Good morning everyone." },
      { start: 1207, text: "Today, the glomerulus. which filters the blood" },
      { start: 1262, text: "IgA deposits in the mesangium." },
      { start: 4805, text: "Last point." },
    ]);
  });

  it("groups segments into timed paragraphs that measure the lecture", () => {
    const segments = Array.from({ length: 120 }, (_, i) => ({ start: i * 30, text: `Point ${i}.` }));
    const text = formatTranscript(segments, 60);
    expect(text.split("\n\n")[0]).toBe("[00:00] Point 0. Point 1.");
    expect(text).toContain("[59:00] Point 118. Point 119.");
    expect(measureHours(text)).toBe(1);
  });

  it("finds the slides' technical words, most used first", () => {
    const words = vocabulary(["Glomerulonephritis and IgA. glomerulonephritis again. The podocytes, TGF-beta and C3 and Henoch-Schönlein"]);
    expect(words[0]).toBe("Glomerulonephritis");
    expect(words).toEqual(expect.arrayContaining(["IgA", "podocytes", "TGF-beta", "C3"]));
    expect(words).not.toContain("again");
  });

  it("corrects misheard words as whole words, phrases first", () => {
    const { text, applied } = applyFixes("[00:01] The glow Merula filter. Glow merula again, and a glowing lamp. [00:09] I G A.", [
      { heard: "glow merula", correct: "glomerulus" },
      { heard: "I G A", correct: "IgA" },
      { heard: "glow", correct: "glomerulus" },
      { heard: "00:09", correct: "nothing" },
      { heard: "a", correct: "a" },
    ]);
    expect(text).toBe("[00:01] The glomerulus filter. Glomerulus again, and a glowing lamp. [00:09] IgA.");
    expect(applied).toBe(2);
  });

  it("splits a long transcript between paragraphs", () => {
    const text = ["a".repeat(50), "b".repeat(50), "c".repeat(50)].join("\n\n");
    expect(pieces(text, 110)).toEqual([`${"a".repeat(50)}\n\n${"b".repeat(50)}`, "c".repeat(50)]);
  });
});
