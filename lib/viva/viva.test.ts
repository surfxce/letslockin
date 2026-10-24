import { describe, expect, it } from "vitest";

import { readPlan, readTurns, vivaAnswerText } from "@/lib/viva/schema";
import { downsample, encodeWav, joinChunks, looksLikeWav, pcm16, streamDownsampler } from "@/lib/viva/wav";

describe("viva", () => {
  it("marks everything the student said, with the follow-ups between", () => {
    const text = vivaAnswerText([
      { role: "examiner", text: "Let's begin. What is IgA nephropathy?" },
      { role: "student", text: "IgA deposits in the mesangium." },
      { role: "examiner", text: "What does that cause?" },
      { role: "student", text: " Haematuria. " },
      { role: "examiner", text: "Okay, thank you." },
    ]);
    expect(text).toContain("Student: IgA deposits in the mesangium.\n\nExaminer: What does that cause?\n\nStudent: Haematuria.");
    expect(text).not.toContain("Let's begin");
    expect(text.endsWith("Student: Haematuria.")).toBe(true);
    expect(vivaAnswerText([{ role: "examiner", text: "What is it?" }])).toBe("");
  });

  it("reads plans and turns tolerantly", () => {
    expect(readPlan('[{"questionId":"q","lectureId":"l"},{"bad":1}]')).toEqual([{ questionId: "q", lectureId: "l" }]);
    expect(readTurns("not json")).toEqual([]);
    expect(readTurns('[{"role":"student","text":"hi","questionId":"q","at":"x"},{"role":"x","text":"y"}]')).toHaveLength(1);
  });

  it("makes a 16 kHz mono WAV from microphone chunks", () => {
    const at48k = joinChunks([new Float32Array(24_000).fill(0.5), new Float32Array(24_000).fill(-0.5)]);
    const speech = downsample(at48k, 48_000);
    expect(speech.length).toBe(16_000);
    expect(speech[0]).toBeCloseTo(0.5);
    expect(speech[15_999]).toBeCloseTo(-0.5);
    const wav = new Uint8Array(encodeWav(speech));
    expect(wav.length).toBe(44 + 32_000);
    expect(looksLikeWav(wav)).toBe(true);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44, true)).toBe(Math.floor(0.5 * 0x7fff));
    expect(looksLikeWav(new Uint8Array(100))).toBe(false);
  });

  it("downsamples the microphone a piece at a time exactly as all at once", () => {
    for (const rate of [44_100, 48_000, 16_000]) {
      const sound = Float32Array.from({ length: 50_000 }, (_, i) => Math.sin(i / 7) * ((i % 13) / 13));
      const whole = downsample(sound, rate);
      const piecewise = streamDownsampler(rate);
      const pieces: Float32Array[] = [];
      for (let at = 0, n = 1; at < sound.length; at += n, n = (n * 7919) % 5000 || 1) pieces.push(piecewise(sound.slice(at, at + n)));
      const joined = joinChunks(pieces);
      expect(joined.length).toBe(whole.length);
      expect(joined.every((v, i) => Math.abs(v - whole[i]) < 1e-6)).toBe(true);
    }
  });

  it("sends live sound as bare 16-bit PCM", () => {
    const view = new DataView(pcm16(Float32Array.from([0, 1, -1, 2])));
    expect(view.byteLength).toBe(8);
    expect([0, 2, 4, 6].map((o) => view.getInt16(o, true))).toEqual([0, 0x7fff, -0x8000, 0x7fff]);
  });
});
