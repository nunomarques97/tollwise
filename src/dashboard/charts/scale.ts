// Linear scale and "nice" tick math shared by every chart (DESIGN.md §12.3). Pure: no DOM, so it runs
// unchanged under Node's test runner. Ticks always include zero; when the data has a value below zero
// (negative savings) the scale extends below zero using the same step, per DESIGN.md's negative-savings
// rule -- the axis never clips a negative column.

/** A step of 1, 2 or 5 times a power of ten: the classic "nice number" ladder for axis ticks. */
export function niceStep(rawStep: number): number {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
}

export interface Ticks {
  readonly step: number;
  /** Always <= 0; below zero only when a negative value was passed in. */
  readonly min: number;
  /** Always >= the largest tick needed to cover `maxValue`; 1 when every value was zero. */
  readonly max: number;
  /** Ascending, always includes 0. */
  readonly values: readonly number[];
}

/** Rounds to a fixed number of decimals to remove floating-point noise from repeated addition. */
function clean(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * "Nice" ticks covering [min(minValue, 0), max(maxValue, 0)], aiming for about `targetCount` steps
 * above zero. `targetCount` shapes the step size; the exact number of ticks returned depends on how
 * evenly the step divides the range, same as any nice-number axis.
 */
export function computeTicks(maxValue: number, minValue: number, targetCount: number): Ticks {
  const positiveMax = Math.max(maxValue, 0);
  const negativeMin = Math.min(minValue, 0);
  if (positiveMax === 0 && negativeMin === 0) return { step: 1, min: 0, max: 1, values: [0] };

  const step = niceStep((positiveMax - negativeMin) / Math.max(1, targetCount));
  const max = Math.ceil(positiveMax / step) * step;
  const min = negativeMin < 0 ? -Math.ceil(-negativeMin / step) * step : 0;
  const startIndex = Math.round(min / step);
  const endIndex = Math.round(max / step);
  const values: number[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) values.push(clean(index * step));
  return { step, min: clean(min), max: clean(max), values };
}

/** A tick's label: "$0", "$0.02", "-$0.0002", with as many decimals as the step needs (2 to 6). */
export function formatAxisTick(value: number, step: number): string {
  if (value === 0) return '$0';
  const decimals = Math.min(6, Math.max(2, -Math.floor(Math.log10(step))));
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}
