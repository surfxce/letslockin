import { describe, expect, it } from "vitest";
import { dateFromName, groupFiles, stemOf, titleFromFilename, type GroupInput } from "./group";

const at = new Date(2026, 2, 10, 12);
const f = (relativePath: string, kind = "TRANSCRIPT", measuredHours: number | null = null): GroupInput => ({
  relativePath,
  kind,
  modifiedOn: at,
  measuredHours,
});

describe("groupFiles", () => {
  it("pairs each transcript with its slides by lecture number, however it is written", () => {
    const out = groupFiles([
      f("L1 transcript.vtt", "TRANSCRIPT", 1),
      f("Lecture 01 - Gene regulation slides.pdf", "SLIDES"),
      f("BIOL3010_L2_transcript.txt", "TRANSCRIPT", 2),
      f("lec2 - Operons.pptx", "SLIDES"),
    ]);
    expect(out.map((l) => l.fileIndexes)).toEqual([[0, 1], [2, 3]]);
    expect(out.map((l) => l.number)).toEqual([1, 2]);
    expect(out[0].title).toBe("Gene regulation");
    expect(out[1].title).toBe("Operons");
    expect(out[1].durationHours).toBe(2);
  });

  it("does not read a course code as a lecture number", () => {
    const out = groupFiles([f("BIOL3010 L4.vtt"), f("BIOL3010 notes on genes.txt")]);
    expect(out).toHaveLength(2);
    expect(out[0].number).toBe(4);
    expect(out[1].number).toBeNull();
  });

  it("keeps the same lecture number apart in different module folders", () => {
    const out = groupFiles([
      f("Module 1 - Heart/Lecture 1.vtt"),
      f("Module 2 - Kidney/Lecture 1.vtt"),
      f("Module 2 - Kidney/Lecture 1 slides.pdf", "SLIDES"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.moduleTitle)).toEqual(["Module 1 - Heart", "Module 2 - Kidney"]);
    expect(out[1].fileIndexes).toEqual([1, 2]);
  });

  it("orders week-and-lecture numbering properly", () => {
    const out = groupFiles([f("W3L1.vtt"), f("Week 2 Lecture 2.vtt"), f("Week 2 Lecture 1.vtt")]);
    expect(out.map((l) => l.fileIndexes[0])).toEqual([2, 1, 0]);
  });

  it("falls back to a shared name when there is no number", () => {
    const out = groupFiles([
      f("Gene regulation transcript.txt"),
      f("Gene regulation slides.pdf", "SLIDES"),
      f("Cell cycle.txt"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((l) => l.fileIndexes.includes(0))!.fileIndexes).toEqual([0, 1]);
  });

  it("takes the date from the filename, else the file's own date", () => {
    const out = groupFiles([f("2026-03-04 lecture.vtt"), f("Cell cycle.txt")]);
    expect(out.find((l) => l.fileIndexes[0] === 0)!.deliveredOn).toBe("2026-03-04");
    expect(out.find((l) => l.fileIndexes[0] === 1)!.deliveredOn).toBe("2026-03-10");
  });

  it("sets aside past papers and course admin instead of importing them", () => {
    const out = groupFiles([
      f("L1.vtt"),
      f("Past exam 2024.pdf", "SLIDES"),
      f("BIOL3010 Course Profile.pdf", "SLIDES"),
    ]);
    expect(out[0].setAside).toBeNull();
    expect(out[1].setAside).toMatch(/past exam/);
    expect(out[2].setAside).toMatch(/admin/);
  });

  it("tells a past paper saved as text from a recorded revision lecture", () => {
    const out = groupFiles([f("Past exam 2024.md", "TRANSCRIPT", null), f("Final exam revision.vtt", "TRANSCRIPT", 1)]);
    expect(out.find((l) => l.fileIndexes[0] === 0)!.setAside).toMatch(/past exam/);
    expect(out.find((l) => l.fileIndexes[0] === 1)!.setAside).toBeNull();
  });
});

describe("filename helpers", () => {
  it("strips numbering, codes and file-type words from titles", () => {
    expect(titleFromFilename("BIOL3010_Lecture_07_-_Lac_operon_slides.pdf")).toBe("Lac operon");
    expect(titleFromFilename("L1 transcript.vtt")).toBe("");
    expect(titleFromFilename("Week 3 - ECG fundamentals (1).pdf")).toBe("ECG fundamentals");
  });

  it("reduces a filename to the part that names the lecture", () => {
    expect(stemOf("Gene regulation transcript.txt")).toBe("gene regulation");
    expect(stemOf("Gene_regulation_slides_v2.pdf")).toBe("gene regulation");
  });

  it("reads ISO and Australian dates", () => {
    expect(dateFromName("2026-03-04 lecture")).toBe("2026-03-04");
    expect(dateFromName("rec 20260304")).toBe("2026-03-04");
    expect(dateFromName("lecture 4.3.26")).toBe("2026-03-04");
    expect(dateFromName("no date")).toBeNull();
  });
});
