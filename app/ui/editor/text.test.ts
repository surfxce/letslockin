import { describe, expect, it } from "vitest";

import { setLineKind } from "@/lib/summary-edit";

import { continueList, lineKindAt, looksLikeMarkdown, relativeTime, toggleMark } from "./text";

describe("lineKindAt", () => {
  const md = "## Head\n### Sub\n#### Small\nText\n- One\n  - Two\n    - Three\n      - Four\n1. Numbered\n\n- Again";
  const at = (needle: string) => lineKindAt(md, md.indexOf(needle) + 1);

  it("names headings, text and dot point levels", () => {
    expect(at("Head")).toBe("h2");
    expect(at("Sub")).toBe("h3");
    expect(at("Small")).toBe(null);
    expect(at("Text")).toBe("text");
    expect(at("One")).toBe("bullet1");
    expect(at("Two")).toBe("bullet2");
    expect(at("Three")).toBe("bullet3");
    expect(at("Four")).toBe(null);
    expect(at("Numbered")).toBe(null);
    expect(at("Again")).toBe("bullet1");
  });

  it("counts levels by nesting, not by a fixed indent", () => {
    const four = "- One\n    - Two\n        - Three";
    expect(lineKindAt(four, four.indexOf("Two"))).toBe("bullet2");
    expect(lineKindAt(four, four.indexOf("Three"))).toBe("bullet3");
  });

  it("agrees with setLineKind", () => {
    for (const kind of ["text", "h2", "h3", "bullet1", "bullet2", "bullet3"] as const) {
      const base = "- Parent\n  - Child\nLine";
      const out = setLineKind(base, base.length - 2, base.length - 2, kind);
      expect(lineKindAt(out.text, out.start)).toBe(kind);
    }
  });
});

describe("toggleMark", () => {
  const run = (marked: string, marker: "**" | "*") => {
    // [ and ] mark the selection.
    const start = marked.indexOf("[");
    const end = marked.indexOf("]") - 1;
    const text = marked.replace("[", "").replace("]", "");
    const out = toggleMark(text, start, end, marker);
    return out.text.slice(0, out.start) + "[" + out.text.slice(out.start, out.end) + "]" + out.text.slice(out.end);
  };

  it("wraps a selection, leaving spaces at its edges outside", () => {
    expect(run("a [word ]b", "**")).toBe("a **[word]** b");
    expect(run("a [word] b", "*")).toBe("a *[word]* b");
  });

  it("unwraps marks round or inside the selection", () => {
    expect(run("a **[word]** b", "**")).toBe("a [word] b");
    expect(run("a [**word**] b", "**")).toBe("a [word] b");
    expect(run("a *[word]* b", "*")).toBe("a [word] b");
  });

  it("tells bold and italic apart", () => {
    expect(run("a **[word]** b", "*")).toBe("a ***[word]*** b");
    expect(run("a ***[word]*** b", "**")).toBe("a *[word]* b");
    expect(run("a ***[word]*** b", "*")).toBe("a **[word]** b");
  });

  it("puts the cursor between new marks when nothing is selected", () => {
    expect(run("a []b", "**")).toBe("a **[]**b");
  });
});

describe("continueList", () => {
  const enter = (marked: string) => {
    // | marks the cursor.
    const at = marked.indexOf("|");
    const out = continueList(marked.replace("|", ""), at, at);
    return out && out.text.slice(0, out.start) + "|" + out.text.slice(out.start);
  };

  it("starts the next point at the same level", () => {
    expect(enter("- One|")).toBe("- One\n- |");
    expect(enter("- One\n  - Two|\nAfter")).toBe("- One\n  - Two\n  - |\nAfter");
    expect(enter("1. First|")).toBe("1. First\n2. |");
  });

  it("carries the rest of the line into the new point", () => {
    expect(enter("- Split| here")).toBe("- Split\n- |here");
  });

  it("steps out a level, then out of the list, on an empty point", () => {
    expect(enter("- One\n  - |")).toBe("- One\n- |");
    expect(enter("- One\n- |")).toBe("- One\n|");
  });

  it("leaves other lines alone", () => {
    expect(enter("Just text|")).toBe(null);
    expect(enter("|- before the marker")).toBe(null);
  });
});

describe("looksLikeMarkdown", () => {
  it("spots Markdown, not plain sentences", () => {
    expect(looksLikeMarkdown("## Heading\n\nText")).toBe(true);
    expect(looksLikeMarkdown("Some **bold** words")).toBe(true);
    expect(looksLikeMarkdown("- a point\n- another")).toBe(true);
    expect(looksLikeMarkdown("A plain sentence, with a - dash.")).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  it("says how long ago", () => {
    expect(relativeTime(now - 10_000, now)).toBe("a moment ago");
    expect(relativeTime(now - 60_000, now)).toBe("a minute ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 26 * 3600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86400_000, now)).toBe("3 days ago");
    expect(relativeTime(new Date(2026, 8, 1).getTime(), now)).toBe("Tue 1 Sep");
  });
});
