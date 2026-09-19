// The horizontal layout every bucketed chart shares (DESIGN.md §12.3): one slot per bucket, a small gap
// between bars that shrinks as slots get narrower, and never disappears below 1 px. Pure: no DOM.

export interface BucketLayout {
  readonly slot: number;
  readonly barWidth: number;
  readonly gap: number;
  /** The left edge of the bar (or the line's slot) for bucket `index`. */
  x(index: number): number;
  /** The horizontal centre of bucket `index`'s slot -- where a line point or an x-axis label sits. */
  center(index: number): number;
}

/**
 * Lays out `count` equal slots across `plotWidth`, starting at `left`. Gap: 2 px when a slot is at
 * least 8 px wide, 1 px when 4-8 px, none below (DESIGN.md §12.3); the bar itself is never below 1 px.
 */
export function bucketLayout(plotWidth: number, left: number, count: number): BucketLayout {
  const slot = count > 0 ? plotWidth / count : plotWidth;
  const gap = slot >= 8 ? 2 : slot >= 4 ? 1 : 0;
  const barWidth = Math.max(1, slot - gap);
  const x = (index: number): number => left + index * slot + gap / 2;
  return { slot, barWidth, gap, x, center: (index) => x(index) + barWidth / 2 };
}
