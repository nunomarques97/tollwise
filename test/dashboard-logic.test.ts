// The dashboard's browser-independent logic: money, percent, count and time formatting; the time range
// and its URL fragment; the access key's storage and header; the event-stream parser; the API client
// against stand-in fetch responses; the overview's wording and state rules; the theme choice.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_KEY_ENTRY,
  apiHeaders,
  forgetAccessKey,
  type KeyStorage,
  normalizeAccessKey,
  readAccessKey,
  storeAccessKey,
} from '../src/dashboard/access.ts';
import {
  type FetchLike,
  fetchLastRequestTime,
  fetchSummary,
  parseRecentEntry,
  parseRecentEvent,
  parseRecentPage,
  parseSubstitution,
  parseSummary,
  type RecentEntry,
  readEventStream,
  type Summary,
} from '../src/dashboard/api.ts';
import { formatClock, formatCount, formatPercent, formatUsd, plural } from '../src/dashboard/format.ts';
import { type Chip, describeOverview, spokenValue } from '../src/dashboard/overview-model.ts';
import { hashForRange, rangeAfterKey, rangeFromHash, savedHeading } from '../src/dashboard/ranges.ts';
import { substitutionMark, substitutionSection, tableRow } from '../src/dashboard/routing-model.ts';
import { createEventStreamParser } from '../src/dashboard/sse.ts';
import { resolveTheme, THEME_ENTRY, toggleLabels } from '../src/dashboard/theme-choice.ts';

// A made-up access key with no known key shape.
const FAKE_KEY = 'dashboardTestAccessValue0123456789'; // tollwise-allow-secret

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://127.0.0.1:8484/v1';

/** The summary `npm run demo -- --count 240 --seed 7` produced (docs/design/mocks/README.md). */
const DEMO: Summary = {
  range: '24h',
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

const chipText = (chip: Chip | undefined): string => chip?.runs.map((run) => run.text).join('') ?? '';

describe('dashboard formatting', () => {
  test('money below $1 shows three significant digits, between 2 and 6 decimals', () => {
    assert.deepEqual(formatUsd('0.022560'), { text: '$0.0226', exact: '$0.022560', unknown: false });
    assert.deepEqual(formatUsd('0.000192'), { text: '$0.000192', exact: undefined, unknown: false });
    assert.deepEqual(formatUsd('0.000005'), { text: '$0.000005', exact: undefined, unknown: false });
    assert.equal(formatUsd('0.5').text, '$0.500');
    assert.equal(formatUsd('0.012345').text, '$0.0123');
    assert.equal(formatUsd('0.1').text, '$0.100');
  });

  test('money at or above $1 shows two decimals with thousands separators', () => {
    assert.deepEqual(formatUsd('1204.5'), { text: '$1,204.50', exact: '$1,204.500000', unknown: false });
    assert.equal(formatUsd('12').text, '$12.00');
    assert.equal(formatUsd('1234567.891234').text, '$1,234,567.89');
    // Rounding up to a whole dollar switches to the $1-and-above form.
    assert.equal(formatUsd('0.999999').text, '$1.00');
  });

  test('zero is $0.00, negatives keep their sign, unknown or malformed is the word Unknown', () => {
    assert.deepEqual(formatUsd('0.000000'), { text: '$0.00', exact: '$0.000000', unknown: false });
    assert.equal(formatUsd('0').text, '$0.00');
    assert.equal(formatUsd('-0.001200').text, '-$0.00120');
    assert.deepEqual(formatUsd('unknown'), { text: 'Unknown', exact: undefined, unknown: true });
    for (const bad of ['', '1e5', '0.1234567', 'NaN', '$1']) assert.equal(formatUsd(bad).text, 'Unknown', bad);
  });

  test('the spoken value is the exact amount when the shown one is rounded', () => {
    assert.equal(spokenValue(formatUsd('0.022560')), '$0.022560');
    assert.equal(spokenValue(formatUsd('0.000192')), '$0.000192');
  });

  test('percentages, counts, plurals and clock times', () => {
    assert.equal(formatPercent(0.84), '0.84%');
    assert.equal(formatPercent(12.5), '12.5%');
    assert.equal(formatPercent(50), '50%');
    assert.equal(formatPercent(99.16), '99.16%');
    assert.equal(formatPercent(1234.5), '1234.5%');
    assert.equal(formatCount(12480), '12,480');
    assert.equal(plural(1, 'error', 'errors'), '1 error');
    assert.equal(plural(0, 'error', 'errors'), '0 errors');
    assert.equal(plural(1200, 'request', 'requests'), '1,200 requests');
    assert.equal(formatClock(new Date(2026, 8, 19, 13, 11, 3)), '13:11:03');
    assert.equal(formatClock(new Date(2026, 8, 19, 0, 0, 0)), '00:00:00');
  });
});

describe('dashboard time range', () => {
  test('the range is read from and written to the URL fragment, 24 hours by default', () => {
    assert.equal(rangeFromHash('#range=7d'), '7d');
    assert.equal(rangeFromHash('#range=1h'), '1h');
    assert.equal(rangeFromHash(''), '24h');
    assert.equal(rangeFromHash('#range=2h'), '24h');
    assert.equal(rangeFromHash('#range=7D'), '24h');
    assert.equal(rangeFromHash('#other=1'), '24h');
    assert.equal(hashForRange('30d'), '#range=30d');
  });

  test('the savings heading names the range', () => {
    assert.equal(savedHeading('1h'), 'Saved in the last hour');
    assert.equal(savedHeading('24h'), 'Saved in the last 24 hours');
    assert.equal(savedHeading('30d'), 'Saved in the last 30 days');
  });

  test('arrow keys move through the options and wrap; Home and End jump; other keys are ignored', () => {
    assert.equal(rangeAfterKey('24h', 'ArrowRight'), '7d');
    assert.equal(rangeAfterKey('30d', 'ArrowRight'), '1h');
    assert.equal(rangeAfterKey('1h', 'ArrowLeft'), '30d');
    assert.equal(rangeAfterKey('7d', 'ArrowUp'), '24h');
    assert.equal(rangeAfterKey('7d', 'Home'), '1h');
    assert.equal(rangeAfterKey('1h', 'End'), '30d');
    assert.equal(rangeAfterKey('1h', 'Enter'), undefined);
    assert.equal(rangeAfterKey('1h', 'Tab'), undefined);
  });
});

describe('dashboard access key', () => {
  function memoryStorage(): KeyStorage & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    return {
      entries,
      getItem: (name) => entries.get(name) ?? null,
      setItem: (name, value) => {
        entries.set(name, value);
      },
      removeItem: (name) => {
        entries.delete(name);
      },
    };
  }

  test('a typed key is trimmed; empty or unsendable values are refused', () => {
    assert.equal(normalizeAccessKey(`  ${FAKE_KEY}\n`), FAKE_KEY);
    assert.equal(normalizeAccessKey(''), undefined);
    assert.equal(normalizeAccessKey('   '), undefined);
    assert.equal(normalizeAccessKey('abc\ndef'), undefined);
    assert.equal(normalizeAccessKey('abc\u0000def'), undefined);
    assert.equal(normalizeAccessKey('cl\u00e9'), undefined);
    assert.equal(normalizeAccessKey('two words'), 'two words');
  });

  test('the key is kept in the given session storage under one entry, and forgotten on request', () => {
    const storage = memoryStorage();
    assert.equal(readAccessKey(storage), undefined);
    storeAccessKey(storage, FAKE_KEY);
    assert.deepEqual([...storage.entries.keys()], [ACCESS_KEY_ENTRY]);
    assert.equal(readAccessKey(storage), FAKE_KEY);
    forgetAccessKey(storage);
    assert.equal(storage.entries.size, 0);
    assert.equal(readAccessKey(undefined), undefined);
    storage.setItem(ACCESS_KEY_ENTRY, 'bad\nvalue');
    assert.equal(readAccessKey(storage), undefined);
  });

  test('the key travels only in the x-api-key header', () => {
    assert.deepEqual(apiHeaders(undefined), { accept: 'application/json' });
    assert.deepEqual(apiHeaders(FAKE_KEY), { accept: 'application/json', 'x-api-key': FAKE_KEY });
    assert.deepEqual(apiHeaders(FAKE_KEY, 'text/event-stream'), {
      accept: 'text/event-stream',
      'x-api-key': FAKE_KEY,
    });
  });
});

describe('dashboard event-stream parser', () => {
  test('events split across chunks at any point are reassembled', () => {
    const parser = createEventStreamParser();
    const wire = 'event: health\ndata: {"providers":{}}\n\nevent: request\ndata: {"requestId":"r1"}\n\n';
    const events = [];
    for (const character of wire) events.push(...parser.push(character));
    assert.deepEqual(events, [
      { event: 'health', data: '{"providers":{}}' },
      { event: 'request', data: '{"requestId":"r1"}' },
    ]);
  });

  test('CRLF and CR line endings, a CRLF split between chunks, comments and multi-line data', () => {
    const parser = createEventStreamParser();
    assert.deepEqual(parser.push(': keep-alive\r\nevent: request\r\ndata: a\r'), []);
    assert.deepEqual(parser.push('\ndata: b\r\n\r'), [{ event: 'request', data: 'a\nb' }]);
    // An empty chunk (a decoder holding back half a character) does not forget the pending CR.
    assert.deepEqual(parser.push(''), []);
    assert.deepEqual(parser.push('\ndata:c\r\rdata: d\n'), [{ event: 'message', data: 'c' }]);
    assert.deepEqual(parser.push('\n'), [{ event: 'message', data: 'd' }]);
  });

  test('an event with no data is dropped and does not leak its name into the next one', () => {
    const parser = createEventStreamParser();
    assert.deepEqual(parser.push('event: health\n\ndata: x\n\n'), [{ event: 'message', data: 'x' }]);
  });
});

describe('dashboard API client', () => {
  interface Call {
    readonly url: string;
    readonly init: RequestInit | undefined;
  }

  function stubFetch(answer: (url: string) => Response | Promise<Response>): { fetchFn: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return answer(url);
    };
    return { fetchFn, calls };
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('reads the summary of the range, with the key in a header and never in the URL', async () => {
    const { fetchFn, calls } = stubFetch(() => json(200, DEMO));
    const result = await fetchSummary(fetchFn, '7d', FAKE_KEY);
    assert.deepEqual(result, { kind: 'ok', value: DEMO });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/metrics/summary?range=7d');
    assert.doesNotMatch(calls[0]?.url ?? '', new RegExp(FAKE_KEY));
    assert.deepEqual(calls[0]?.init?.headers, { accept: 'application/json', 'x-api-key': FAKE_KEY });
    assert.equal(calls[0]?.init?.credentials, 'omit');
  });

  test('401 is unauthorized; an error answer keeps its message; no answer or a bad body is offline', async () => {
    assert.deepEqual(await fetchSummary(stubFetch(() => json(401, {})).fetchFn, '24h', undefined), {
      kind: 'unauthorized',
    });
    const disabled = json(503, { error: { message: 'Analytics is off.', code: 'analytics_disabled' } });
    assert.deepEqual(await fetchSummary(stubFetch(() => disabled).fetchFn, '24h', undefined), {
      kind: 'error',
      status: 503,
      message: 'Analytics is off.',
    });
    assert.deepEqual(
      await fetchSummary(stubFetch(() => new Response('oops', { status: 500 })).fetchFn, '1h', undefined),
      {
        kind: 'error',
        status: 500,
        message: undefined,
      },
    );
    const refused: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    assert.deepEqual(await fetchSummary(refused, '24h', undefined), { kind: 'offline' });
    assert.deepEqual(await fetchSummary(stubFetch(() => json(200, { requests: 'many' })).fetchFn, '24h', undefined), {
      kind: 'offline',
    });
  });

  test('parseSummary accepts the API shape and rejects a missing or malformed field', () => {
    assert.deepEqual(parseSummary(DEMO), DEMO);
    assert.ok(parseSummary({ ...DEMO, prices_verified_on: null, savings_percent: null, spend_usd: 'unknown' }));
    assert.equal(parseSummary({ ...DEMO, spend_usd: 0 }), undefined);
    assert.equal(parseSummary({ ...DEMO, prices_verified_on: { oldest: 'soon', newest: '2026-09-19' } }), undefined);
    assert.equal(parseSummary({ ...DEMO, prices_verified_on: undefined }), undefined);
    assert.equal(parseSummary({ ...DEMO, origin: null }), undefined);
    assert.equal(parseSummary({ ...DEMO, substituted_requests: undefined }), undefined);
    assert.equal(parseSummary({ ...DEMO, substituted_requests: -1.5 }), undefined);
    assert.equal(parseSummary({ ...DEMO, substituted_requests: 12 })?.substituted_requests, 12);
    assert.equal(parseSummary(null), undefined);
  });

  test('the newest request time comes from /api/requests?limit=1; none yet is null', async () => {
    const some = stubFetch(() => json(200, { entries: [{ timestamp: '2026-09-19T11:17:27.708Z' }], nextCursor: null }));
    const found = await fetchLastRequestTime(some.fetchFn, undefined);
    assert.equal(some.calls[0]?.url, '/api/requests?limit=1');
    assert.deepEqual(found, { kind: 'ok', value: new Date('2026-09-19T11:17:27.708Z') });
    const none = await fetchLastRequestTime(
      stubFetch(() => json(200, { entries: [], nextCursor: null })).fetchFn,
      undefined,
    );
    assert.deepEqual(none, { kind: 'ok', value: null });
  });

  function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  test('reads /api/events with fetch streaming and reports each event, then that the stream dropped', async () => {
    const { fetchFn, calls } = stubFetch(
      () =>
        new Response(streamOf(['event: health\ndata: {}\n\nevent: req', 'uest\ndata: {"timestamp":"x"}\n\n']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const seen: string[] = [];
    let opened = 0;
    const end = await readEventStream(fetchFn, FAKE_KEY, new AbortController().signal, {
      onOpen: () => {
        opened += 1;
      },
      onEvent: (event) => seen.push(`${event.event} ${event.data}`),
    });
    assert.equal(opened, 1);
    assert.deepEqual(seen, ['health {}', 'request {"timestamp":"x"}']);
    assert.deepEqual(end, { kind: 'dropped' });
    assert.equal(calls[0]?.url, '/api/events');
    assert.deepEqual(calls[0]?.init?.headers, { accept: 'text/event-stream', 'x-api-key': FAKE_KEY });
  });

  test('a 401 stream is unauthorized, a 503 or a network error is dropped, an abort is aborted', async () => {
    const handlers = { onOpen: () => assert.fail('never opened'), onEvent: () => {} };
    const signal = new AbortController().signal;
    assert.deepEqual(await readEventStream(stubFetch(() => json(401, {})).fetchFn, undefined, signal, handlers), {
      kind: 'unauthorized',
    });
    assert.deepEqual(await readEventStream(stubFetch(() => json(503, {})).fetchFn, undefined, signal, handlers), {
      kind: 'dropped',
    });
    const refused: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    assert.deepEqual(await readEventStream(refused, undefined, signal, handlers), { kind: 'dropped' });
    const aborted = new AbortController();
    aborted.abort();
    const abortedFetch: FetchLike = () => Promise.reject(new DOMException('aborted', 'AbortError'));
    assert.deepEqual(await readEventStream(abortedFetch, undefined, aborted.signal, handlers), { kind: 'aborted' });
  });
});

describe('dashboard overview', () => {
  test('the demo summary: figure, lead, meter, the three basis chips and the cards', () => {
    const view = describeOverview(DEMO, BASE_URL);
    assert.equal(view.empty, false);
    assert.equal(view.savings.figure.text, '$0.000192');
    assert.equal(view.savings.figureMuted, false);
    assert.deepEqual(view.savings.lead, {
      kind: 'percent',
      percent: '0.84%',
      positive: true,
      rest: ' less than the requested models would have cost at catalog prices.',
    });
    assert.deepEqual(view.savings.meter, {
      spendPercent: 99.16,
      savedPercent: 0.84,
      label: 'Spend is 99.16% of baseline; savings are 0.84%',
      baselineLegend: 'Saved, of a baseline of $0.0228',
    });
    assert.deepEqual(view.savings.chips.map(chipText), [
      'Usage 240 reported \u00b7 0 estimated',
      'Savings known for all requests',
      'Prices verified 2026-09-19',
    ]);
    assert.deepEqual(
      view.savings.chips.map((chip) => chip.warning),
      [false, false, false],
    );
    assert.deepEqual(
      view.cards.map((card) => [card.label, card.value.text, card.note]),
      [
        ['Requests', '240', '0 errors'],
        ['Spend', '$0.0226', 'Every served request priced'],
        ['Baseline', '$0.0228', 'Requested models at catalog price'],
      ],
    );
  });

  test('requests left out of savings: a warning chip with the count, and a lower-bound spend note', () => {
    const view = describeOverview(
      {
        ...DEMO,
        errors: 1,
        unpriced_requests: 6,
        unknown_savings_requests: 18,
        prices_verified_on: { oldest: '2026-09-01', newest: '2026-09-19' },
      },
      BASE_URL,
    );
    const warning = view.savings.chips[1];
    assert.equal(chipText(warning), '18 requests left out: savings unknown');
    assert.equal(warning?.warning, true);
    assert.equal(chipText(view.savings.chips[2]), 'Prices verified 2026-09-01 to 2026-09-19');
    assert.equal(view.cards[0].note, '1 error');
    assert.equal(view.cards[1].note, 'Lower bound: 6 requests unpriced');
    assert.equal(
      chipText(describeOverview({ ...DEMO, unknown_savings_requests: 1 }, BASE_URL).savings.chips[1]),
      '1 request left out: savings unknown',
    );
  });

  test('unknown savings: the word Unknown, muted, an explanation, no meter, never $0', () => {
    const view = describeOverview(
      {
        ...DEMO,
        requests: 12,
        spend_usd: 'unknown',
        unpriced_requests: 12,
        baseline_usd: 'unknown',
        savings_usd: 'unknown',
        savings_percent: null,
        unknown_savings_requests: 12,
        origin: { reported: 12, estimated: 0 },
        prices_verified_on: null,
      },
      BASE_URL,
    );
    assert.equal(view.savings.figure.text, 'Unknown');
    assert.equal(view.savings.figureMuted, true);
    assert.equal(view.savings.meter, undefined);
    assert.equal(view.savings.lead.kind, 'text');
    assert.match(view.savings.lead.kind === 'text' ? view.savings.lead.text : '', /nothing to compare against/);
    assert.deepEqual(view.savings.chips.map(chipText), [
      'Usage 12 reported \u00b7 0 estimated',
      '12 requests left out: savings unknown',
      'No catalog price in this range',
    ]);
    assert.deepEqual(
      view.cards.map((card) => [card.value.text, card.value.unknown, card.note]),
      [
        ['12', false, '0 errors'],
        ['Unknown', true, 'No request could be priced'],
        ['Unknown', true, 'Requested models at catalog price'],
      ],
    );
  });

  test('an empty range: $0.00 muted, where to point the SDK, no meter and no chips', () => {
    const view = describeOverview(
      {
        ...DEMO,
        requests: 0,
        spend_usd: '0.000000',
        baseline_usd: '0.000000',
        savings_usd: '0.000000',
        savings_percent: null,
        origin: { reported: 0, estimated: 0 },
        prices_verified_on: null,
      },
      BASE_URL,
    );
    assert.equal(view.empty, true);
    assert.equal(view.savings.figure.text, '$0.00');
    assert.equal(view.savings.figureMuted, true);
    assert.deepEqual(view.savings.lead, { kind: 'empty', baseUrl: BASE_URL });
    assert.equal(view.savings.meter, undefined);
    assert.deepEqual(view.savings.chips, []);
    assert.deepEqual(
      view.cards.map((card) => [card.value.text, card.note]),
      [
        ['0', '0 errors'],
        ['$0.00', 'No requests yet'],
        ['$0.00', 'Requested models at catalog price'],
      ],
    );
  });

  test('negative savings: a minus sign, "more than", a full spend bar and nothing positive', () => {
    const view = describeOverview(
      { ...DEMO, spend_usd: '0.023000', savings_usd: '-0.000248', savings_percent: -1.09 },
      BASE_URL,
    );
    assert.equal(view.savings.figure.text, '-$0.000248');
    assert.deepEqual(view.savings.lead, {
      kind: 'percent',
      percent: '1.09%',
      positive: false,
      rest: ' more than the requested models would have cost at catalog prices.',
    });
    assert.equal(view.savings.meter?.spendPercent, 100);
    assert.equal(view.savings.meter?.savedPercent, 0);
  });

  test('a known baseline of zero has no percentage: a plain sentence and no meter', () => {
    const view = describeOverview(
      { ...DEMO, baseline_usd: '0.000000', savings_usd: '0.000000', savings_percent: null },
      BASE_URL,
    );
    assert.deepEqual(view.savings.lead, { kind: 'text', text: 'No baseline cost in this range.' });
    assert.equal(view.savings.meter, undefined);
    assert.equal(view.savings.chips.length, 3);
  });
});

describe('dashboard theme and page', () => {
  test('a stored theme wins over the system; otherwise the system decides', () => {
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme(null, true), 'dark');
    assert.equal(resolveTheme('purple', false), 'light');
    assert.deepEqual(toggleLabels('light'), { text: 'Dark', name: 'Switch to dark theme' });
    assert.deepEqual(toggleLabels('dark'), { text: 'Light', name: 'Switch to light theme' });
  });

  test('the first-paint script reads the same storage entry and is loaded as a classic script first', () => {
    const init = readFileSync(path.join(here, '..', 'src', 'dashboard', 'theme-init.ts'), 'utf8');
    assert.ok(init.includes(`'${THEME_ENTRY}'`));
    assert.doesNotMatch(init, /^\s*(import|export)\s/m, 'a classic script has no import or export');
    const page = readFileSync(path.join(here, '..', 'src', 'dashboard', 'index.html'), 'utf8');
    const initTag = page.indexOf('<script src="/dashboard/theme-init.js"></script>');
    assert.ok(initTag !== -1 && initTag < page.indexOf('<link rel="stylesheet"'));
    assert.doesNotMatch(page, /<script>|<style|style=/, 'no inline script or style: the CSP forbids them');
    assert.doesNotMatch(page, /https?:\/\//, 'no asset from another host');
  });
});

/** A request served by another model of an equivalence group, as /api/requests returns it. */
const SUBSTITUTED_ENTRY = {
  requestId: 'a1f0c3d2-7b1e-4c55-9e0a-5d2b8c7e4f10',
  timestamp: '2026-09-19T15:22:04.000Z',
  status: 'complete',
  route: {
    format: 'openai',
    requestedModel: 'gpt-6-astra',
    requestedProvider: 'openai',
    usedModel: 'deepseek-v4-pro',
    usedProvider: 'deepseek',
    policy: 'cheapest',
    decision: 'routed',
  },
  reason: 'routed by the cheapest policy',
  cost_usd: '0.000020',
  savings_usd: '0.000155',
  trace: [{ provider: 'deepseek', model: 'deepseek-v4-pro', outcome: 'ok', status: 200, duration_ms: 2 }],
  latency_ms: 3,
  first_byte_ms: null,
  origin: 'reported',
  baseline_usd: '0.000175',
  usage: { input: 10, output: 5 },
  needs: { tools: false, json_mode: false, vision: false, streaming: false },
  price: null,
  selection: null,
  substituted: true,
  substitution: { requested_model: 'gpt-6-astra', served_model: 'deepseek-v4-pro', group: 'frontier' },
};

/** The same request served by the requested model (`false`), or stored before substitutions were recorded (`null`). */
const notSubstituted = (
  substituted: false | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...SUBSTITUTED_ENTRY,
  route: { ...SUBSTITUTED_ENTRY.route, usedModel: 'gpt-6-astra', usedProvider: 'openai' },
  substituted,
  substitution: null,
  ...overrides,
});

const parsed = (value: unknown): RecentEntry => {
  const entry = parseRecentEntry(value);
  assert.ok(entry, 'the entry parses');
  return entry;
};

describe('dashboard model substitution', () => {
  test('the parser keeps true with its substitution, false and null, each exactly', () => {
    const substituted = parsed(SUBSTITUTED_ENTRY);
    assert.equal(substituted.substituted, true);
    assert.deepEqual(substituted.substitution, {
      requested_model: 'gpt-6-astra',
      served_model: 'deepseek-v4-pro',
      group: 'frontier',
    });
    const same = parsed(notSubstituted(false));
    assert.equal(same.substituted, false);
    assert.equal(same.substitution, null);
    const older = parsed(notSubstituted(null));
    assert.equal(older.substituted, null);
    assert.equal(older.substitution, null);
  });

  test('the parser refuses a missing, malformed or self-contradicting pair', () => {
    const { substituted: _substituted, substitution: _substitution, ...withoutFields } = SUBSTITUTED_ENTRY;
    assert.equal(parseRecentEntry(withoutFields), undefined);
    assert.equal(parseRecentEntry({ ...SUBSTITUTED_ENTRY, substituted: 'true' }), undefined);
    assert.equal(parseRecentEntry({ ...SUBSTITUTED_ENTRY, substitution: null }), undefined);
    assert.equal(parseRecentEntry({ ...SUBSTITUTED_ENTRY, substituted: false }), undefined);
    assert.equal(parseRecentEntry({ ...SUBSTITUTED_ENTRY, substituted: null }), undefined);
    assert.equal(
      parseRecentEntry({ ...SUBSTITUTED_ENTRY, substitution: { requested_model: 'gpt-6-astra', served_model: 7 } }),
      undefined,
    );
    assert.equal(parseSubstitution(true, { requested_model: 'a', served_model: 'b' }), undefined);
    assert.equal(parseSubstitution(undefined, null), undefined);
    assert.deepEqual(parseSubstitution(false, null), { substituted: false, substitution: null });
    assert.deepEqual(parseSubstitution(null, null), { substituted: null, substitution: null });
  });

  test('a page and a live event carry the substitution the same way', () => {
    const page = parseRecentPage({ entries: [SUBSTITUTED_ENTRY, notSubstituted(null)], nextCursor: '1-2' });
    assert.deepEqual(
      page?.entries.map((entry) => entry.substituted),
      [true, null],
    );
    const broken = { ...SUBSTITUTED_ENTRY, substitution: null };
    assert.equal(parseRecentPage({ entries: [broken], nextCursor: null }), undefined);
    const live = parseRecentEvent(JSON.stringify(SUBSTITUTED_ENTRY));
    assert.deepEqual(live?.substitution, SUBSTITUTED_ENTRY.substitution);
  });

  test('a substituted row is marked in words, with both models in its accessible name', () => {
    const row = tableRow(parsed(SUBSTITUTED_ENTRY), '15:22:04');
    assert.deepEqual(row.substitution, {
      requestedModel: 'gpt-6-astra',
      servedModel: 'deepseek-v4-pro',
      label: 'Substituted: requested gpt-6-astra, served deepseek-v4-pro',
    });
    assert.equal(
      row.accessibleName,
      'Open request at 15:22:04, gpt-6-astra to deepseek. Substituted: requested gpt-6-astra, served deepseek-v4-pro',
    );
    for (const value of [false, null] as const) {
      const plain = tableRow(parsed(notSubstituted(value)), '15:22:04');
      assert.equal(plain.substitution, undefined);
      assert.equal(plain.accessibleName, 'Open request at 15:22:04, gpt-6-astra to openai');
    }
    assert.equal(substitutionMark(parsed(notSubstituted(false))), undefined);
  });

  test('the drawer section: the substitution, the same model, a refusal, or not recorded', () => {
    assert.deepEqual(substitutionSection(parsed(SUBSTITUTED_ENTRY)), {
      kind: 'substituted',
      requestedModel: 'gpt-6-astra',
      servedModel: 'deepseek-v4-pro',
      group: 'frontier',
    });
    assert.deepEqual(substitutionSection(parsed(notSubstituted(false))), {
      kind: 'none',
      note: 'Same model as requested.',
    });
    const refused = notSubstituted(false, {
      status: 'refused',
      route: { ...SUBSTITUTED_ENTRY.route, usedModel: null, usedProvider: null, decision: 'fail' },
      trace: [],
      cost_usd: null,
      savings_usd: null,
    });
    assert.deepEqual(substitutionSection(parsed(refused)), {
      kind: 'none',
      note: 'No provider was called, so no model was substituted.',
    });
    assert.deepEqual(substitutionSection(parsed(notSubstituted(null))), {
      kind: 'not-recorded',
      note: 'Not recorded for this request.',
    });
  });

  test('the overview counts substituted requests and says they happen only inside enabled groups', () => {
    const text = (summary: Summary): string | undefined =>
      describeOverview(summary, BASE_URL)
        .savings.substitution?.map((run) => run.text)
        .join('');
    const rule = 'Substitution happens only inside equivalence groups turned on in the configuration.';
    assert.equal(text(DEMO), `Substituted models served 0 requests. ${rule}`);
    assert.equal(text({ ...DEMO, substituted_requests: 1 }), `Substituted models served 1 request. ${rule}`);
    assert.equal(text({ ...DEMO, substituted_requests: 1204 }), `Substituted models served 1,204 requests. ${rule}`);
    const strong = describeOverview({ ...DEMO, substituted_requests: 12 }, BASE_URL)
      .savings.substitution?.filter((run) => run.strong === true)
      .map((run) => run.text);
    assert.deepEqual(strong, ['12 requests']);
    const unknown = { ...DEMO, savings_usd: 'unknown', savings_percent: null, substituted_requests: 3 };
    assert.equal(text(unknown), `Substituted models served 3 requests. ${rule}`);
    assert.equal(text({ ...DEMO, requests: 0 }), undefined);
  });
});
