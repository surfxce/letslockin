/** Microphone sound as a WAV file the speech models take. Client-safe. */

export const SPEECH_RATE = 16_000;

/** Averages down to `to` samples a second; good enough for speech. */
export function downsample(samples: Float32Array, from: number, to = SPEECH_RATE): Float32Array {
  if (from <= to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/**
 * downsample(), a piece at a time as the microphone gives them: the same samples as
 * downsampling the whole recording at once, so nothing slips at the joins.
 */
export function streamDownsampler(from: number, to = SPEECH_RATE): (piece: Float32Array) => Float32Array {
  if (from <= to) return (piece) => piece;
  const ratio = from / to;
  // Sound not used up yet, which starts `base` samples into the recording.
  let rest = new Float32Array(0);
  let base = 0;
  let made = 0;
  return (piece) => {
    const input = joinChunks([rest, piece]);
    const total = base + input.length;
    const out: number[] = [];
    while (Math.floor((made + 1) * ratio) <= total) {
      const start = Math.floor(made * ratio) - base;
      const end = Math.floor((made + 1) * ratio) - base;
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out.push(sum / Math.max(1, end - start));
      made++;
    }
    const used = Math.floor(made * ratio) - base;
    rest = input.slice(used);
    base += used;
    return Float32Array.from(out);
  };
}

/** 16-bit little-endian PCM with no header: how sound goes to be heard live. */
export function pcm16(samples: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return view.buffer;
}

/** 16-bit mono PCM in a WAV container. */
export function encodeWav(samples: Float32Array, rate = SPEECH_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  new Uint8Array(buffer).set(new Uint8Array(pcm16(samples)), 44);
  return buffer;
}

/** Joins the recorder's chunks into one run of samples. */
export function joinChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** True when a WAV body looks like one this page made: RIFF/WAVE, and not too long. */
export function looksLikeWav(bytes: Uint8Array, maxSeconds = 600): boolean {
  if (bytes.length < 44 || bytes.length > 44 + maxSeconds * SPEECH_RATE * 2 * 3) return false;
  const tag = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}
