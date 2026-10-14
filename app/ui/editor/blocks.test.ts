import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import type { LineKind } from "@/lib/summary-edit";

import { activeKind, listDepth, setKind, shiftLevel } from "./blocks";
import { summaryCodec, summaryExtensions } from "./markdown";

const codec = summaryCodec();
let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** A headless editor holding `md`, with the cursor inside the first text containing `at`. */
function open(md: string, at: string): Editor {
  editor = new Editor({ element: null, extensions: summaryExtensions(), content: codec.parse(md) });
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (pos === -1 && node.isText && node.text!.includes(at)) pos = p + node.text!.indexOf(at) + 1;
  });
  if (pos === -1) throw new Error(`"${at}" not found`);
  editor.commands.setTextSelection(pos);
  return editor;
}

const md = (e: Editor) => codec.serialize(e.getJSON());

describe("setKind", () => {
  // [what, summary, the text the cursor is in, style, summary after]
  const cases: Array<[string, string, string, LineKind, string]> = [
    ["plain to a point", "A line\n", "line", "bullet1", "- A line\n"],
    ["plain to a sub-point under the point above", "- Parent\n\nChild\n", "Child", "bullet2", "- Parent\n  - Child\n"],
    ["plain to level 3", "- One\n  - Two\n\nThree\n", "Three", "bullet3", "- One\n  - Two\n    - Three\n"],
    ["heading to a point", "- Parent\n\n## Heading\n", "Heading", "bullet2", "- Parent\n  - Heading\n"],
    ["deep point out to level 1", "- One\n  - Two\n    - Three\n", "Three", "bullet1", "- One\n  - Two\n- Three\n"],
    ["level 1 point in to level 3", "- One\n  - Two\n- Three\n", "Three", "bullet3", "- One\n  - Two\n    - Three\n"],
    ["point to text", "- One\n  - Two\n", "Two", "text", "- One\n\nTwo\n"],
    ["point to heading", "- One\n- Two\n", "Two", "h2", "- One\n\n## Two\n"],
    ["text to subheading", "Words\n", "Words", "h3", "### Words\n"],
    ["heading to text", "## Words\n", "Words", "text", "Words\n"],
    ["quoted text stays quoted", "> Quoted\n", "Quoted", "text", "> Quoted\n"],
    ["numbered to dot points", "1. One\n2. Two\n", "Two", "bullet1", "- One\n- Two\n"],
  ];
  for (const [name, input, at, kind, expected] of cases) {
    it(name, () => {
      const e = open(input, at);
      expect(setKind(e, kind)).toBe(true);
      expect(md(e)).toBe(expected);
      expect(activeKind(e.state)).toBe(kind);
    });
  }

  it("stops at the deepest level possible when there is nothing above to sit under", () => {
    const e = open("Lonely\n", "Lonely");
    expect(setKind(e, "bullet3")).toBe(false);
    expect(md(e)).toBe("- Lonely\n");
    expect(listDepth(e.state).depth).toBe(1);
  });
});

describe("undo", () => {
  // Undo history only runs in a mounted editor; one transaction is one step to undo.
  it("makes a style change as one transaction", () => {
    const e = open("- One\n  - Two\n\nThree\n", "Three");
    let transactions = 0;
    e.on("transaction", () => transactions++);
    setKind(e, "bullet3");
    expect(md(e)).toBe("- One\n  - Two\n    - Three\n");
    expect(transactions).toBe(1);
  });
});

describe("shiftLevel", () => {
  it("moves a point in and out, and never out of its list", () => {
    const e = open("- One\n- Two\n", "Two");
    expect(shiftLevel(e, 1)).toBe(true);
    expect(md(e)).toBe("- One\n  - Two\n");
    expect(shiftLevel(e, -1)).toBe(true);
    expect(md(e)).toBe("- One\n- Two\n");
    expect(shiftLevel(e, -1)).toBe(true);
    expect(md(e)).toBe("- One\n- Two\n");
  });

  it("leaves Tab alone off a list", () => {
    expect(shiftLevel(open("Just text\n", "Just"), 1)).toBe(false);
  });
});

describe("activeKind", () => {
  it("names the line the cursor is on", () => {
    expect(activeKind(open("## Head\n", "Head").state)).toBe("h2");
    expect(activeKind(open("#### Small\n", "Small").state)).toBe(null);
    expect(activeKind(open("1. Numbered\n", "Numbered").state)).toBe(null);
    expect(activeKind(open("> Quoted\n", "Quoted").state)).toBe("text");
  });
});
