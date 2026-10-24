import { describe, expect, it } from "vitest";

import { buildNotesSheet, notesFileName, stemOpening, type NotesSheetInput } from "./notes-sheet";

type R = NotesSheetInput["responses"][number];

const base = (r: Partial<R> & Pick<R, "number">): R => ({
  stem: `Question ${r.number}`,
  mark: 5,
  items: [],
  gaps: [],
  ...r,
});

const sheet = (responses: R[]) =>
  buildNotesSheet({ lectureTitle: "Insulin and diabetes", sittingDate: new Date(2026, 9, 14, 10, 30), responses });

describe("buildNotesSheet", () => {
  it("groups AI-marked gaps by concept, across questions, wrong before missed", () => {
    const s = sheet([
      base({
        number: 1,
        gaps: [
          { type: "MISSED", text: "GLUT4 moves to the membrane when insulin binds.", concept: "Insulin signalling" },
          { type: "WRONG", text: "Insulin is made by beta cells, not alpha cells.", concept: "Islet cells" },
          { type: "WRONG", text: "Insulin acts through a receptor tyrosine kinase.", concept: "Insulin signalling" },
        ],
        // The same facts as the gaps, as feedbackFor gives them: not counted twice.
        items: [
          { kind: "good", text: "Defined diabetes" },
          { kind: "wrong", text: "Insulin is made by beta cells, not alpha cells." },
          { kind: "missed", text: "GLUT4 moves to the membrane when insulin binds." },
        ],
      }),
      base({
        number: 2,
        gaps: [{ type: "MISSED", text: "HbA1c reflects the last 2–3 months.", concept: "insulin signalling" }],
      }),
    ]);
    expect(s.sections.map((x) => x.by)).toEqual(["concept", "concept"]);
    expect(s.sections.map((x) => [x.heading, x.from, x.wrong, x.missed])).toEqual([
      [
        "Insulin signalling",
        [1, 2],
        ["Insulin acts through a receptor tyrosine kinase."],
        ["GLUT4 moves to the membrane when insulin binds.", "HbA1c reflects the last 2–3 months."],
      ],
      ["Islet cells", [1], ["Insulin is made by beta cells, not alpha cells."], []],
    ]);
    expect(s.count).toBe(4);
  });

  it("groups pasted marking by question, headed with the start of the stem, and drops what went well", () => {
    const s = sheet([
      base({
        number: 3,
        stem: "**Explain** the pathophysiology of type 2 diabetes mellitus, including insulin resistance.",
        items: [
          { kind: "good", text: "Good definition" },
          { kind: "missed", text: "Beta-cell exhaustion over time" },
          { kind: "wrong", text: "Type 2 is not autoimmune" },
        ],
      }),
    ]);
    expect(s.sections).toEqual([
      {
        heading: "LAQ 3 — Explain the pathophysiology of type 2 diabetes mellitus…",
        by: "question",
        from: [3],
        wrong: ["Type 2 is not autoimmune"],
        partial: [],
        missed: ["Beta-cell exhaustion over time"],
      },
    ]);
  });

  it("writes each fact once, ignoring case, punctuation and spacing", () => {
    const s = sheet([
      base({ number: 1, items: [{ kind: "missed", text: "GLUT-4 moves to the membrane." }] }),
      base({
        number: 2,
        items: [
          { kind: "missed", text: "glut4  moves to the   membrane" },
          { kind: "wrong", text: "GLUT4 moves to the membrane!" },
          { kind: "missed", text: "Insulin lowers blood glucose" },
        ],
      }),
    ]);
    expect(s.sections.map((x) => [x.heading, x.wrong, x.missed])).toEqual([
      ["LAQ 1 — Question 1", [], ["GLUT-4 moves to the membrane."]],
      ["LAQ 2 — Question 2", [], ["Insulin lowers blood glucose"]],
    ]);
    expect(s.count).toBe(2);
  });

  it("keeps partly earned points apart, with praise dropped and scores stripped", () => {
    const s = sheet([
      base({
        number: 1,
        items: [
          { kind: "missed", text: "Ketone bodies in DKA" },
          { kind: "note", text: "Overall a reasonable answer" },
        ],
      }),
      base({
        number: 2,
        mark: 7,
        items: [
          { kind: "good", text: "Mechanism" },
          { kind: "note", text: "Good structure throughout" },
          { kind: "note", text: "Counter-regulatory hormones (1/2): named glucagon but not cortisol" },
        ],
      }),
      // Full marks: nothing to copy, whatever the notes say.
      base({ number: 3, mark: 10, items: [{ kind: "note", text: "Could mention adrenaline" }] }),
    ]);
    expect(s.sections.map((x) => [x.heading, x.partial, x.missed])).toEqual([
      ["LAQ 1 — Question 1", ["Overall a reasonable answer"], ["Ketone bodies in DKA"]],
      ["LAQ 2 — Question 2", ["Counter-regulatory hormones — named glucagon but not cortisol"], []],
    ]);
    expect(s.markdown).toContain("- \\~ Counter-regulatory hormones — named glucagon but not cortisol");
    expect(s.plain).toContain("~ Counter-regulatory hormones");
  });

  it("lists the marking guide for an answer left blank", () => {
    const s = sheet([
      base({
        number: 2,
        mark: 0,
        blank: true,
        items: [{ kind: "missed", text: "Left blank." }],
        guide: ["Defines DKA", "Lists the triad: hyperglycaemia, ketosis, acidosis"],
      }),
      base({ number: 3, mark: 0, blank: true, items: [{ kind: "missed", text: "Left blank." }] }),
    ]);
    expect(s.sections.map((x) => x.missed)).toEqual([
      ["Defines DKA", "Lists the triad: hyperglycaemia, ketosis, acidosis"],
      ["Left blank — learn this one from the marking guide."],
    ]);
  });

  it("skips answers still being marked", () => {
    const s = sheet([
      base({ number: 1, mark: null, items: [] }),
      base({ number: 2, items: [{ kind: "missed", text: "Insulin is anabolic" }] }),
    ]);
    expect(s.sections.map((x) => x.from)).toEqual([[2]]);
  });

  it("is empty when nothing was missed or wrong", () => {
    const s = sheet([
      base({ number: 1, mark: 10, items: [{ kind: "good", text: "Everything" }] }),
      base({ number: 2, mark: null }),
    ]);
    expect(s).toEqual({ sections: [], markdown: "", plain: "", count: 0 });
    expect(sheet([]).count).toBe(0);
  });

  it("writes Markdown and plain text with a marker per point", () => {
    const s = sheet([
      base({
        number: 1,
        gaps: [
          { type: "WRONG", text: "Insulin is made by **beta** cells.", concept: "Islet cells" },
          { type: "MISSED", text: "Glucagon is made by alpha cells.", concept: "Islet cells" },
        ],
      }),
    ]);
    expect(s.markdown).toBe(
      [
        "## Notes to copy — Insulin and diabetes, Wednesday 14 Oct 2026",
        "",
        "*✗ had it wrong — the correct fact · ~ partly right — what was short · + missed — add it*",
        "",
        "### Islet cells",
        "",
        "- ✗ Insulin is made by **beta** cells.",
        "- \\+ Glucagon is made by alpha cells.",
        "",
      ].join("\n"),
    );
    expect(s.plain).toBe(
      [
        "Notes to copy — Insulin and diabetes, Wednesday 14 Oct 2026",
        "✗ had it wrong — the correct fact · ~ partly right — what was short · + missed — add it",
        "",
        "Islet cells",
        "✗ Insulin is made by beta cells.",
        "+ Glucagon is made by alpha cells.",
        "",
      ].join("\n"),
    );
  });
});

describe("stemOpening", () => {
  it("keeps short stems whole and shortens long ones", () => {
    expect(stemOpening("Define insulin resistance.")).toBe("Define insulin resistance.");
    expect(stemOpening("A 54-year-old woman presents with polyuria, polydipsia and weight loss over three months.")).toBe(
      "A 54-year-old woman presents with polyuria, polydipsia and…",
    );
    expect(stemOpening("1. **Describe** the [islets](x) of\n\nLangerhans")).toBe("Describe the islets of Langerhans");
    expect(stemOpening("   ")).toBe("Question");
  });
});

describe("notesFileName", () => {
  it("is safe to save anywhere", () => {
    expect(notesFileName('Diabetes: type 1 / type 2 "basics"', new Date(2026, 9, 14))).toBe(
      "Diabetes type 1 type 2 basics — notes 2026-10-14.md",
    );
    expect(notesFileName("  ", "2026-10-14T12:00:00")).toBe("Lecture — notes 2026-10-14.md");
  });
});
