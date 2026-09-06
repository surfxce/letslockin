/**
 * The geometric mean is the whole point of the scoring system: averaging 0 and 10
 * gives 5, which flatters an answer that would have scored nothing in the exam.
 * Multiplying and taking the nth root does not.
 */
export function geometricMean(marks: number[]): number {
  if (marks.length === 0) {
    throw new Error("geometricMean needs at least one mark");
  }
  if (marks.some((m) => !Number.isFinite(m) || m < 0)) {
    throw new Error(`geometricMean needs non-negative finite marks, got ${JSON.stringify(marks)}`);
  }
  // A single zero zeroes the attempt. That is the behaviour, not an edge case.
  if (marks.some((m) => m === 0)) return 0;

  // Direct product rather than log-space: marks are 0-10 and n is small, so there
  // is no overflow risk, and exp(log(...)) would return 6.000000000000001 for [4, 9].
  const product = marks.reduce((acc, m) => acc * m, 1);
  return Math.pow(product, 1 / marks.length);
}

/** Displayed value. Store the raw one; round only at the edge. */
export function roundMark(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
