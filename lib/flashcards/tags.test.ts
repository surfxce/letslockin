import { describe, expect, it } from "vitest";

import { addTags, removeTag, storeTags, tagList } from "@/lib/flashcards/tags";

describe("tags", () => {
  it("stores typed tags padded, deduplicated and cleaned", () => {
    expect(storeTags("renal, Drugs #week3 renal")).toBe(" renal Drugs week3 ");
    expect(storeTags("  ")).toBe("");
    expect(storeTags(["Renal::IgA nephropathy", "a<b>"])).toBe(" Renal::IgA_nephropathy ab ");
  });
  it("adds and removes whole tags", () => {
    expect(tagList(addTags(" renal ", ["drugs", "RENAL"]))).toEqual(["renal", "drugs"]);
    expect(removeTag(" renal renal_2 ", "renal")).toBe(" renal_2 ");
  });
});
