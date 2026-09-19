// The time ranges the metrics API accepts, their labels, and how the selected one is kept in the URL
// fragment (#range=7d) so a reload keeps it. Pure: no DOM access.

export type RangeId = '1h' | '24h' | '7d' | '30d';

export interface RangeOption {
  readonly id: RangeId;
  /** The label of the range selector's button. */
  readonly label: string;
  /** Completes "Saved in the last ...". */
  readonly span: string;
}

export const RANGES: readonly RangeOption[] = [
  { id: '1h', label: '1 hour', span: 'hour' },
  { id: '24h', label: '24 hours', span: '24 hours' },
  { id: '7d', label: '7 days', span: '7 days' },
  { id: '30d', label: '30 days', span: '30 days' },
];

/** The range the page shows when the fragment names none: the API's own default. */
export const DEFAULT_RANGE: RangeId = '24h';

export function isRangeId(value: string): value is RangeId {
  return RANGES.some((range) => range.id === value);
}

export function rangeOption(id: RangeId): RangeOption {
  return RANGES.find((range) => range.id === id) ?? (RANGES[1] as RangeOption);
}

/** The range named by a URL fragment such as "#range=7d"; the default for anything else. */
export function rangeFromHash(hash: string): RangeId {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('range');
  return value !== null && isRangeId(value) ? value : DEFAULT_RANGE;
}

/** The URL fragment that keeps `range`: "#range=7d". */
export function hashForRange(range: RangeId): string {
  return `#range=${range}`;
}

/** The heading of the savings block: "Saved in the last 24 hours". */
export function savedHeading(range: RangeId): string {
  return `Saved in the last ${rangeOption(range).span}`;
}

/**
 * The option a key press on the range selector moves to, or undefined for keys the selector does not
 * handle. Arrow keys wrap around; Home and End go to the first and last option.
 */
export function rangeAfterKey(current: RangeId, key: string): RangeId | undefined {
  const index = RANGES.findIndex((range) => range.id === current);
  const last = RANGES.length - 1;
  let next: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = index >= last ? 0 : index + 1;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = index <= 0 ? last : index - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return undefined;
  }
  return RANGES[next]?.id;
}
