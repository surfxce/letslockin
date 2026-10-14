import { describe, expect, it } from "vitest";

import {
  addLeftOut,
  asChildPoints,
  formatAnswer,
  insertAtStart,
  insertIntoSection,
  insertUnder,
  matchHeading,
  plainInline,
  setLineKind,
  shiftLines,
  summaryHeadings,
} from "./summary-edit";

const MD = `## Fed state

After a meal, **insulin** rises.

- Liver: glycogen synthesis
  - GLUT2 lets glucose in
- Muscle: GLUT4 translocation

### Adipose

LPL releases fatty acids.

## Fasting

Glucagon rises.

\`\`\`
## not a heading
\`\`\`
`;

describe("headings", () => {
  it("lists headings as a reader sees them, skipping code", () => {
    expect(summaryHeadings(MD)).toEqual(["Fed state", "Adipose", "Fasting"]);
    expect(summaryHeadings("## The **lac** operon\n\n# `cAMP` & CAP")).toEqual(["The lac operon", "cAMP & CAP"]);
  });

  it("matches a model's heading despite case or markup", () => {
    expect(matchHeading(MD, "fed STATE")).toBe("Fed state");
    expect(matchHeading(MD, "**Fasting**")).toBe("Fasting");
    expect(matchHeading(MD, "Something else")).toBeNull();
    expect(matchHeading(MD, null)).toBeNull();
  });

  it("reduces inline markup to words", () => {
    expect(plainInline("**Insulin** _rises_ after [meals](x) `fast`")).toBe("Insulin rises after meals fast");
    expect(plainInline("snake_case_name stays")).toBe("snake_case_name stays");
  });
});

describe("insertIntoSection", () => {
  it("files a block at the end of its section, before the next heading at its level", () => {
    const out = insertIntoSection(MD, "Fed state", "**Why?**\n\nBecause.");
    expect(out).toContain("LPL releases fatty acids.\n\n**Why?**\n\nBecause.\n\n## Fasting");
  });

  it("ends a subsection at the next heading of any level up", () => {
    const out = insertIntoSection(MD, "Adipose", "More fat.");
    expect(out).toContain("LPL releases fatty acids.\n\nMore fat.\n\n## Fasting");
  });

  it("appends at the end when the section is unknown or not given", () => {
    expect(insertIntoSection("## A\n\nText.\n", null, "New.")).toBe("## A\n\nText.\n\nNew.\n");
    expect(insertIntoSection("## A\n\nText.", "Nope", "New.")).toBe("## A\n\nText.\n\nNew.\n");
    expect(insertIntoSection("", null, "New.")).toBe("New.\n");
  });

  it("files into the last section", () => {
    const out = insertIntoSection("## A\n\nOne.\n\n## B\n\nTwo.\n", "B", "Three.");
    expect(out).toBe("## A\n\nOne.\n\n## B\n\nTwo.\n\nThree.\n");
  });
});

describe("insertAtStart", () => {
  it("goes after a title heading, else first", () => {
    expect(insertAtStart("# Title\n\nBody.", "Aims.")).toBe("# Title\n\nAims.\n\nBody.\n");
    expect(insertAtStart("## Part\n\nBody.", "Aims.")).toBe("Aims.\n\n## Part\n\nBody.\n");
  });
});

describe("insertUnder", () => {
  it("nests a break-down under the dot point it explains, after its own sub-points", () => {
    const out = insertUnder(MD, "Liver: glycogen", "Glycogen is stored glucose.");
    expect(out).toContain(
      "- Liver: glycogen synthesis\n  - GLUT2 lets glucose in\n  - Glycogen is stored glucose.\n- Muscle",
    );
  });

  it("matches text that was bold in the Markdown", () => {
    const out = insertUnder(MD, "insulin rises", "It's released by beta cells.");
    expect(out).toContain("After a meal, **insulin** rises.\n\nIt's released by beta cells.\n\n- Liver");
  });

  it("keeps a list answer's own nesting", () => {
    const out = insertUnder("- A\n- B\n", "A", "- one\n  - two");
    expect(out).toBe("- A\n  - one\n    - two\n- B\n");
  });

  it("nests under a numbered item by its marker's width", () => {
    expect(insertUnder("1. First\n2. Second", "First", "More.")).toBe("1. First\n   - More.\n2. Second");
  });

  it("falls back to the first words of a long selection, then to the end", () => {
    expect(insertUnder(MD, "Glucagon rises. And then much more text that is not there", "x")).toContain(
      "Glucagon rises.\n\nx\n\n```",
    );
    expect(insertUnder("Para.", "missing words", "x")).toBe("Para.\n\nx\n");
  });

  it("puts a block under a heading right after it", () => {
    expect(insertUnder("## Fasting\n\nGlucagon.", "Fasting", "x")).toBe("## Fasting\n\nx\n\nGlucagon.\n");
  });
});

describe("asChildPoints", () => {
  it("turns paragraphs into dot points at a depth", () => {
    expect(asChildPoints("One line\nwrapped.\n\nTwo.", 2)).toBe("  - One line wrapped.\n  - Two.");
  });
});

describe("formatAnswer and addLeftOut", () => {
  it("leads an answer with its question in bold", () => {
    expect(formatAnswer(" Why  **does** it rise? ", "Because.\n")).toBe("**Why does it rise?**\n\nBecause.");
  });

  it("puts aims at the top and anything else at the end", () => {
    expect(addLeftOut("## A\n\nBody.", "Module 3 aims", "- Explain X")).toBe("## Module 3 aims\n\n- Explain X\n\n## A\n\nBody.\n");
    expect(addLeftOut("## A\n\nBody.", "Assessment dates", "Exam in week 13.")).toBe(
      "## A\n\nBody.\n\n## Assessment dates\n\nExam in week 13.\n",
    );
  });
});

describe("line tools", () => {
  const text = "Alpha\nBeta\n\nGamma";

  it("turns the touched lines into dot points at a level", () => {
    const r = setLineKind(text, 2, 8, "bullet2");
    expect(r.text).toBe("  - Alpha\n  - Beta\n\nGamma");
    expect(r.text.slice(r.start, r.end)).toBe("  - Alpha\n  - Beta");
  });

  it("swaps one kind for another and back to text", () => {
    expect(setLineKind("- Alpha", 0, 0, "h2").text).toBe("## Alpha");
    expect(setLineKind("## Alpha", 3, 3, "bullet3").text).toBe("    - Alpha");
    expect(setLineKind("    - Alpha", 0, 11, "text").text).toBe("Alpha");
    expect(setLineKind("1. Alpha", 0, 0, "bullet1").text).toBe("- Alpha");
  });

  it("does not take in the next line when a selection ends at a line break", () => {
    expect(setLineKind("A\nB", 0, 2, "bullet1").text).toBe("- A\nB");
  });

  it("moves dot points in and out with Tab and Shift+Tab", () => {
    const r = shiftLines("- A\n- B\nText", 0, 7, 1);
    expect(r.text).toBe("  - A\n  - B\nText");
    expect(shiftLines(r.text, r.start, r.end, -1).text).toBe("- A\n- B\nText");
    const caret = shiftLines("- A", 3, 3, 1);
    expect(caret).toEqual({ text: "  - A", start: 5, end: 5 });
    expect(shiftLines("- A", 0, 0, -1).text).toBe("- A");
  });
});
