import { describe, expect, it } from "vitest";
import { dateFromName, groupFiles, lecturesFromSort, stemOf, titleFromFilename, type GroupInput } from "./group";

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

describe("shared decks and lecture codes", () => {
  // The folder from the bug report, as named.
  const folder = [
    f("A1_Endocrine-Control-of-Metabolism_slides.pdf", "SLIDES"),
    f("A1_Endocrine-Control-of-Metabolism_transcript.txt"),
    f("A2_Glucose-Homeostasis-and-Diabetes_slides.pdf", "SLIDES"),
    f("A2_Glucose-Homeostasis-and-Diabetes_transcript.txt"),
    f("A3_Lipid-Metabolism-and-Disease_slides.pdf", "SLIDES"),
    f("A3_Lipid-Metabolism-and-Disease_transcript.txt"),
    f("A4-A5_Appetite-and-Satiety_slides_shared.pdf", "SLIDES"),
    f("A4_Appetite-and-Satiety-Part1_transcript.txt"),
    f("A5_Appetite-and-Satiety-Part2_transcript.txt"),
  ];

  it("puts a deck covering two lectures into both, not into a lecture of its own", () => {
    const out = groupFiles(folder);
    expect(out).toHaveLength(5);
    expect(out.map((l) => l.label)).toEqual(["A1", "A2", "A3", "A4", "A5"]);
    expect(out.map((l) => l.fileIndexes)).toEqual([[0, 1], [2, 3], [4, 5], [6, 7], [6, 8]]);
  });

  it("names each lecture from its own files, not the shared one", () => {
    expect(groupFiles(folder).map((l) => l.title)).toEqual([
      "Endocrine Control of Metabolism",
      "Glucose Homeostasis and Diabetes",
      "Lipid Metabolism and Disease",
      "Appetite and Satiety Part 1",
      "Appetite and Satiety Part 2",
    ]);
  });

  it("reads ranges however they are written", () => {
    const out = groupFiles([
      f("L4.vtt"),
      f("L5.vtt"),
      f("L6.vtt"),
      f("Lectures 4 & 5 slides.pdf", "SLIDES"),
      f("L5-6 handout.pdf", "SLIDES"),
    ]);
    expect(out.map((l) => l.fileIndexes)).toEqual([[0, 3], [1, 3, 4], [2, 4]]);
  });

  it("keeps a range as its own lecture when none of its lectures is in the folder", () => {
    const out = groupFiles([
      f("A4-A5_Appetite_slides.pdf", "SLIDES"),
      f("A4-A5_Appetite_transcript.txt"),
      f("A1_Intro_transcript.txt"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].label).toBe("A4–A5");
    expect(out[1].title).toBe("Appetite");
    expect(out[1].fileIndexes).toEqual([0, 1]);
  });

  it("does not take a date or a long span for a range", () => {
    const out = groupFiles([f("L1 - 2026-03-04.vtt"), f("L1-20 complete deck.pdf", "SLIDES")]);
    expect(out[0].deliveredOn).toBe("2026-03-04");
    expect(out.every((l) => l.fileIndexes.length === 1)).toBe(true);
  });
});

describe("lecturesFromSort", () => {
  const files = [
    f("misc/recording 1.vtt", "TRANSCRIPT", 1),
    f("misc/deck final final.pdf", "SLIDES"),
    f("misc/recording 2.vtt", "TRANSCRIPT", 2),
    f("misc/syllabus.pdf", "SLIDES"),
  ];

  it("keeps the AI's grouping, titles and order, with dates and hours from the files", () => {
    const out = lecturesFromSort(files, {
      lectures: [
        { title: "Hunger signals", module: "Appetite", files: ["misc/recording 1.vtt", "misc/deck final final.pdf"] },
        { title: "Satiety", module: null, files: ["misc/recording 2.vtt", "misc/deck final final.pdf", "nope.pdf"] },
      ],
      setAside: [{ file: "misc/syllabus.pdf", reason: "course outline" }],
    });
    expect(out.map((l) => [l.title, l.fileIndexes, l.durationHours, l.setAside])).toEqual([
      ["Hunger signals", [0, 1], 1, null],
      ["Satiety", [1, 2], 2, null],
      ["Syllabus", [3], 1, "course outline"],
    ]);
    expect(out[0].moduleTitle).toBe("Appetite");
  });

  it("lists a file the AI forgot instead of dropping it", () => {
    const out = lecturesFromSort(files, { lectures: [{ title: "One", module: null, files: ["misc/recording 1.vtt"] }], setAside: [] });
    expect(out.filter((l) => l.setAside).map((l) => l.fileIndexes[0])).toEqual([1, 2, 3]);
    expect(out[1].setAside).toMatch(/didn't place/);
  });
});

describe("filename helpers", () => {
  it("strips numbering, codes and file-type words from titles", () => {
    expect(titleFromFilename("BIOL3010_Lecture_07_-_Lac_operon_slides.pdf")).toBe("Lac operon");
    expect(titleFromFilename("L1 transcript.vtt")).toBe("");
    expect(titleFromFilename("Week 3 - ECG fundamentals (1).pdf")).toBe("ECG fundamentals");
  });

  it("reads hyphens joining words as spaces, but keeps real ones", () => {
    expect(titleFromFilename("A1_Endocrine-Control-of-Metabolism_slides.pdf")).toBe("Endocrine Control of Metabolism");
    expect(titleFromFilename("Lecture 3 - X-ray imaging.pdf")).toBe("X-ray imaging");
    expect(titleFromFilename("Week 2 - Heart: valves & murmurs.pdf")).toBe("Heart – valves & murmurs");
    expect(titleFromFilename("A5_Appetite-and-Satiety-Part2_transcript.txt")).toBe("Appetite and Satiety Part 2");
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
