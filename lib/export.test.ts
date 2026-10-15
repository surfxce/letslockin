import { describe, expect, it } from "vitest";

import { EXPORT_DEFAULTS, exportHref, exportTitle, isExportPath, NO_MODULE, parseExportParams, safeFileName } from "@/lib/export";

describe("parseExportParams", () => {
  it("defaults to everything included on A4", () => {
    expect(parseExportParams({})).toEqual(EXPORT_DEFAULTS);
  });

  it("reads a course, a module and the options", () => {
    expect(
      parseExportParams({ course: "c1", module: "m1", pictures: "0", glossary: "0", contents: "0", paper: "letter" }),
    ).toEqual({
      courseId: "c1",
      moduleId: "m1",
      lectureIds: null,
      pictures: false,
      glossary: false,
      contents: false,
      paper: "letter",
    });
    expect(parseExportParams({ module: NO_MODULE }).moduleId).toBe(NO_MODULE);
  });

  it("collects lectures from a list, repeats and the singular form, once each", () => {
    expect(parseExportParams({ lectures: "a,b", lecture: ["c", "a"] }).lectureIds).toEqual(["a", "b", "c"]);
  });

  it("ignores anything that isn't an id", () => {
    const r = parseExportParams({ course: "x' OR 1=1", lectures: "ok,../etc,", paper: "A3", pictures: "maybe" });
    expect(r.courseId).toBeNull();
    expect(r.lectureIds).toEqual(["ok"]);
    expect(r.paper).toBe("a4");
    expect(r.pictures).toBe(true);
  });
});

describe("exportHref", () => {
  it("leaves defaults out, and round-trips", () => {
    expect(exportHref({})).toBe("/export");
    expect(exportHref({ courseId: "c1" })).toBe("/export?course=c1");
    const r = { ...EXPORT_DEFAULTS, courseId: "c1", moduleId: "m1", glossary: false, paper: "letter" as const };
    const href = exportHref(r);
    expect(href).toBe("/export?course=c1&module=m1&glossary=0&paper=letter");
    expect(parseExportParams(Object.fromEntries(new URLSearchParams(href.split("?")[1])))).toEqual(r);
  });

  it("prefers picked lectures over a module", () => {
    expect(exportHref({ courseId: "c", moduleId: "m", lectureIds: ["a", "b"] })).toBe("/export?course=c&lectures=a%2Cb");
  });

  it("keeps choosing lectures when none are picked yet", () => {
    const href = exportHref({ courseId: "c", lectureIds: [] });
    expect(href).toBe("/export?course=c&lectures=");
    expect(parseExportParams(Object.fromEntries(new URLSearchParams(href.split("?")[1]))).lectureIds).toEqual([]);
  });
});

describe("isExportPath", () => {
  it("allows only the export page", () => {
    expect(isExportPath("/export")).toBe(true);
    expect(isExportPath("/export?course=c1&paper=letter")).toBe(true);
    expect(isExportPath("/exports")).toBe(false);
    expect(isExportPath("/settings")).toBe(false);
    expect(isExportPath("https://example.com/export")).toBe(false);
    expect(isExportPath("//example.com/export")).toBe(false);
  });
});

describe("file names", () => {
  it("names the PDF after what is in it", () => {
    expect(exportTitle({ courseCode: "BIOL2020" })).toBe("BIOL2020 — summaries");
    expect(exportTitle({ courseCode: "BIOL2020", moduleTitle: "Endocrinology" })).toBe("BIOL2020 Endocrinology — summaries");
    expect(exportTitle({ courseCode: "BIOL2020", picked: 3 })).toBe("BIOL2020 — 3 lecture summaries");
    expect(exportTitle({ courseCode: "BIOL2020", lecture: { ordinal: 4, title: "Insulin: what/why?" } })).toBe(
      "BIOL2020 L4 — Insulin what why",
    );
  });

  it("makes any name safe to save", () => {
    expect(safeFileName('a<b>c:"d"/e\\f|g?h*i')).toBe("a b c d e f g h i");
    expect(safeFileName("trailing dots...")).toBe("trailing dots");
    expect(safeFileName("  ")).toBe("Lockin summaries");
    expect(safeFileName("x".repeat(300))).toHaveLength(120);
  });
});
