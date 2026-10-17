import { describe, expect, it } from "vitest";

import { isLooping } from "./looping";

describe("isLooping", () => {
  it("catches a phrase said over and over", () => {
    const stuck = '{"stem": "Explain IgA nephropathy. ' + "The mesangial IgA deposits cause injury. ".repeat(12);
    expect(isLooping(stuck)).toBe(true);
  });

  it("catches a long run of blank space", () => {
    expect(isLooping('{"questions": [' + " \n".repeat(150))).toBe(true);
  });

  it("leaves ordinary writing alone, even when it is structured alike", () => {
    const criteria = Array.from({ length: 8 }, (_, i) => `{"point": "Names mechanism ${i + 1} of glomerular injury", "marks": ${i % 3}}`).join(", ");
    expect(isLooping(`{"criteria": [${criteria}]}`)).toBe(false);
    expect(isLooping("| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n".repeat(3))).toBe(false);
    expect(isLooping("Short text.")).toBe(false);
  });
});
