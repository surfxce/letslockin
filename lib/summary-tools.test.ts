import { describe, expect, it } from "vitest";

import { MAX_ASK } from "./ask";
import {
  elapsed,
  mergeGlossary,
  oneLine,
  placeNear,
  readPastes,
  rememberPaste,
  SELECTION_LIMIT,
  shorten,
  splitRanges,
  termPieces,
} from "./summary-tools";

const viewport = { width: 1000, height: 800 };
const card = { width: 300, height: 200 };

it("breaks down passages as long as the server takes", () => {
  expect(SELECTION_LIMIT).toBe(MAX_ASK);
});

describe("placeNear", () => {
  it("goes on the side asked for, centred on the anchor", () => {
    const anchor = { top: 400, bottom: 420, left: 400, right: 500 };
    expect(placeNear(anchor, card, viewport, { prefer: "above" })).toEqual({ top: 192, left: 300, side: "above" });
    expect(placeNear(anchor, card, viewport, { prefer: "below" })).toEqual({ top: 428, left: 300, side: "below" });
  });

  it("flips when the side asked for has no room", () => {
    const nearTop = { top: 60, bottom: 80, left: 400, right: 500 };
    expect(placeNear(nearTop, card, viewport, { prefer: "above" }).side).toBe("below");
    const nearBottom = { top: 700, bottom: 720, left: 400, right: 500 };
    expect(placeNear(nearBottom, card, viewport, { prefer: "below" }).side).toBe("above");
  });

  it("takes the roomier side and stays on screen when neither fits", () => {
    const tall = { width: 300, height: 700 };
    const p = placeNear({ top: 300, bottom: 320, left: 0, right: 10 }, tall, viewport, { prefer: "above" });
    expect(p.side).toBe("below");
    expect(p.top).toBe(800 - 8 - 700);
    expect(p.left).toBe(8);
  });

  it("keeps clear of the left and right edges", () => {
    expect(placeNear({ top: 400, bottom: 420, left: 980, right: 995 }, card, viewport, { prefer: "below" }).left).toBe(
      1000 - 8 - 300,
    );
    // Wider than the window: pinned to the left margin.
    expect(placeNear({ top: 400, bottom: 420, left: 0, right: 10 }, { width: 2000, height: 10 }, viewport, { prefer: "below" }).left).toBe(8);
  });
});

describe("splitRanges", () => {
  it("splits a range across the nodes it covers", () => {
    // "insulin" | " secretion rises"
    expect(splitRanges([7, 16], [{ start: 0, end: 17 }])).toEqual([
      { node: 0, start: 0, end: 7, range: 0 },
      { node: 1, start: 0, end: 10, range: 0 },
    ]);
  });

  it("handles several ranges, one node holding more than one", () => {
    // "a GLUT2 b GLUT4" | " c" | "GLUT1"
    expect(
      splitRanges(
        [15, 2, 5],
        [
          { start: 2, end: 7 },
          { start: 10, end: 15 },
          { start: 17, end: 22 },
        ],
      ),
    ).toEqual([
      { node: 0, start: 2, end: 7, range: 0 },
      { node: 0, start: 10, end: 15, range: 1 },
      { node: 2, start: 0, end: 5, range: 2 },
    ]);
  });

  it("skips empty nodes and ranges starting on a node's edge", () => {
    expect(splitRanges([3, 0, 4], [{ start: 3, end: 7 }])).toEqual([{ node: 2, start: 0, end: 4, range: 0 }]);
  });

  it("covers a middle node whole", () => {
    expect(splitRanges([2, 3, 2], [{ start: 1, end: 6 }])).toEqual([
      { node: 0, start: 1, end: 2, range: 0 },
      { node: 1, start: 0, end: 3, range: 0 },
      { node: 2, start: 0, end: 1, range: 0 },
    ]);
  });

  it("gives nothing for no ranges", () => {
    expect(splitRanges([5, 5], [])).toEqual([]);
  });
});

describe("termPieces", () => {
  it("finds a term split by formatting, as one match", () => {
    const texts = ["Raised ", "insulin", " secretion follows."];
    expect(termPieces(texts, [0, 0, 0], ["insulin secretion"])).toEqual([
      { node: 1, start: 0, end: 7, range: 0, term: 0 },
      { node: 2, start: 0, end: 10, range: 0, term: 0 },
    ]);
  });

  it("never runs a term from one block into the next", () => {
    const texts = ["High insulin", "\n", "resistance later"];
    expect(termPieces(texts, [0, 1, 2], ["insulin resistance"])).toEqual([]);
    expect(termPieces(texts, [0, 1, 2], ["insulin", "resistance"])).toEqual([
      { node: 0, start: 5, end: 12, range: 0, term: 0 },
      { node: 2, start: 0, end: 10, range: 1, term: 1 },
    ]);
  });

  it("numbers matches across the whole text and keeps the longer term", () => {
    const texts = ["Insulin resistance", "Insulin again"];
    expect(termPieces(texts, [0, 1], ["insulin", "insulin resistance"])).toEqual([
      { node: 0, start: 0, end: 18, range: 0, term: 1 },
      { node: 1, start: 0, end: 7, range: 1, term: 0 },
    ]);
  });

  it("is empty without terms or text", () => {
    expect(termPieces([], [], ["insulin"])).toEqual([]);
    expect(termPieces(["insulin"], [0], [])).toEqual([]);
  });
});

describe("text chores", () => {
  it("puts a selection on one line", () => {
    expect(oneLine("  insulin\n\n  resistance\t ")).toBe("insulin resistance");
  });

  it("shortens in the middle, keeping both ends", () => {
    expect(shorten("short", 10)).toBe("short");
    const long = `${"a".repeat(50)} middle ${"z".repeat(50)}`;
    const s = shorten(long, 41);
    expect(s).toHaveLength(41);
    expect(s.startsWith("aaaa")).toBe(true);
    expect(s.endsWith("zzzz")).toBe(true);
    expect(s).toContain("…");
  });

  it("says how long it has been", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(8_900)).toBe("8s");
    expect(elapsed(65_000)).toBe("1m 05s");
    expect(elapsed(-5)).toBe("0s");
  });
});

describe("pastes", () => {
  it("keeps the newest first, one per passage, up to a limit", () => {
    let saved: Array<[string, string]> = [];
    saved = rememberPaste(saved, "a", "1");
    saved = rememberPaste(saved, "b", "2");
    saved = rememberPaste(saved, "a", "3");
    expect(saved).toEqual([
      ["a", "3"],
      ["b", "2"],
    ]);
    expect(rememberPaste(saved, "c", "4", 2)).toEqual([
      ["c", "4"],
      ["a", "3"],
    ]);
    expect(rememberPaste(saved, "a", "")).toEqual([["b", "2"]]);
  });

  it("reads back only what makes sense", () => {
    expect(readPastes(null)).toEqual([]);
    expect(readPastes("not json")).toEqual([]);
    expect(readPastes('{"a":1}')).toEqual([]);
    expect(readPastes('[["a","1"],["b",2],"c"]')).toEqual([["a", "1"]]);
  });
});

describe("mergeGlossary", () => {
  const server = [
    { id: "1", term: "insulin", explanation: "a hormone" },
    { id: "2", term: "GLUT4", explanation: "a transporter" },
  ];

  it("adds terms the server doesn't have yet", () => {
    const added = [{ id: "3", term: "glucagon", explanation: "the other hormone" }];
    expect(mergeGlossary(server, added, new Set()).map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("prefers the server's copy, matching by id or by term in any case", () => {
    const added = [
      { id: "1", term: "insulin", explanation: "old" },
      { id: "9", term: "Insulin", explanation: "duplicate" },
    ];
    expect(mergeGlossary(server, added, new Set())).toEqual(server);
  });

  it("hides removed terms, wherever they came from", () => {
    const added = [{ id: "3", term: "glucagon", explanation: "x" }];
    expect(mergeGlossary(server, added, new Set(["1", "3"])).map((e) => e.id)).toEqual(["2"]);
  });
});
