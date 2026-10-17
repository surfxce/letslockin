import { describe, expect, it } from "vitest";

import { imageMarkdown } from "./images";
import { lostWords, normaliseDoc, outsideCode, summaryCodec, summaryWords, tidyLayout } from "./markdown";

const codec = summaryCodec();
const roundTrip = (md: string) => codec.roundTrip(md);
/** Top-level node types of a parsed summary. */
const types = (md: string) => (codec.parse(md).content ?? []).map((n) => n.type);

const SUMMARY = `## Glucose & insulin

Intro with **bold**, *italic*, ~~strike~~, \`code\` and a [link](https://example.com).

- Point one
  - Sub point
    - Sub sub point
- Point two with **bold**

1. First
2. Second

![Fed-state map](slide:7)

![Two slides](slide:7-8)

![A web picture](https://example.com/a.png)

> A quote

| Hormone | Effect         |
| ------- | -------------- |
| Insulin | Lowers glucose |

---

### Sub heading

Final paragraph.
`;

describe("round trip through the formatted editor", () => {
  it("gives back a typical summary unchanged", () => {
    expect(roundTrip(SUMMARY)).toBe(SUMMARY);
  });

  it("keeps dot points three levels deep", () => {
    const md = "- One\n  - Two\n    - Three\n";
    expect(roundTrip(md)).toBe(md);
    const list = codec.parse(md).content![0];
    expect(list.type).toBe("bulletList");
    expect(list.content![0].content![1].content![0].content![1].type).toBe("bulletList");
  });

  it("keeps tables, quotes, bold, italic and links", () => {
    for (const md of [
      "| A | B |\n|---|:-:|\n| 1 | 2 |\n",
      "> Quoted **bold** text\n",
      "Some **bold** and *italic* and ***both***.\n",
      "See [the guidelines](https://example.com/a?b=c) here.\n",
    ]) {
      expect(lostWords(md, roundTrip(md))).toEqual([]);
      expect(roundTrip(roundTrip(md))).toBe(roundTrip(md));
    }
    expect(roundTrip("See [the guidelines](https://example.com/a?b=c) here.\n")).toBe(
      "See [the guidelines](https://example.com/a?b=c) here.\n",
    );
  });

  it("keeps slide pictures exactly as written", () => {
    for (const line of [
      "![Fed-state map](slide:7)",
      "![Two slides](slide:7-8)",
      "![Spaced](slide 9)",
      "![Caps](Slide:12)",
      "![Pages](slides 7 and 8)",
      '![Titled](slide:3 "The title")',
      "![A **bold** caption](slide:4)",
      "![Web](https://example.com/pic.png)",
      "![Odd](figure-2.png)",
    ]) {
      const md = `Before.\n\n${line}\n\nAfter.\n`;
      expect(roundTrip(md)).toBe(md);
      expect(types(md)).toEqual(["paragraph", "slideFigure", "paragraph"]);
    }
  });

  it("keeps two pictures on neighbouring lines as two figures", () => {
    const md = "![One](slide:1)\n\n![Two](slide:2)\n";
    expect(types(md)).toEqual(["slideFigure", "slideFigure"]);
    expect(roundTrip(md)).toBe(md);
  });

  it("keeps a picture inside a sentence, or a dot point, inline", () => {
    const sentence = "Text with ![a picture](slide:3) inside.\n";
    expect(types(sentence)).toEqual(["paragraph"]);
    expect(roundTrip(sentence)).toBe(sentence);
    const point = "- ![in a point](slide:4)\n- item\n";
    expect(roundTrip(point)).toBe(point);
  });

  it("leaves code alone, picture-like text and entities included", () => {
    const md = "```\ncode ![x](slide 2) &amp; *stars*\n```\n\nInline `a &amp; b` code.\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("writes symbols the way a person types them, not as escapes", () => {
    const md = "Plasma [Ca2+] ~2.4 mmol/L, A & B, x < y, snake_case, 5 * 3.\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("keeps an escape that is needed", () => {
    const md = String.raw`Not \*\*bold\*\* at all, and not [a link]\(x\).` + "\n";
    const out = roundTrip(md);
    expect(codec.parse(out)).toEqual(codec.parse(md));
    expect(out).toContain(String.raw`\*\*bold\*\*`);
  });

  it("keeps HTML the editor shows as text", () => {
    const md = "H<sub>2</sub>O and x<sup>2</sup>\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("is stable: a second trip changes nothing", () => {
    const messy = "* star\n* list\n\n\n\nSetext\n======\n\n+ plus\n";
    const once = roundTrip(messy);
    expect(roundTrip(once)).toBe(once);
    expect(lostWords(messy, once)).toEqual([]);
  });

  it("makes a list item that starts with a heading valid", () => {
    const md = "- ## Heading in a point\n- next\n";
    const doc = codec.parse(md);
    expect(doc.content![0].content![0].content![0].type).toBe("paragraph");
    expect(lostWords(md, roundTrip(md))).toEqual([]);
  });
});

describe("lostWords", () => {
  it("finds nothing lost when only Markdown marks change", () => {
    expect(lostWords("* one\n* two\n\nTitle\n=====\n", "- one\n- two\n\n# Title\n")).toEqual([]);
  });

  it("counts a task box as something a reader would lose", () => {
    const md = "- [ ] revise glycolysis\n";
    expect(lostWords(md, roundTrip(md))).toEqual(["☐"]);
  });

  it("notices words that are gone", () => {
    expect(lostWords("The Krebs cycle cycle", "The Krebs cycle")).toEqual(["cycle"]);
  });
});

describe("summaryWords", () => {
  it("reads words, not Markdown", () => {
    expect(summaryWords("## The **Krebs** cycle\n\n- [ATP](x) & *NADH*\n| a | b |\n|---|---|\n> quoted")).toEqual([
      "The",
      "Krebs",
      "cycle",
      "ATP",
      "NADH",
      "a",
      "b",
      "quoted",
    ]);
  });
});

describe("helpers", () => {
  it("tidies blank lines and blank-line markers, but not inside code", () => {
    expect(tidyLayout("\n\nA\n\n\n\n&nbsp;\n\nB\n```\n\n\n```\n\n")).toBe("A\n\nB\n```\n\n\n```\n");
  });

  it("changes only what is outside code", () => {
    expect(outsideCode("a `a` a\n```\na\n```", (s) => s.replace(/a/g, "b"))).toBe("b `a` b\n```\na\n```");
  });

  it("wraps stray inline content and lifts lone pictures out", () => {
    const pic = { type: "inlineImage", attrs: { src: "slide:1", alt: "x", title: null, raw: "![x](slide:1)" } };
    expect(normaliseDoc({ type: "doc", content: [pic, { type: "text", text: "hi" }] })).toEqual({
      type: "doc",
      content: [
        { type: "slideFigure", attrs: pic.attrs },
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    });
  });

  it("writes a picture made in the editor as Markdown", () => {
    expect(imageMarkdown({ src: "slide:7", alt: "Map [v2]", title: null, raw: null })).toBe("![Map \\[v2\\]](slide:7)");
    expect(imageMarkdown({ src: "slide 7", alt: "Map", title: "T", raw: null })).toBe('![Map](<slide 7> "T")');
  });
});
