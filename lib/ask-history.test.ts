import { describe, expect, it } from "vitest";

import { askDraftKey, chosenSection, END_OF_SUMMARY, formatWait, mergeHistory, type AskHistoryItem } from "./ask-history";

const item = (id: string, question: string, answer: string, at: string): AskHistoryItem => ({
  id,
  question,
  answer,
  section: null,
  at,
});

describe("mergeHistory", () => {
  it("puts this visit's questions with the saved ones, newest first", () => {
    const saved = [item("a", "What is GLUT4?", "A transporter.", "2026-10-13T10:00:00Z")];
    const session = [item("s1", "Why insulin?", "Because.", "2026-10-14T09:00:00Z")];
    expect(mergeHistory([session, saved]).map((h) => h.id)).toEqual(["s1", "a"]);
  });

  it("lists a question once when it comes back from the server under another id", () => {
    const session = [item("s1", "Why  insulin?", "Because.\n", "2026-10-14T09:00:00Z")];
    const saved = [item("job1", "Why insulin?", "Because.", "2026-10-14T09:00:02Z")];
    const out = mergeHistory([session, saved]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("s1");
  });

  it("drops repeats by id", () => {
    const a = item("a", "Q", "A", "2026-10-13T10:00:00Z");
    expect(mergeHistory([[a], [{ ...a, answer: "edited" }]])).toEqual([a]);
  });

  it("leaves out the answer already on screen", () => {
    const saved = [item("a", "Q1", "A1", "2026-10-13T10:00:00Z"), item("b", "Q2", "A2", "2026-10-12T10:00:00Z")];
    expect(mergeHistory([saved], { question: " Q1", answer: "A1 " }).map((h) => h.id)).toEqual(["b"]);
  });

  it("keeps the given order for items without a usable time", () => {
    const out = mergeHistory([[item("x", "1", "1", ""), item("y", "2", "2", "nonsense")]]);
    expect(out.map((h) => h.id)).toEqual(["x", "y"]);
  });
});

describe("chosenSection", () => {
  const headings = ["Insulin", "Glucagon secretion", "Summary"];

  it("defaults to the suggested heading, matched loosely", () => {
    expect(chosenSection(headings, "Insulin")).toBe("Insulin");
    expect(chosenSection(headings, "glucagon  Secretion")).toBe("Glucagon secretion");
  });

  it("falls back to the end of the summary", () => {
    expect(chosenSection(headings, null)).toBe(END_OF_SUMMARY);
    expect(chosenSection(headings, "Not a heading")).toBe(END_OF_SUMMARY);
    expect(chosenSection([], "Insulin")).toBe(END_OF_SUMMARY);
  });

  it("follows the student's pick while that heading exists", () => {
    expect(chosenSection(headings, "Insulin", "Summary")).toBe("Summary");
    expect(chosenSection(headings, "Insulin", END_OF_SUMMARY)).toBe(END_OF_SUMMARY);
    expect(chosenSection(headings, "Insulin", "Removed heading")).toBe("Insulin");
  });
});

describe("formatWait", () => {
  it("counts seconds, then minutes", () => {
    expect(formatWait(-50)).toBe("0s");
    expect(formatWait(12_400)).toBe("12s");
    expect(formatWait(65_000)).toBe("1m 05s");
    expect(formatWait(600_000)).toBe("10m 00s");
  });
});

describe("askDraftKey", () => {
  it("is per lecture and prefixed", () => {
    expect(askDraftKey("abc")).toBe("lockin.askDraft.abc");
  });
});
