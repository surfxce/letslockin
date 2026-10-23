import { describe, expect, it } from "vitest";

import { goodVoices, isNovelty, readChoice, voiceScore } from "@/lib/voice/choice";

describe("viva voice", () => {
  const v = (name: string, lang = "en-US", extra: { default?: boolean; localService?: boolean } = {}) => ({ name, lang, ...extra });

  it("never picks Albert or the Mac's other novelty voices", () => {
    for (const name of ["Albert", "Bad News", "Zarvox", "Bells", "Grandpa (English (US))", "Whisper"]) expect(isNovelty(v(name))).toBe(true);
    const list = goodVoices([v("Albert", "en-US", { default: true }), v("Bad News"), v("Samantha"), v("Thomas", "fr-FR")]);
    expect(list.map((x) => x.name)).toEqual(["Samantha"]);
  });

  it("puts Premium and Enhanced voices first, then this region's", () => {
    const list = goodVoices([v("Daniel", "en-GB"), v("Karen", "en-AU"), v("Zoe (Premium)"), v("Ava (Enhanced)")], "en-AU");
    expect(list.map((x) => x.name)).toEqual(["Zoe (Premium)", "Ava (Enhanced)", "Karen", "Daniel"]);
    expect(voiceScore(v("Albert"))).toBe(-1);
  });

  it("reads a stored choice safely", () => {
    expect(readChoice("natural:aiden")).toBe("natural:aiden");
    expect(readChoice("system:com.apple.voice.premium.en-US.Zoe")).toBe("system:com.apple.voice.premium.en-US.Zoe");
    expect(readChoice("nonsense")).toBe("auto");
    expect(readChoice(undefined)).toBe("auto");
  });
});
