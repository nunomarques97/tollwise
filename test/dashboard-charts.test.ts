// The Savings view's chart helpers: the shared scale/layout math (no chart library, DESIGN.md §12) and
// the pure view models built from the timeseries and breakdown API shapes -- unknown savings must never
// show as $0, a negative bucket must never be mistaken for zero, and an empty range must not crash.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BreakdownResponse, Summary, TimeseriesBucket, TimeseriesResponse } from '../src/dashboard/api.ts';
import { buildBreakdown, keepExpanded, rowsToDraw, VISIBLE_ROWS } from '../src/dashboard/charts/breakdown-model.ts';
import { bucketLayout } from '../src/dashboard/charts/layout.ts';
import { computeTicks, formatAxisTick, niceStep } from '../src/dashboard/charts/scale.ts';
import {
  bucketForRange,
  bucketStartText,
  bucketWord,
  buildSavingsChartView,
  classifyBuckets,
  defaultReadout,
  readoutAt,
  type SavingsBucket,
  savingsAriaLabel,
  spendAriaLabel,
  spendGeometry,
  spendRuns,
  tableRows,
  xAxisLabels,
} from '../src/dashboard/charts/timeseries-model.ts';

/** The summary `npm run demo -- --count 240 --seed 7` produced (docs/design/mocks/README.md). */
const SUMMARY: Summary = {
  range: '1h',
  requests: 240,
  errors: 0,
  spend_usd: '0.022560',
  unpriced_requests: 0,
  baseline_usd: '0.022752',
  savings_usd: '0.000192',
  savings_percent: 0.84,
  unknown_savings_requests: 0,
  origin: { reported: 240, estimated: 0 },
  prices_verified_on: { oldest: '2026-09-19', newest: '2026-09-19' },
  substituted_requests: 0,
};

function bucket(overrides: Partial<TimeseriesBucket> = {}): TimeseriesBucket {
  return {
    bucket_start: '2026-09-19T13:00:00.000Z',
    requests: 4,
    errors: 0,
    spend_usd: '0.000400',
    unpriced_requests: 0,
    savings_usd: '0.000004',
    unknown_savings_requests: 0,
    ...overrides,
  };
}

describe('chart scale (nice ticks, DESIGN.md §12.3)', () => {
  test('niceStep rounds up to 1, 2, 5 or 10 times a power of ten', () => {
    assert.equal(niceStep(0.00013), 0.0002);
    assert.equal(niceStep(3), 5);
    assert.equal(niceStep(45), 50);
    assert.equal(niceStep(0), 1);
    assert.equal(niceStep(Number.NaN), 1);
  });

  test('all-zero data ticks at $0 only, never crashes on an empty range', () => {
    assert.deepEqual(computeTicks(0, 0, 3), { step: 1, min: 0, max: 1, values: [0] });
  });

  test('ticks always include 0 and cover the positive max', () => {
    const ticks = computeTicks(0.00018, 0, 3);
    assert.ok(ticks.values.includes(0));
    assert.ok(ticks.max >= 0.00018);
    assert.equal(ticks.min, 0);
  });

  test('a negative bucket extends the axis below zero by the same step, never clipped to zero', () => {
    const ticks = computeTicks(0.0001, -0.00025, 3);
    assert.ok(ticks.min < 0, 'the axis must reach below zero');
    assert.ok(ticks.min <= -0.00025);
    assert.ok(ticks.values.includes(0));
    assert.ok(ticks.values.some((value) => value < 0));
  });

  test('formatAxisTick: $0 at zero, decimals from the step, a leading minus below zero', () => {
    assert.equal(formatAxisTick(0, 0.0002), '$0');
    assert.equal(formatAxisTick(0.0002, 0.0002), '$0.0002');
    assert.equal(formatAxisTick(1, 1), '$1.00');
    assert.equal(formatAxisTick(-0.0002, 0.0002), '-$0.0002');
  });
});

describe('chart layout (bucket slots, DESIGN.md §12.3)', () => {
  test('the gap shrinks with the slot width, and the bar is never below 1 px', () => {
    assert.equal(bucketLayout(800, 72, 10).gap, 2); // slot 80: wide gap
    assert.equal(bucketLayout(48, 72, 10).gap, 1); // slot 4.8: narrow gap
    assert.equal(bucketLayout(20, 72, 10).gap, 0); // slot 2: no gap
    assert.ok(bucketLayout(1, 0, 100).barWidth >= 1);
  });

  test('x() and center() place bars left to right with no overlap', () => {
    const layout = bucketLayout(100, 10, 5);
    assert.equal(layout.x(0), 10 + layout.gap / 2);
    assert.equal(layout.center(1), layout.x(1) + layout.barWidth / 2);
    assert.ok(layout.x(1) > layout.x(0));
  });
});

describe('timeseries model: bucket selection and marks (DESIGN.md §12.2, §12.4)', () => {
  test('the bucket per range and width matches the DESIGN.md §12.2 table', () => {
    assert.equal(bucketForRange('1h', false), '1m');
    assert.equal(bucketForRange('1h', true), '5m');
    assert.equal(bucketForRange('24h', false), '1h');
    assert.equal(bucketForRange('24h', true), '1h');
    assert.equal(bucketForRange('7d', false), '1h');
    assert.equal(bucketForRange('7d', true), '1d');
    assert.equal(bucketForRange('30d', false), '1d');
    assert.equal(bucketForRange('30d', true), '1d');
  });

  test('bucketWord names the title bucket, the daily one says (UTC)', () => {
    assert.equal(bucketWord('1m'), 'minute');
    assert.equal(bucketWord('5m'), '5 minutes');
    assert.equal(bucketWord('1h'), 'hour');
    assert.equal(bucketWord('1d'), 'day (UTC)');
  });

  test('a bucket with no requests draws nothing and is never mistaken for zero', () => {
    const [empty] = classifyBuckets([bucket({ requests: 0, spend_usd: '0.000000', savings_usd: '0.000000' })]);
    assert.deepEqual(empty?.savings, { kind: 'empty' });
    assert.deepEqual(empty?.spend, { kind: 'gap' });
    assert.equal(empty?.leftOut, false);
  });

  test('unknown savings is its own mark, never a $0 value or a zero-height column', () => {
    const [unknown] = classifyBuckets([bucket({ savings_usd: 'unknown', unknown_savings_requests: 4 })]);
    assert.deepEqual(unknown?.savings, { kind: 'unknown' });
    assert.notDeepEqual(unknown?.savings, { kind: 'value', amount: 0 });
  });

  test('an exact $0.00 saving is its own "zero" mark, distinct from "unknown"', () => {
    const [zero] = classifyBuckets([bucket({ savings_usd: '0.000000' })]);
    assert.deepEqual(zero?.savings, { kind: 'zero' });
  });

  test('a negative saving keeps its sign and is never confused with zero or unknown', () => {
    const [negative] = classifyBuckets([bucket({ savings_usd: '-0.000248' })]);
    assert.deepEqual(negative?.savings, { kind: 'value', amount: -0.000248 });
    assert.notDeepEqual(negative?.savings, { kind: 'zero' });
  });

  test('the left-out strip draws only when savings are known but some requests were left out', () => {
    const [known] = classifyBuckets([bucket({ unknown_savings_requests: 2 })]); // savings_usd known
    assert.equal(known?.leftOut, true);
    const [fullyUnknown] = classifyBuckets([bucket({ savings_usd: 'unknown', unknown_savings_requests: 4 })]);
    assert.equal(fullyUnknown?.leftOut, false, 'a fully unknown bucket draws the hatch band, not the strip');
  });

  test('spend is a gap when there are no requests or the bucket could not be priced at all', () => {
    const [noRequests] = classifyBuckets([bucket({ requests: 0, spend_usd: 'unknown' })]);
    assert.deepEqual(noRequests?.spend, { kind: 'gap' });
    const [unpriced] = classifyBuckets([bucket({ spend_usd: 'unknown', savings_usd: 'unknown' })]);
    assert.deepEqual(unpriced?.spend, { kind: 'gap' });
  });

  test('an empty range (zero buckets) never crashes classification', () => {
    assert.deepEqual(classifyBuckets([]), []);
  });
});

describe('timeseries model: x-axis labels (DESIGN.md §12.3, §12.9)', () => {
  function savingsBucketAt(index: number, date: Date): SavingsBucket {
    return {
      index,
      start: date,
      inProgress: false,
      requests: 1,
      unknownSavingsRequests: 0,
      leftOut: false,
      savings: { kind: 'value', amount: 0.0001 },
      spend: { kind: 'value', amount: 0.01 },
    };
  }

  test('1-minute buckets label every 10 minutes, in local HH:MM', () => {
    const buckets = Array.from({ length: 21 }, (_, i) => savingsBucketAt(i, new Date(2026, 8, 19, 13, i)));
    const labels = xAxisLabels(buckets, '1h', '1m', false);
    assert.deepEqual(
      labels.map((l) => l.text),
      ['13:00', '13:10', '13:20'],
    );
  });

  test('daily buckets in a 30-day range label every 7 days, using the UTC date', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => savingsBucketAt(i, new Date(Date.UTC(2026, 8, 1 + i))));
    const labels = xAxisLabels(buckets, '30d', '1d', false);
    assert.deepEqual(
      labels.map((l) => l.index),
      [0, 7],
    );
  });

  test('at 390 px the labels are thinned to at most 5', () => {
    const buckets = Array.from({ length: 61 }, (_, i) => savingsBucketAt(i, new Date(2026, 8, 19, 13, i)));
    const labels = xAxisLabels(buckets, '1h', '1m', true);
    assert.ok(labels.length <= 5, `expected at most 5 labels, got ${labels.length}`);
  });
});

describe('timeseries model: readout and aria labels (DESIGN.md §12.3, §12.6)', () => {
  test('the readout shows the newest bucket with requests, marked in progress when it is the last one', () => {
    const buckets = [bucket({ requests: 0 }), bucket({ requests: 6, savings_usd: '0.000181', spend_usd: '0.0214' })];
    const readout = defaultReadout(buckets);
    assert.equal(readout?.inProgress, true);
    assert.equal(readout?.saved.text, '$0.000181');
    assert.equal(readout?.spend.text, '$0.0214');
    assert.equal(readout?.requests, '6');
  });

  test('an empty range (every bucket has zero requests) has no readout', () => {
    assert.equal(defaultReadout([bucket({ requests: 0 }), bucket({ requests: 0 })]), undefined);
    assert.equal(defaultReadout([]), undefined);
  });

  test('the hover readout of any bucket: dashes for an empty one, Unknown (never $0) for unknown savings', () => {
    const buckets = [
      bucket({ requests: 0, spend_usd: '0', savings_usd: '0' }),
      bucket({ requests: 3, savings_usd: 'unknown', unknown_savings_requests: 3 }),
      bucket({ requests: 1 }),
    ];
    const empty = readoutAt(buckets, 0);
    assert.equal(empty?.saved.text, '—');
    assert.equal(empty?.spend.text, '—');
    assert.equal(empty?.requests, '0');
    assert.equal(empty?.inProgress, false);
    const unknown = readoutAt(buckets, 1);
    assert.equal(unknown?.saved.text, 'Unknown');
    assert.equal(unknown?.saved.unknown, true);
    assert.equal(readoutAt(buckets, 2)?.inProgress, true);
    assert.equal(readoutAt(buckets, 3), undefined);
  });

  test('daily buckets show their UTC date in the readout, never a time of day', () => {
    const buckets = [bucket({ bucket_start: '2026-09-14T00:00:00.000Z' })];
    assert.equal(readoutAt(buckets, 0, '1d')?.time, '2026-09-14');
    assert.equal(defaultReadout(buckets, '1d')?.time, '2026-09-14');
  });

  test('the view carries one hover readout per bucket, in draw order', () => {
    const response: TimeseriesResponse = {
      range: '1h',
      bucket: '1m',
      buckets: [bucket({ requests: 0 }), bucket({ requests: 2, savings_usd: '0.000181' })],
    };
    const view = buildSavingsChartView(response, SUMMARY, '1h', false);
    assert.equal(view.readouts.length, 2);
    assert.equal(view.readouts[0]?.requests, '0');
    assert.equal(view.readouts[1]?.saved.text, '$0.000181');
  });

  test('the savings aria label names the left-out count only when it is more than zero', () => {
    const buckets = classifyBuckets([bucket()]);
    const withTotal = { text: '$0.00459', exact: undefined, unknown: false };
    assert.doesNotMatch(savingsAriaLabel('1h', '1m', buckets, withTotal, 0), /left out/);
    assert.match(savingsAriaLabel('1h', '1m', buckets, withTotal, 1), /1 request left out: savings unknown\./);
  });

  test('an unknown total is said plainly, never printed as a dollar figure', () => {
    const buckets = classifyBuckets([bucket({ savings_usd: 'unknown', unknown_savings_requests: 4 })]);
    const unknownTotal = { text: 'Unknown', exact: undefined, unknown: true };
    assert.match(savingsAriaLabel('1h', '1m', buckets, unknownTotal, 4), /Total savings unknown\./);
    assert.match(spendAriaLabel('1h', '1m', buckets, unknownTotal), /Total spend unknown\./);
  });
});

describe('timeseries model: the data table (DESIGN.md §12.6)', () => {
  test('every bucket is a row; a bucket with no requests shows a dash, never $0', () => {
    const start = '2026-09-19T13:00:00.000Z';
    const rows = tableRows(
      [bucket({ bucket_start: start, requests: 0, spend_usd: '0.000000', savings_usd: '0.000000' })],
      '1m',
    );
    const localTime = new Date(start);
    const expectedStart = `${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}`;
    assert.deepEqual(rows[0], {
      start: expectedStart,
      inProgress: true,
      requests: '0',
      spend: undefined,
      saved: undefined,
      leftOut: '0',
    });
  });

  test('unknown savings is spelled out, and a daily bucket uses the ISO date', () => {
    const rows = tableRows(
      [bucket({ bucket_start: '2026-09-19T00:00:00.000Z', savings_usd: 'unknown', unknown_savings_requests: 4 })],
      '1d',
    );
    assert.equal(rows[0]?.start, '2026-09-19');
    assert.equal(rows[0]?.saved, 'Unknown');
    assert.equal(rows[0]?.leftOut, '4');
  });
});

describe('buildSavingsChartView: the whole chart, end to end', () => {
  test('a range with a mix of known, unknown, zero and negative buckets never turns unknown into 0', () => {
    const response: TimeseriesResponse = {
      range: '1h',
      bucket: '1m',
      buckets: [
        bucket({ bucket_start: '2026-09-19T13:00:00.000Z', savings_usd: '0.000181', spend_usd: '0.0214' }),
        bucket({ bucket_start: '2026-09-19T13:01:00.000Z', savings_usd: 'unknown', unknown_savings_requests: 4 }),
        bucket({ bucket_start: '2026-09-19T13:02:00.000Z', savings_usd: '-0.000050', spend_usd: '0.0300' }),
        bucket({
          bucket_start: '2026-09-19T13:03:00.000Z',
          requests: 0,
          spend_usd: '0.000000',
          savings_usd: '0.000000',
        }),
      ],
    };
    const view = buildSavingsChartView(response, SUMMARY, '1h', false);
    assert.equal(view.buckets.length, 4);
    assert.deepEqual(view.buckets[1]?.savings, { kind: 'unknown' });
    assert.ok(view.savingsTicks.min < 0, 'the negative bucket must pull the axis below zero');
    assert.deepEqual(view.buckets[3]?.savings, { kind: 'empty' });
    assert.match(view.savingsAriaLabel, /Savings per minute over the last hour, 4 bars\./);
  });

  test('an empty range (no buckets) produces a view with no crash and empty ticks', () => {
    const response: TimeseriesResponse = { range: '1h', bucket: '1m', buckets: [] };
    const empty: Summary = {
      ...SUMMARY,
      requests: 0,
      spend_usd: '0.000000',
      savings_usd: '0.000000',
      baseline_usd: '0.000000',
    };
    const view = buildSavingsChartView(response, empty, '1h', false);
    assert.deepEqual(view.buckets, []);
    assert.equal(view.readout, undefined);
    assert.deepEqual(view.savingsTicks.values, [0]);
  });
});

describe('breakdown model (DESIGN.md §12.5)', () => {
  function response(overrides: Partial<BreakdownResponse> = {}): BreakdownResponse {
    return {
      range: '1h',
      by: 'provider',
      unrouted_requests: 0,
      groups: [
        {
          key: 'openrouter',
          requests: 137,
          spend_usd: '0.013600',
          unpriced_requests: 0,
          latency_p50_ms: 100,
          latency_p95_ms: 150,
        },
        {
          key: 'openai',
          requests: 103,
          spend_usd: '0.008960',
          unpriced_requests: 0,
          latency_p50_ms: 200,
          latency_p95_ms: 300,
        },
      ],
      ...overrides,
    };
  }

  test('the largest known spend gets a full bar; shares add up against known spend only', () => {
    const view = buildBreakdown(response(), 'provider');
    const bar = view.rows[0]?.bar;
    assert.equal(bar?.kind, 'value');
    assert.equal(bar?.kind === 'value' ? bar.percent : undefined, 100);
    assert.equal(view.rows[0]?.share, '60%');
    assert.equal(view.rows[1]?.share, '40%');
  });

  test('unknown spend never becomes a $0 bar: it gets its own dashed, unknown mark', () => {
    const view = buildBreakdown(
      response({
        groups: [
          {
            key: 'openrouter',
            requests: 10,
            spend_usd: '0.0100',
            unpriced_requests: 0,
            latency_p50_ms: 1,
            latency_p95_ms: 1,
          },
          {
            key: 'llama3.2:latest',
            requests: 3,
            spend_usd: 'unknown',
            unpriced_requests: 3,
            latency_p50_ms: 1,
            latency_p95_ms: 1,
          },
        ],
      }),
      'model',
    );
    const unknownRow = view.rows[1];
    assert.deepEqual(unknownRow?.bar, { kind: 'unknown' });
    assert.equal(unknownRow?.share, '—');
    assert.match(unknownRow?.note ?? '', /no catalog price/);
  });

  test('a known $0.00 spend is a zero row, distinct from unknown', () => {
    const view = buildBreakdown(
      response({
        groups: [
          {
            key: 'openrouter',
            requests: 10,
            spend_usd: '0.0100',
            unpriced_requests: 0,
            latency_p50_ms: 1,
            latency_p95_ms: 1,
          },
          {
            key: 'free-tier',
            requests: 2,
            spend_usd: '0.000000',
            unpriced_requests: 0,
            latency_p50_ms: 1,
            latency_p95_ms: 1,
          },
        ],
      }),
      'provider',
    );
    assert.deepEqual(view.rows[1]?.bar, { kind: 'value', percent: 0 });
    assert.equal(view.rows[1]?.value.text, '$0.00');
  });

  test('more than 8 groups are collapsed; the table still lists every one', () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({
      key: `model-${i}`,
      requests: 10 - i,
      spend_usd: `0.0${10 - i}0000`,
      unpriced_requests: 0,
      latency_p50_ms: 1,
      latency_p95_ms: 1,
    }));
    const view = buildBreakdown(response({ groups }), 'model');
    assert.equal(view.visibleRows.length, VISIBLE_ROWS);
    assert.equal(view.hiddenCount, 2);
    assert.equal(view.tableRows.length, 10);
  });

  test('unrouted requests get a footnote, never a fabricated group', () => {
    const withUnrouted = buildBreakdown(response({ unrouted_requests: 3 }), 'provider');
    assert.match(withUnrouted.footnote ?? '', /3 requests refused before routing/);
    assert.equal(buildBreakdown(response(), 'provider').footnote, undefined);
  });
});

describe('spend line geometry (DESIGN.md §12.3, §12.4)', () => {
  const known = (): TimeseriesBucket => bucket({ spend_usd: '0.000400' });
  const gap = (): TimeseriesBucket => bucket({ requests: 0, spend_usd: '0.000000', savings_usd: '0.000000' });

  test('[value, gap, value, gap, value]: three isolated dots, no line segment', () => {
    const buckets = classifyBuckets([known(), gap(), known(), gap(), known()]);
    assert.deepEqual(spendRuns(buckets), { lines: [], dots: [0, 2, 4] });
  });

  test('runs of two or more become lines; only lone points become dots', () => {
    const buckets = classifyBuckets([known(), known(), gap(), known(), gap(), gap(), known(), known(), known()]);
    assert.deepEqual(spendRuns(buckets), {
      lines: [
        [0, 1],
        [6, 7, 8],
      ],
      dots: [3],
    });
  });

  test('unknown spend breaks the line like an empty bucket, never drops it to $0', () => {
    const buckets = classifyBuckets([known(), bucket({ spend_usd: 'unknown', savings_usd: 'unknown' }), known()]);
    assert.deepEqual(spendRuns(buckets), { lines: [], dots: [0, 2] });
  });

  test('the path has one moveto per run and never a lone moveto; dots sit on their slot centres', () => {
    const buckets = classifyBuckets([
      bucket({ spend_usd: '0.000100' }),
      gap(),
      bucket({ spend_usd: '0.000200' }),
      bucket({ spend_usd: '0.000300' }),
      gap(),
      bucket({ spend_usd: '0.000400' }),
    ]);
    const geometry = spendGeometry(
      buckets,
      (index) => 10 + index * 20,
      (amount) => 100 - amount * 100_000,
    );
    assert.equal(geometry.d, 'M50.0 80.0 L70.0 70.0');
    assert.deepEqual(geometry.dots, [
      { x: 10, y: 90 },
      { x: 110, y: 60 },
    ]);
  });

  test('a range with no known spend draws neither a path nor a dot', () => {
    const geometry = spendGeometry(
      classifyBuckets([gap(), gap()]),
      (i) => i,
      (a) => a,
    );
    assert.deepEqual(geometry, { d: '', dots: [] });
  });
});

describe('bucket start text and aria edge cases (DESIGN.md §12.3, §12.6)', () => {
  test('hourly buckets in 7 days carry the local ISO date, so a time never repeats ambiguously', () => {
    const start = new Date(2026, 8, 14, 14, 0);
    assert.equal(bucketStartText(start, '1h', true), '2026-09-14 14:00');
    assert.equal(bucketStartText(start, '1h', false), '14:00');
  });

  test('the 7-day hourly view uses the dated form in the readout and the table', () => {
    const start = new Date(2026, 8, 14, 14, 0).toISOString();
    const response: TimeseriesResponse = { range: '7d', bucket: '1h', buckets: [bucket({ bucket_start: start })] };
    const view = buildSavingsChartView(response, { ...SUMMARY, range: '7d' }, '7d', false);
    assert.equal(view.tableRows[0]?.start, '2026-09-14 14:00');
    assert.equal(view.readout?.time, '2026-09-14 14:00');
  });

  test('when no bucket saved money, the savings aria label names no "highest" figure', () => {
    const buckets = classifyBuckets([bucket({ savings_usd: '-0.000010' }), bucket({ savings_usd: '0.000000' })]);
    const total = { text: '-$0.00001', exact: undefined, unknown: false };
    const label = savingsAriaLabel('1h', '1m', buckets, total, 0);
    assert.doesNotMatch(label, /highest/);
    assert.match(label, /-\$0\.00001 saved in total\./);
  });
});

describe('breakdown "Show all N" state (DESIGN.md §12.5)', () => {
  test('stays expanded across live refreshes of the same range, collapses on a new range', () => {
    assert.equal(keepExpanded(true, '1h', '1h'), true);
    assert.equal(keepExpanded(true, '1h', '24h'), false);
    assert.equal(keepExpanded(true, undefined, '1h'), false);
    assert.equal(keepExpanded(false, '1h', '1h'), false);
  });

  test('expanded draws every row; collapsed draws the first 8', () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({
      key: `model-${i}`,
      requests: 10 - i,
      spend_usd: `0.0${10 - i}0000`,
      unpriced_requests: 0,
      latency_p50_ms: 1,
      latency_p95_ms: 1,
    }));
    const view = buildBreakdown({ range: '1h', by: 'model', unrouted_requests: 0, groups }, 'model');
    assert.equal(view.range, '1h');
    assert.equal(rowsToDraw(view, false).length, VISIBLE_ROWS);
    assert.equal(rowsToDraw(view, true).length, 10);
  });
});
