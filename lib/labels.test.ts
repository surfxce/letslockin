import { describe, expect, it } from "vitest";

import { groupLabels, type OcrWord } from "@/lib/labels";

const word = (text: string, x0: number, x1: number, y0 = 100, y1 = 120, confidence = 90): OcrWord => ({ text, confidence, bbox: { x0, y0, x1, y1 } });

describe("groupLabels", () => {
  it("splits a line at wide gaps and pads each label", () => {
    const boxes = groupLabels([[word("Afferent", 40, 137), word("arteriole", 147, 245), word("Efferent", 622, 717), word("arteriole", 727, 825)]], 1000, 500);
    expect(boxes.map((b) => b.text)).toEqual(["Afferent arteriole", "Efferent arteriole"]);
    expect(boxes[0].x).toBeCloseTo(0.035, 3);
    expect(boxes[0].y).toBeCloseTo(0.19, 3);
    expect(boxes[0].x + boxes[0].w).toBeCloseTo(0.25, 3);
  });

  it("leaves out sentences, noise and unsure words", () => {
    const sentence = "The glomerulus filters plasma through three layers of barrier".split(" ").map((t, i) => word(t, i * 60, i * 60 + 50));
    expect(groupLabels([sentence], 1000, 500)).toEqual([]);
    expect(groupLabels([[word("|", 10, 14)], [word("x", 10, 20)]], 1000, 500)).toEqual([]);
    expect(groupLabels([[word("Podocyte", 10, 90, 100, 120, 30)]], 1000, 500)).toEqual([]);
  });
});
