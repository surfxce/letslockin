import { describe, expect, it } from "vitest";

import { DEFAULT_STYLE, QWEN_VOICES, readModel, readStyle, readVoice, usableModel } from "@/lib/voice/choice";

describe("viva voice", () => {
  it("offers only Qwen voices, the native English ones first", () => {
    expect(QWEN_VOICES.slice(0, 2).map((v) => v.id)).toEqual(["aiden", "ryan"]);
    expect(QWEN_VOICES).toHaveLength(9);
  });

  it("reads a stored choice safely, including ones from before", () => {
    expect(readVoice("serena")).toBe("serena");
    expect(readVoice("natural:ryan")).toBe("ryan");
    expect(readVoice("system:com.apple.voice.premium.en-US.Zoe")).toBe("aiden");
    expect(readVoice("auto")).toBe("aiden");
    expect(readVoice(undefined)).toBe("aiden");
    expect(readModel("0.6b")).toBe("0.6b");
    expect(readModel("anything")).toBe("1.7b");
    expect(readStyle("  Brisk  and\nformal ")).toBe("Brisk and formal");
    expect(readStyle("")).toBe(DEFAULT_STYLE);
  });

  it("says a line with the chosen model, else whichever is downloaded", () => {
    expect(usableModel("1.7b", { "1.7b": true, "0.6b": true })).toBe("1.7b");
    expect(usableModel("1.7b", { "1.7b": false, "0.6b": true })).toBe("0.6b");
    expect(usableModel("0.6b", { "1.7b": true, "0.6b": false })).toBe("1.7b");
    expect(usableModel("1.7b", { "1.7b": false, "0.6b": false })).toBeNull();
  });
});
