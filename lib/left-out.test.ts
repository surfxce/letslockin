import { describe, expect, it } from "vitest";

import { leftOutAction, leftOutButton, leftOutHint, partKeys, partLabel, partsLabel, placeCard, waited } from "./left-out";

const ctx = { canAsk: true, busy: false, notFound: false };

describe("leftOutAction", () => {
  it("adds a part whose words are known", () => {
    expect(leftOutAction({ about: "By the end you will…" }, ctx)).toBe("add");
  });

  it("does nothing more for a part already put back", () => {
    expect(leftOutAction({ about: "…", added: true }, ctx)).toBe("added");
    // Even if the words were never kept on this page.
    expect(leftOutAction({ added: true }, ctx)).toBe("added");
  });

  it("asks about a part not read yet, when the AI can", () => {
    expect(leftOutAction({}, ctx)).toBe("ask");
    expect(leftOutAction({ about: "   " }, ctx)).toBe("ask");
    expect(leftOutAction({ about: null }, ctx)).toBe("ask");
  });

  it("can do nothing for an unread part without the AI, or one it couldn't find", () => {
    expect(leftOutAction({}, { ...ctx, canAsk: false })).toBe("none");
    expect(leftOutAction({}, { ...ctx, notFound: true })).toBe("none");
  });

  it("ignores clicks while adding or asking", () => {
    expect(leftOutAction({ about: "…" }, { ...ctx, busy: true })).toBe("busy");
    expect(leftOutAction({}, { ...ctx, busy: true })).toBe("busy");
  });

  it("still lets a part be added without the AI once its words are known", () => {
    expect(leftOutAction({ about: "…" }, { ...ctx, canAsk: false })).toBe("add");
  });
});

describe("leftOutHint and leftOutButton", () => {
  it("says what a click will do", () => {
    expect(leftOutHint("add", ctx)).toBe("Click to add it to your summary");
    expect(leftOutHint("added", ctx)).toBe("✓ In your summary");
    expect(leftOutHint("ask", ctx)).toBe("Click to find out what it said");
    expect(leftOutHint("busy", ctx)).toBeNull();
  });

  it("points to preparing again only when nothing here can read the part", () => {
    expect(leftOutHint("none", { canAsk: false, notFound: false })).toBe(
      "Prepare this lecture again with AI to see what it said.",
    );
    expect(leftOutHint("none", { canAsk: true, notFound: true })).toBeNull();
    expect(leftOutHint("none", { canAsk: false, notFound: true })).toBeNull();
  });

  it("gives touch screens a button only when there is something to do", () => {
    expect(leftOutButton("add")).toBe("Add to summary");
    expect(leftOutButton("ask")).toBe("Find out what it said");
    expect(leftOutButton("added")).toBeNull();
    expect(leftOutButton("none")).toBeNull();
    expect(leftOutButton("busy")).toBeNull();
  });
});

describe("labels", () => {
  it("names a part with where it was", () => {
    expect(partLabel({ what: "Module 3 aims", where: "slide 2" })).toBe("Module 3 aims · slide 2");
    expect(partLabel({ what: "Housekeeping", where: "  " })).toBe("Housekeeping");
  });

  it("counts parts", () => {
    expect(partsLabel(1)).toBe("1 part");
    expect(partsLabel(3)).toBe("3 parts");
  });

  it("keys repeated parts apart, keeping the first key stable", () => {
    const keys = partKeys([
      { what: "Aims", where: "slide 1" },
      { what: "Aims", where: "slide 9" },
      { what: "Aims", where: "slide 1" },
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(partKeys([{ what: "Aims", where: "slide 1" }])[0]);
  });

  it("shows waiting time in seconds, then minutes", () => {
    expect(waited(0)).toBe("0s");
    expect(waited(8_900)).toBe("8s");
    expect(waited(65_000)).toBe("1m 05s");
    expect(waited(-50)).toBe("0s");
  });
});

describe("placeCard", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 320, height: 200 };
  const chip = (top: number, left: number) => ({ top, bottom: top + 21, left, right: left + 120 });

  it("goes below the chip, lined up with its left edge", () => {
    expect(placeCard(chip(100, 300), size, viewport)).toEqual({ top: 127, left: 300, side: "below" });
  });

  it("goes above when there is no room below", () => {
    expect(placeCard(chip(700, 300), size, viewport)).toEqual({ top: 494, left: 300, side: "above" });
  });

  it("stays below when neither side fits but below has more room", () => {
    const tall = { width: 320, height: 900 };
    const placed = placeCard(chip(300, 300), tall, viewport);
    expect(placed.side).toBe("below");
    // Too tall for the window: pinned to the top margin, scrolling inside itself.
    expect(placed.top).toBe(8);
  });

  it("is kept inside the window at the right edge and on a narrow screen", () => {
    expect(placeCard(chip(100, 900), size, viewport).left).toBe(1000 - 8 - 320);
    expect(placeCard(chip(100, 20), size, { width: 300, height: 800 }).left).toBe(8);
  });
});
