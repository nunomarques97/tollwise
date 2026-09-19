// The Routing and Providers views' browser-independent logic: the client parser for /api/requests and
// /api/health (including the DESIGN.md §13.2 fallbacks for records stored before schema 2), and the pure
// view-model functions that build the table row, the drawer's routing trace and the provider rows.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type HealthSnapshot,
  parseHealth,
  parseRecentEntry,
  parseRecentPage,
  type RecentEntry,
} from '../src/dashboard/api.ts';
import { formatMs } from '../src/dashboard/format.ts';
import { buildProvidersView } from '../src/dashboard/providers-model.ts';
import {
  ANNOUNCE_GAP_MS,
  announceDelay,
  attemptResultText,
  attemptRows,
  candidateRows,
  costSection,
  excludedRows,
  exclusionReasonText,
  formatCatalogPrice,
  needsChips,
  routedToView,
  routeStrip,
  SingleFlight,
  savedCellView,
  sentenceRuns,
  shouldPrependLive,
  tableRow,
  unseenRows,
  webUrl,
} from '../src/dashboard/routing-model.ts';

/** A fully populated entry, as /api/requests returns it: a fallback after one failure. */
const ROUTED_ENTRY = {
  requestId: '301f2116-fd3c-4755-bb26-ea1b2deb8e1e',
  timestamp: '2026-09-19T15:22:04.000Z',
  status: 'complete',
  route: {
    format: 'anthropic',
    requestedModel: 'claude-opus-5',
    requestedProvider: 'anthropic',
    usedModel: 'anthropic/claude-opus-5',
    usedProvider: 'openrouter',
    policy: 'cheapest',
    decision: 'routed',
  },
  reason: 'routed by the cheapest policy after anthropic claude-opus-5 (server, HTTP 500) failed',
  cost_usd: '0.000175',
  savings_usd: '0.00',
  trace: [
    { provider: 'anthropic', model: 'claude-opus-5', outcome: 'server', status: 500, duration_ms: 1 },
    { provider: 'openrouter', model: 'anthropic/claude-opus-5', outcome: 'ok', status: 200, duration_ms: 2 },
  ],
  latency_ms: 3,
  first_byte_ms: null,
  origin: 'reported',
  baseline_usd: '0.000175',
  usage: { input: 10, output: 5 },
  needs: { tools: true, json_mode: false, vision: false, streaming: true },
  price: {
    used: {
      input: 5,
      output: 25,
      verified_on: '2026-09-19',
      source_url: 'https://openrouter.ai/anthropic/claude-opus-5',
    },
    requested: {
      input: 5,
      output: 25,
      verified_on: '2026-09-19',
      source_url: 'https://platform.claude.com/docs/en/models/overview',
    },
  },
  selection: {
    considered: 2,
    candidates: [
      { provider: 'anthropic', model: 'claude-opus-5', input: 5, output: 25 },
      { provider: 'openrouter', model: 'anthropic/claude-opus-5', input: 5, output: 25 },
    ],
    excluded: [],
  },
  substituted: false,
  substitution: null,
};

/** A row stored before schema 2: selection and price are null, and the other new fields are their honest values. */
const PRE_SCHEMA2_ENTRY = {
  requestId: 'b7d0c1e2-5a44-4f0e-9d7c-2f3a8e61c0d9',
  timestamp: '2026-09-19T15:20:00.000Z',
  status: 'refused',
  route: {
    format: 'openai',
    requestedModel: 'deepseek-v4-pro',
    requestedProvider: 'deepseek',
    usedModel: null,
    usedProvider: null,
    policy: 'cheapest',
    decision: 'fail',
  },
  reason: 'refused: no configured provider could satisfy the requested capabilities',
  cost_usd: null,
  savings_usd: null,
  trace: [],
  latency_ms: 0,
  first_byte_ms: null,
  origin: null,
  baseline_usd: null,
  usage: null,
  needs: { tools: false, json_mode: false, vision: true, streaming: false },
  price: null,
  selection: null,
  substituted: null,
  substitution: null,
};

describe('dashboard requests parser', () => {
  test('parses a fully populated entry, with every §13.2 field under its exact name', () => {
    const entry = parseRecentEntry(ROUTED_ENTRY);
    assert.notEqual(entry, undefined);
    assert.equal(entry?.latency_ms, 3);
    assert.equal(entry?.first_byte_ms, null);
    assert.equal(entry?.origin, 'reported');
    assert.equal(entry?.baseline_usd, '0.000175');
    assert.deepEqual(entry?.usage, { input: 10, output: 5 });
    assert.deepEqual(entry?.needs, { tools: true, json_mode: false, vision: false, streaming: true });
    assert.equal(entry?.price?.used?.source_url, 'https://openrouter.ai/anthropic/claude-opus-5');
    assert.equal(entry?.selection?.considered, 2);
    assert.equal(entry?.selection?.candidates.length, 2);
  });

  test('a pre-schema-2 row parses with selection and price null, never guessed', () => {
    const entry = parseRecentEntry(PRE_SCHEMA2_ENTRY);
    assert.notEqual(entry, undefined);
    assert.equal(entry?.selection, null);
    assert.equal(entry?.price, null);
    assert.equal(entry?.origin, null);
    assert.equal(entry?.usage, null);
  });

  test('rejects an entry with a bad status, an unknown attempt outcome or a malformed price', () => {
    assert.equal(parseRecentEntry({ ...ROUTED_ENTRY, status: 'bogus' }), undefined);
    assert.equal(
      parseRecentEntry({
        ...ROUTED_ENTRY,
        trace: [{ provider: 'a', model: 'b', outcome: 'bogus', status: null, duration_ms: 1 }],
      }),
      undefined,
    );
    assert.equal(
      parseRecentEntry({
        ...ROUTED_ENTRY,
        price: { used: { input: 'five', output: 25, verified_on: '2026-09-19', source_url: 'x' }, requested: null },
      }),
      undefined,
    );
    assert.equal(parseRecentEntry({ ...ROUTED_ENTRY, route: undefined }), undefined);
  });

  test('parses a page with a cursor, and rejects one whose entries array is malformed', () => {
    const page = parseRecentPage({ entries: [ROUTED_ENTRY, PRE_SCHEMA2_ENTRY], nextCursor: '123-4' });
    assert.equal(page?.entries.length, 2);
    assert.equal(page?.nextCursor, '123-4');
    assert.equal(parseRecentPage({ entries: [{ bad: true }], nextCursor: null }), undefined);
  });
});

describe('dashboard health parser', () => {
  test('parses a snapshot keyed by provider id, in API order', () => {
    const snapshot = parseHealth({
      providers: {
        anthropic: {
          state: 'up',
          p50_ms: 1,
          p95_ms: 2,
          last_checked: '2026-09-19T15:21:50.000Z',
          samples: 100,
          last_error_kind: null,
        },
        deepseek: {
          state: 'down',
          p50_ms: 0,
          p95_ms: 1,
          last_checked: '2026-09-19T15:21:06.000Z',
          samples: 100,
          last_error_kind: 'rate_limit',
        },
        ollama: { state: 'unknown', p50_ms: null, p95_ms: null, last_checked: null, samples: 0, last_error_kind: null },
      },
    });
    assert.notEqual(snapshot, undefined);
    assert.deepEqual([...(snapshot as HealthSnapshot).providers.keys()], ['anthropic', 'deepseek', 'ollama']);
    assert.equal(snapshot?.providers.get('deepseek')?.last_error_kind, 'rate_limit');
  });

  test('rejects a snapshot with an unknown state or a non-object providers field', () => {
    assert.equal(parseHealth({ providers: { a: { state: 'bogus' } } }), undefined);
    assert.equal(parseHealth({ providers: 'nope' }), undefined);
  });
});

describe('routing view model', () => {
  const routed = parseRecentEntry(ROUTED_ENTRY) as RecentEntry;
  const refused = parseRecentEntry(PRE_SCHEMA2_ENTRY) as RecentEntry;

  test('the table row: fallback provider, "after 1 failure", pips and the accessible name', () => {
    const row = tableRow(routed, '15:22:04');
    assert.equal(row.routedTo.provider, 'openrouter');
    assert.equal(row.routedTo.afterFailures, 'after 1 failure');
    assert.equal(row.routedTo.pips.length, 2);
    assert.equal(row.routedTo.pips[0]?.ok, false);
    assert.equal(row.routedTo.pips[1]?.ok, true);
    assert.equal(row.accessibleName, 'Open request at 15:22:04, claude-opus-5 to openrouter');
    assert.equal(row.latencyText, formatMs(3));
  });

  test('a refused request shows "Not routed" and no origin line', () => {
    const view = routedToView(refused);
    assert.equal(view.notRouted, true);
    const saved = savedCellView(refused);
    assert.equal(saved.originText, undefined);
    assert.equal(saved.amount.unknown, true);
  });

  test('the sentence names the policy and every failure, in order', () => {
    const runs = sentenceRuns(routed)
      .map((run) => run.text)
      .join('');
    assert.equal(runs, 'Routed by the cheapest policy to openrouter, after anthropic failed (server error, HTTP 500).');
  });

  test('a refused request’s sentence names the requested model and the fail policy', () => {
    const runs = sentenceRuns(refused)
      .map((run) => run.text)
      .join('');
    assert.match(runs, /^Refused\. No configured provider can serve deepseek-v4-pro/);
  });

  test('the route strip: Requested, then one item per attempt, in order', () => {
    const strip = routeStrip(routed);
    assert.equal(strip.length, 3);
    assert.equal(strip[0]?.kind, 'requested');
    assert.equal(strip[1]?.kind, 'failed');
    assert.equal(strip[2]?.kind, 'served');
  });

  test('a refused request’s route strip ends with "No provider" / "Refused"', () => {
    const strip = routeStrip(refused);
    assert.equal(strip.length, 2);
    assert.equal(strip[1]?.label, 'No provider');
    assert.equal(strip[1]?.value, 'Refused');
  });

  test('candidates are cross-referenced with the trace: served, failed and their catalog price', () => {
    const rows = candidateRows(routed);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.served, false);
    assert.equal(rows[0]?.resultText, attemptResultText({ outcome: 'server', status: 500 }));
    assert.equal(rows[1]?.served, true);
    assert.equal(rows[0]?.priceText, '$5.00 in · $25.00 out');
  });

  test('selection null falls back to no candidates and no exclusions, never guessed', () => {
    assert.deepEqual(candidateRows(refused), []);
    assert.deepEqual(excludedRows(refused), []);
  });

  test('exclusion reason text covers missing capabilities and untranslatable codes', () => {
    assert.equal(exclusionReasonText('missing_capability:vision'), 'Does not accept images; this request has one');
    assert.equal(
      exclusionReasonText('untranslatable:openai_n'),
      'Speaks the other API format, which cannot carry openai_n',
    );
    assert.equal(exclusionReasonText('provider_down'), 'Provider was down at the time');
  });

  test('attempts and the cost section: usage origin, prices with their source and verified date', () => {
    const attempts = attemptRows(routed);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.failed, true);
    const cost = costSection(routed);
    assert.equal(cost.refused, false);
    assert.equal(cost.usage?.originKnown, true);
    assert.equal(cost.usage?.originText, 'reported by the provider');
    assert.equal(cost.usedPrice?.verifiedOn, '2026-09-19');
    assert.equal(cost.usedPrice?.linkLabel, 'Price source for anthropic/claude-opus-5, opens in a new tab');
    assert.equal(cost.requestedPrice?.linkLabel, 'Price source for claude-opus-5, opens in a new tab');
    assert.equal(cost.usedPrice?.sourceHref, 'https://openrouter.ai/anthropic/claude-opus-5');
  });

  test('a price source that is not an http(s) URL is shown as text, never linked', () => {
    const unsafe = parseRecentEntry({
      ...ROUTED_ENTRY,
      price: {
        used: { input: 5, output: 25, verified_on: '2026-09-19', source_url: 'javascript:alert(1)' },
        requested: { input: 5, output: 25, verified_on: '2026-09-19', source_url: 'catalog.json' },
      },
    }) as RecentEntry;
    const cost = costSection(unsafe);
    assert.equal(cost.usedPrice?.sourceUrl, 'javascript:alert(1)');
    assert.equal(cost.usedPrice?.sourceHref, undefined);
    assert.equal(cost.requestedPrice?.sourceHref, undefined);
    assert.equal(webUrl('http://127.0.0.1:8484/prices'), 'http://127.0.0.1:8484/prices');
    assert.equal(webUrl('HTTPS://example.com/a'), 'HTTPS://example.com/a');
    assert.equal(webUrl('data:text/html,hi'), undefined);
    assert.equal(webUrl('file:///etc/passwd'), undefined);
    assert.equal(webUrl(''), undefined);
  });

  test('a refused request’s cost section has no price rows, only the note', () => {
    const cost = costSection(refused);
    assert.equal(cost.refused, true);
    assert.equal(cost.usedPrice, undefined);
  });

  test('needsChips lists only what the request used, in the fixed order', () => {
    assert.deepEqual(needsChips(routed.needs), ['Tools', 'Streaming']);
    assert.deepEqual(needsChips({ tools: false, json_mode: false, vision: false, streaming: false }), [
      'No special capabilities',
    ]);
  });

  test('formatCatalogPrice keeps as many decimals as the value needs, at least 2', () => {
    assert.equal(formatCatalogPrice(5), '$5.00');
    assert.equal(formatCatalogPrice(0), '$0.00');
    assert.equal(formatCatalogPrice(0.2), '$0.20');
    assert.equal(formatCatalogPrice(0.57816), '$0.57816');
  });

  test('a live row is shown directly only when the header is visible, unfocused and the drawer is closed', () => {
    assert.equal(shouldPrependLive({ headerInView: true, focusInsideTable: false, drawerOpen: false }), true);
    assert.equal(shouldPrependLive({ headerInView: false, focusInsideTable: false, drawerOpen: false }), false);
    assert.equal(shouldPrependLive({ headerInView: true, focusInsideTable: true, drawerOpen: false }), false);
    assert.equal(shouldPrependLive({ headerInView: true, focusInsideTable: false, drawerOpen: true }), false);
  });
});

describe('routing view: rows keyed by requestId, one page load at a time', () => {
  const row = (requestId: string) => ({ requestId });

  test('unseenRows drops rows already shown or waiting, and duplicates inside the incoming batch', () => {
    const shown = [row('a'), row('b')];
    const waiting = [row('c')];
    assert.deepEqual(
      unseenRows([row('b'), row('d'), row('c'), row('d'), row('e')], shown, waiting).map((r) => r.requestId),
      ['d', 'e'],
    );
    assert.deepEqual(
      unseenRows([row('x'), row('x'), row('y')]).map((r) => r.requestId),
      ['x', 'y'],
    );
  });

  test('the same older page appended twice adds its rows once', () => {
    let rows = [row('n1'), row('n2')];
    const olderPage = [row('o1'), row('o2')];
    rows = [...rows, ...unseenRows(olderPage, rows)];
    rows = [...rows, ...unseenRows(olderPage, rows)];
    assert.deepEqual(
      rows.map((r) => r.requestId),
      ['n1', 'n2', 'o1', 'o2'],
    );
  });

  test('merging the first page after a reconnect keeps older pages and adds only the missed rows', () => {
    const shown = [row('r3'), row('r2'), row('r1'), row('old1'), row('old2')];
    const firstPageAgain = [row('r5'), row('r4'), row('r3'), row('r2'), row('r1')];
    const missed = unseenRows(firstPageAgain, shown);
    assert.deepEqual(
      missed.map((r) => r.requestId),
      ['r5', 'r4'],
    );
    assert.deepEqual(
      [...missed, ...shown].map((r) => r.requestId),
      ['r5', 'r4', 'r3', 'r2', 'r1', 'old1', 'old2'],
    );
  });

  test('SingleFlight runs one job at a time: a second activation while loading is ignored', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = async () => {
      calls += 1;
      await gate;
    };
    const first = flight.run(job);
    assert.equal(flight.inFlight, true);
    const second = await flight.run(job);
    assert.equal(second, false);
    release();
    assert.equal(await first, true);
    assert.equal(calls, 1);
    assert.equal(flight.inFlight, false);
    assert.equal(await flight.run(async () => {}), true);
  });

  test('SingleFlight frees itself when a job throws', async () => {
    const flight = new SingleFlight();
    await assert.rejects(
      flight.run(async () => {
        throw new Error('network down');
      }),
      /network down/,
    );
    assert.equal(flight.inFlight, false);
  });

  test('the new-requests announcement waits 5 seconds after the previous one', () => {
    assert.equal(ANNOUNCE_GAP_MS, 5_000);
    assert.equal(announceDelay(undefined, 1_000), 0);
    assert.equal(announceDelay(10_000, 11_500), 3_500);
    assert.equal(announceDelay(10_000, 15_000), 0);
    assert.equal(announceDelay(10_000, 20_000), 0);
  });
});

describe('providers view model', () => {
  test('builds a summary, keeps API order and marks down providers', () => {
    const health = parseHealth({
      providers: {
        anthropic: {
          state: 'up',
          p50_ms: 1,
          p95_ms: 3,
          last_checked: '2026-09-19T15:21:50.000Z',
          samples: 100,
          last_error_kind: null,
        },
        deepseek: {
          state: 'down',
          p50_ms: 0,
          p95_ms: 1,
          last_checked: '2026-09-19T15:21:06.000Z',
          samples: 100,
          last_error_kind: 'rate_limit',
        },
        ollama: { state: 'unknown', p50_ms: null, p95_ms: null, last_checked: null, samples: 0, last_error_kind: null },
      },
    }) as HealthSnapshot;
    const view = buildProvidersView(health);
    assert.equal(view.downCount, 1);
    assert.equal(view.summaryText, '3 configured · 1 down');
    assert.deepEqual(
      view.rows.map((row) => row.id),
      ['anthropic', 'deepseek', 'ollama'],
    );
    assert.equal(view.rows[1]?.errorNote, 'rate limited');
    assert.equal(view.rows[2]?.plot, undefined);
    assert.equal(view.rows[2]?.metaText, 'First check pending');
    assert.ok(view.axisTicks.some((tick) => tick.text === '0 ms'));
  });

  test('the axis of a sub-3 ms snapshot counts in whole milliseconds, with no repeated label', () => {
    const provider = (p95: number) => ({
      state: 'up',
      p50_ms: 0,
      p95_ms: p95,
      last_checked: '2026-09-19T15:21:50.000Z',
      samples: 100,
      last_error_kind: null,
    });
    const small = buildProvidersView(parseHealth({ providers: { a: provider(1), b: provider(2) } }) as HealthSnapshot);
    assert.deepEqual(
      small.axisTicks.map((tick) => tick.text),
      ['0 ms', '1 ms', '2 ms'],
    );
    assert.equal(small.axisMaxText, '2 ms');
    const large = buildProvidersView(parseHealth({ providers: { a: provider(1204) } }) as HealthSnapshot);
    assert.deepEqual(
      large.axisTicks.map((tick) => tick.text),
      ['0 ms', '500 ms', '1,000 ms', '1,500 ms'],
    );
  });

  test('an empty snapshot has no down providers and says "all up"', () => {
    const health = parseHealth({ providers: {} }) as HealthSnapshot;
    const view = buildProvidersView(health);
    assert.equal(view.summaryText, '0 configured · all up');
    assert.equal(view.rows.length, 0);
  });
});
