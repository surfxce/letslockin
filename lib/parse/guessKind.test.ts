import { describe, expect, it } from "vitest";
import { guessKind, measureHours } from "./index";

describe("guessKind", () => {
  it("trusts caption extensions outright", () => {
    expect(guessKind("wk7.vtt")).toBe("TRANSCRIPT");
    expect(guessKind("deck.pptx")).toBe("SLIDES");
  });

  it("reads the text when the extension is ambiguous", () => {
    // The bug this exists for: exported slide notes landing as .md and being fed
    // to the pipeline as if they were the lecture itself.
    expect(guessKind("Lec7-slides-notes.md", "# Title\n\nSlide 2: Learning objectives")).toBe(
      "SLIDES",
    );
    expect(guessKind("notes.txt", "--- Slide 4 ---\nAllolactose is the inducer")).toBe("SLIDES");
    expect(guessKind("recording.txt", "[00:12] so the operon has three genes")).toBe(
      "TRANSCRIPT",
    );
  });

  it("falls back to the extension when the text says nothing", () => {
    expect(guessKind("notes.md", "some prose with no structure")).toBe("TRANSCRIPT");
  });
});

describe("measureHours", () => {
  it("reads the run time off the last timestamp", () => {
    expect(measureHours("[00:02] hi\n\n[51:40] bye")).toBe(1);
  });

  it("keeps the hour so a double lecture is not halved", () => {
    expect(measureHours("[00:04] hi\n\n[1:47:30] bye")).toBe(2);
  });

  it("returns null when there is nothing to measure", () => {
    expect(measureHours("no timestamps here")).toBeNull();
    expect(measureHours("[00:10] too short to be a lecture")).toBeNull();
  });
});
