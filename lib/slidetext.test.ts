import { describe, expect, it } from "vitest";

import { blankPages, cleanOcr, mergePages, NO_WORDS } from "./slidetext";

const deck = "--- Page 1 ---\nAppetite and Satiety\n\n--- Page 3 ---\nLeptin";

describe("slide text", () => {
  it("finds the pages that are pictures nobody has read", () => {
    expect(blankPages(deck, 4)).toEqual([2, 4]);
    expect(blankPages("", 2)).toEqual([1, 2]);
  });

  it("keeps the words and drops the symbols shapes are read as", () => {
    expect(cleanOcr("Ghrelin rises before meals\nand acts on the arcuate @®\n—  ©\n")).toBe(
      "Ghrelin rises before meals\nand acts on the arcuate",
    );
  });

  it("puts read pages back in order, marking ones with no words so they are not read again", () => {
    const merged = mergePages(deck, [
      { page: 4, text: "" },
      { page: 2, text: "Ghrelin rises before meals" },
    ]);
    expect(merged).toBe(
      "--- Page 1 ---\nAppetite and Satiety\n\n" +
        "--- Page 2 ---\n(words read from the slide's picture)\nGhrelin rises before meals\n\n" +
        "--- Page 3 ---\nLeptin\n\n" +
        `--- Page 4 ---\n${NO_WORDS}`,
    );
    expect(blankPages(merged, 4)).toEqual([]);
  });
});
