/** Option letters for multiple choice. */
export const LETTERS = ["A", "B", "C", "D", "E"];

/** How an exam chooses its questions: spread like the real one, or aimed at weak spots. */
export type ExamFocus = "mixed" | "weak";

export interface ExamCandidate {
  id: string;
  lectureId: string;
  /** Times it has been answered before. */
  seen: number;
  /** Its latest mark out of 10 (an MCQ is 10 or 0); null if never marked. */
  lastMark: number | null;
}

export function shuffle<T>(items: readonly T[], random = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Picks `count` questions spread across the lectures: one from each lecture in turn,
 * then a second from each, so no lecture gets two before every lecture has one.
 * Lectures come in a random order and, within each, questions not yet seen first.
 * With `weak`, the weakest lectures (by drill score; never drilled counts as weakest)
 * go first, and within each the questions answered worst — one never answered counts
 * as middling, so a question failed before comes back ahead of a new one.
 */
export function pickExamItems(
  candidates: readonly ExamCandidate[],
  count: number,
  opts: { focus: ExamFocus; lectureScore?: ReadonlyMap<string, number | null>; random?: () => number },
): string[] {
  const random = opts.random ?? Math.random;
  if (count <= 0 || candidates.length === 0) return [];
  const byLecture = new Map<string, ExamCandidate[]>();
  for (const c of shuffle(candidates, random)) byLecture.set(c.lectureId, [...(byLecture.get(c.lectureId) ?? []), c]);

  const weak = opts.focus === "weak";
  const markKey = (m: number | null) => (m === null ? 5 : m);
  for (const list of byLecture.values()) {
    // Stable sort over a shuffled list: ties stay in a random order.
    list.sort((a, b) => (weak ? markKey(a.lastMark) - markKey(b.lastMark) : 0) || a.seen - b.seen);
  }

  let lectures = shuffle([...byLecture.keys()], random);
  if (weak) {
    const score = (id: string) => opts.lectureScore?.get(id) ?? -1;
    lectures = lectures.sort((a, b) => score(a) - score(b));
  }

  const picked: string[] = [];
  for (let round = 0; picked.length < count; round++) {
    let took = false;
    for (const id of lectures) {
      const item = byLecture.get(id)![round];
      if (!item) continue;
      picked.push(item.id);
      took = true;
      if (picked.length === count) break;
    }
    if (!took) break;
  }
  return picked;
}

/** A rough exam time: a minute and a half per MCQ and fifteen minutes per LAQ. */
export function suggestedMinutes(mcqs: number, laqs: number): number {
  return Math.max(5, Math.ceil((mcqs * 1.5 + laqs * 15) / 5) * 5);
}
