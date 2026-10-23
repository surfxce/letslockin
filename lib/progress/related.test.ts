import { describe, expect, it } from "vitest";

import { layoutMap, MAP_H, MAP_W } from "@/lib/progress/layout";
import { relate, terms } from "@/lib/progress/related";

describe("terms", () => {
  it("drops Markdown, stop words and numbers, and folds plurals", () => {
    expect(terms("immune complexes, arteries, glomerulus")).toEqual(["immune", "complex", "artery", "glomerulus"]);
    expect(terms("## The kidneys\n\nThe **glomeruli** filter blood. ![x](slide:12) Slide 4 shows 120 cells.")).toEqual([
      "kidney",
      "glomeruli",
      "filter",
      "blood",
      "cell",
    ]);
  });
});

describe("relate", () => {
  const docs = [
    { id: "iga", text: "IgA nephropathy: galactose-deficient IgA1 immune complexes deposit in the mesangium. Haematuria after infection. Kidney." },
    { id: "hsp", text: "Henoch-Schonlein purpura: IgA1 immune complexes deposit in the mesangium and skin vessels. Kidney." },
    { id: "chol", text: "Cholinergic drugs: muscarinic agonists and acetylcholinesterase inhibitors. Kidney." },
  ];
  it("links lectures that share distinctive words, and names them", () => {
    const links = relate(docs, { floor: 0.05 });
    expect(links[0]).toMatchObject({ a: "iga", b: "hsp" });
    expect(links[0].shared).toEqual(expect.arrayContaining(["iga1", "mesangium"]));
    expect(links[0].score).toBeGreaterThan(0.2);
    // "kidney" is in every lecture: it barely links the drug lecture to anything.
    expect(links.find((l) => l.a === "iga" && l.b === "chol")?.score ?? 0).toBeLessThan(0.1);
  });
  it("needs two lectures", () => {
    expect(relate([docs[0]])).toEqual([]);
  });
});

describe("layoutMap", () => {
  it("keeps every lecture inside the map, linked ones closer", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id, group: id === "e" ? "other" : "c1" }));
    const pos = layoutMap(nodes, [{ a: "a", b: "b", score: 0.9 }]);
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(MAP_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(MAP_H);
    }
    const d = (x: string, y: string) => Math.hypot(pos.get(x)!.x - pos.get(y)!.x, pos.get(x)!.y - pos.get(y)!.y);
    expect(d("a", "b")).toBeLessThan(d("a", "c"));
    expect(layoutMap(nodes, [])).toEqual(layoutMap(nodes, []));
  });
});

describe("streak", () => {
  it("counts days in a row up to today, or yesterday if today hasn't started", async () => {
    const { streak } = await import("@/lib/progress/data");
    const now = new Date(2026, 9, 20, 15);
    const d = (offset: number) => new Date(2026, 9, 20 + offset, 10);
    expect(streak([d(0), d(-1), d(-2), d(-4)], now)).toBe(3);
    expect(streak([d(-1), d(-2)], now)).toBe(2);
    expect(streak([d(-3)], now)).toBe(0);
  });
});
