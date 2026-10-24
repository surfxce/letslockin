import { describe, expect, it } from "vitest";

import { strictSchema } from "./strict-schema";

describe("strictSchema", () => {
  it("makes every property required, and no others allowed, all the way down", () => {
    const schema = {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              stem: { type: "string" },
              rubric: { type: "object", properties: { totalMarks: { const: 10 } } },
              note: { oneOf: [{ type: "object", properties: { text: { type: "string" } } }, { type: "null" }] },
            },
          },
        },
      },
    };
    const strict = strictSchema(schema) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(strict.required).toEqual(["questions"]);
    expect(strict.additionalProperties).toBe(false);
    const item = strict.properties.questions.items;
    expect(item.required).toEqual(["stem", "rubric", "note"]);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.rubric.required).toEqual(["totalMarks"]);
    expect(item.properties.note.oneOf[0].required).toEqual(["text"]);
    expect(item.properties.note.oneOf[1]).toEqual({ type: "null" });
    // The original is left as it was.
    expect((schema as Record<string, unknown>).required).toBeUndefined();
  });

  it("keeps extra properties where the schema allows them", () => {
    const strict = strictSchema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } });
    expect(strict).toMatchObject({ required: ["a"], additionalProperties: { type: "number" } });
  });
});
