import { describe, expect, it } from "vitest";

import { cardsFromRows, cellToMarkdown, detectDelimiter, parseCardFile, parseDelimited } from "@/lib/flashcards/csv";

describe("parseDelimited", () => {
  it("handles quotes, doubled quotes, quoted newlines and CRLF", () => {
    expect(parseDelimited('a,"b, c"\r\n"say ""hi""","line 1\nline 2"\n', ",")).toEqual([
      ["a", "b, c"],
      ['say "hi"', "line 1\nline 2"],
    ]);
  });
  it("keeps empty cells and skips blank lines", () => {
    expect(parseDelimited("a\t\tc\n\n\tb\n", "\t")).toEqual([["a", "", "c"], ["", "b"]]);
  });
});

describe("detectDelimiter", () => {
  it("prefers the separator the rows agree on", () => {
    expect(detectDelimiter("front\tback\nWhat is ATP?\tEnergy, mostly\n")).toBe("\t");
    expect(detectDelimiter("q;a\nOne;Two\nThree;Four")).toBe(";");
    expect(detectDelimiter('"Insulin, what does it do?",Lowers glucose\nGlucagon,Raises glucose')).toBe(",");
  });
});

describe("parseCardFile", () => {
  it("reads Anki's export headers", () => {
    const file = parseCardFile("#separator:tab\n#html:true\n#tags column:3\n#columns:Front\tBack\tTags\nWhat?<br>Really\t<b>Yes</b>\tbio\n");
    expect(file.tagsColumn).toBe(2);
    expect(cardsFromRows(file.rows, 0, 1, true, file.tagsColumn)).toEqual([{ front: "What?\nReally", back: "**Yes**", tags: "bio" }]);
    expect(file.delimiter).toBe("\t");
    expect(file.html).toBe(true);
    expect(file.header).toEqual(["Front", "Back", "Tags"]);
    expect(file.rows).toEqual([["What?<br>Really", "<b>Yes</b>", "bio"]]);
  });
  it("spots a header row and a BOM", () => {
    const file = parseCardFile("﻿Question,Answer\nWhat lowers glucose?,Insulin\n");
    expect(file.header).toEqual(["Question", "Answer"]);
    expect(file.rows).toEqual([["What lowers glucose?", "Insulin"]]);
    expect(file.html).toBe(false);
  });
  it("doesn't take a card for a header", () => {
    expect(parseCardFile("Insulin,Lowers glucose\nGlucagon,Raises it").header).toBeNull();
  });
});

describe("cellToMarkdown", () => {
  it("turns Anki HTML into Markdown", () => {
    expect(cellToMarkdown("<div>Line <b>one</b></div><div>Line <i>two</i>&nbsp;&amp; more</div>", true)).toBe("Line **one**\nLine *two* & more");
    expect(cellToMarkdown('Na<sup>+</sup> <img src="pic.jpg"> &#x2192; K<sub>2</sub>', true)).toBe("Na^+  → K_2");
  });
  it("leaves plain text alone", () => {
    expect(cellToMarkdown("  a <b> b  ", false)).toBe("a <b> b");
  });
});

describe("cardsFromRows", () => {
  it("uses the chosen columns and skips half-empty rows", () => {
    expect(cardsFromRows([["x", "Q1", "A1"], ["y", "Q2", ""], ["z", "", "A3"]], 1, 2, false)).toEqual([{ front: "Q1", back: "A1" }]);
  });
  it("turns cloze notes into a question and its sentence", () => {
    expect(cardsFromRows([["{{c1::Insulin}} lowers {{c2::glucose::sugar}}", ""]], 0, 1, false)).toEqual([
      { front: "[…] lowers [sugar]", back: "**Insulin** lowers **glucose**" },
    ]);
  });
});
