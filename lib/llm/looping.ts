/**
 * Whether a model has got stuck: the end of what it has written is the same stretch
 * over and over (at least four times, 400 characters in all), or a long run of blank
 * space. A model that has stopped making progress then fails in seconds instead of
 * writing until its limit. The MLX engine checks the same way
 * (swift/LockinEngine/Sources/LockinEngine/main.swift, `isLooping`).
 */
export function isLooping(text: string): boolean {
  const tail = text.slice(-1600);
  if (/\s{200,}$/.test(tail)) return true;
  for (let period = 8; period <= 300; period++) {
    const repeats = Math.max(4, Math.ceil(400 / period));
    if (period * repeats > tail.length) break;
    const unit = tail.slice(-period);
    if (!unit.trim()) continue;
    let k = 1;
    while (k < repeats && tail.slice(tail.length - (k + 1) * period, tail.length - k * period) === unit) k++;
    if (k >= repeats) return true;
  }
  return false;
}

export const LOOPING_MESSAGE = "the model started repeating itself — try again, or a larger model";
