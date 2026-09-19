// The Savings view's "Spend by provider" / "Spend by model" cards (DESIGN.md §12.5): bar widths and
// shares computed from the breakdown groups the API already ranked, the lower-bound and unknown-price
// notes, and the accessible row list / table text. Pure: no DOM, so it runs unchanged under Node's test
// runner; the element in ../elements only draws it.

import type { BreakdownGroup, BreakdownResponse } from '../api.ts';
import { type FormattedUsd, formatCount, formatUsd, parseMicros, plural } from '../format.ts';
import type { RangeId } from '../ranges.ts';
import { rangeOption } from '../ranges.ts';

/** More than this many rows are collapsed behind "Show all N" (DESIGN.md §12.5). */
export const VISIBLE_ROWS = 8;

export type Bar = { readonly kind: 'unknown' } | { readonly kind: 'value'; readonly percent: number };

export interface BreakdownRow {
  readonly key: string;
  readonly bar: Bar;
  readonly value: FormattedUsd;
  /** '--' when spend is unknown. */
  readonly share: string;
  readonly note: string | undefined;
  readonly noteIsWarning: boolean;
}

export interface BreakdownView {
  /** The range these groups cover; a new range collapses "Show all N" again. */
  readonly range: RangeId;
  readonly rows: readonly BreakdownRow[];
  readonly visibleRows: readonly BreakdownRow[];
  readonly hiddenCount: number;
  readonly footnote: string | undefined;
  readonly ariaLabel: string;
  readonly tableRows: readonly { key: string; requests: string; spend: FormattedUsd; unpriced: string }[];
}

function rowOf(group: BreakdownGroup, maxKnownMicros: number, totalKnownMicros: number): BreakdownRow {
  const micros = parseMicros(group.spend_usd);
  if (micros === null) {
    return {
      key: group.key,
      bar: { kind: 'unknown' },
      value: formatUsd(group.spend_usd),
      share: '—',
      note: `${plural(group.unpriced_requests, 'request', 'requests')}, no catalog price`,
      noteIsWarning: true,
    };
  }
  const percent = maxKnownMicros === 0 ? 0 : (micros / maxKnownMicros) * 100;
  const share = totalKnownMicros === 0 ? '0%' : `${Math.round((micros / totalKnownMicros) * 100)}%`;
  const note =
    group.unpriced_requests > 0
      ? `Lower bound: ${plural(group.unpriced_requests, 'request', 'requests')} unpriced`
      : undefined;
  return {
    key: group.key,
    bar: { kind: 'value', percent },
    value: formatUsd(group.spend_usd),
    share,
    note,
    noteIsWarning: note !== undefined,
  };
}

/** "Spend by provider over the last hour, 5 bars, highest first: openrouter $0.310, ..., and 2 more." */
function ariaLabelOf(what: 'provider' | 'model', range: RangeId, groups: readonly BreakdownGroup[]): string {
  const known = groups.filter((group) => parseMicros(group.spend_usd) !== null);
  const unknownCount = groups.length - known.length;
  const head = `Spend by ${what} over the last ${rangeOption(range).span}, ${formatCount(groups.length)} bars, highest first: `;
  const shown = known.slice(0, 3).map((group) => `${group.key} ${formatUsd(group.spend_usd).text}`);
  const more = known.length > 3 ? `, and ${known.length - 3} more` : '';
  const unknownPart = unknownCount > 0 ? `; ${plural(unknownCount, 'group', 'groups')} with unknown spend` : '';
  return `${head}${shown.join(', ')}${more}${unknownPart}.`;
}

/** The rows, bars, footnote and accessible text for one breakdown card. */
export function buildBreakdown(response: BreakdownResponse, what: 'provider' | 'model'): BreakdownView {
  const groups = response.groups;
  const knownMicros = groups
    .map((group) => parseMicros(group.spend_usd))
    .filter((value): value is number => value !== null);
  const maxKnownMicros = knownMicros.length === 0 ? 0 : Math.max(...knownMicros);
  const totalKnownMicros = knownMicros.reduce((sum, value) => sum + value, 0);

  const rows = groups.map((group) => rowOf(group, maxKnownMicros, totalKnownMicros));
  const visibleRows = rows.slice(0, VISIBLE_ROWS);
  const hiddenCount = rows.length - visibleRows.length;

  return {
    range: response.range,
    rows,
    visibleRows,
    hiddenCount,
    footnote:
      response.unrouted_requests > 0
        ? `${plural(response.unrouted_requests, 'request', 'requests')} refused before routing are not in these bars.`
        : undefined,
    ariaLabel: ariaLabelOf(what, response.range, groups),
    tableRows: groups.map((group) => ({
      key: group.key,
      requests: formatCount(group.requests),
      spend: formatUsd(group.spend_usd),
      unpriced: formatCount(group.unpriced_requests),
    })),
  };
}

/**
 * Whether "Show all N" stays expanded when a card draws `range`: a live refresh of the range already
 * shown keeps the rows the reader revealed; a different range (or nothing shown yet) starts collapsed.
 */
export function keepExpanded(expanded: boolean, shownRange: RangeId | undefined, range: RangeId): boolean {
  return expanded && shownRange === range;
}

/** The rows a card draws: every row once expanded, else the first VISIBLE_ROWS. */
export function rowsToDraw(view: BreakdownView, expanded: boolean): readonly BreakdownRow[] {
  return expanded ? view.rows : view.visibleRows;
}
