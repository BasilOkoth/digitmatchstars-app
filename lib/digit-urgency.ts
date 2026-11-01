/** Smoothed historical inter-arrival estimate, in ticks. This is descriptive,
 * not a future-arrival guarantee: independent digits do not become due. */
export function estimateArrivalTicks(history: number[]): Record<number, number> {
  const result: Record<number, number> = {};
  for (let digit = 0; digit < 10; digit++) {
    const positions: number[] = [];
    history.forEach((d, index) => { if (d === digit) positions.push(index); });
    if (positions.length < 3) continue; // insufficient observations
    const gaps = positions.slice(1).map((pos, i) => pos - positions[i]);
    // Regularise toward the 10-tick independent-digit baseline to avoid
    // claiming that a few short gaps establish predictive 'urgency'.
    const estimate = (gaps.reduce((sum, gap) => sum + gap, 0) + 80) / (gaps.length + 8);
    result[digit] = Math.max(1, Math.round(estimate));
  }
  return result;
}
