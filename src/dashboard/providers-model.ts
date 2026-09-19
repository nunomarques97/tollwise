// What the Providers view shows for each configured provider: state, latency and the shared latency
// plot (DESIGN.md §14). Pure: no DOM access, so it is tested under Node without a browser.

import type { HealthErrorKind, HealthProvider, HealthSnapshot, HealthState } from './api.ts';
import { computeTicks } from './charts/scale.ts';
import { formatClock, formatCount, formatMs, plural } from './format.ts';

export type HealthShape = 'circle' | 'square' | 'ring';
/** `text`: the state's colour is `--text`, never green (DESIGN.md §14.4) -- green stays for savings. */
export type HealthTone = 'text' | 'danger' | 'muted';

export interface HealthStateInfo {
  readonly shape: HealthShape;
  readonly text: string;
  readonly tone: HealthTone;
}

/** State shape, text and colour (DESIGN.md §14.4). */
export const HEALTH_STATE_INFO: Readonly<Record<HealthState, HealthStateInfo>> = {
  up: { shape: 'circle', text: 'Up', tone: 'text' },
  down: { shape: 'square', text: 'Down', tone: 'danger' },
  unknown: { shape: 'ring', text: 'Not checked yet', tone: 'muted' },
};

/** The words for a provider's last error kind, as it appears after "Down ·" (DESIGN.md §14.4). */
export const HEALTH_ERROR_TEXT: Readonly<Record<HealthErrorKind, string>> = {
  rate_limit: 'rate limited',
  overloaded: 'overloaded',
  server: 'server error',
  timeout: 'timed out',
  connection: 'connection failed',
  auth: 'key refused',
  bad_request: 'bad request',
  unknown: 'failed',
};

export interface LatencyPlot {
  /** Percent (0 to 100) of the axis width at which p50 sits. */
  readonly p50Percent: number;
  /** Percent (0 to 100) of the axis width at which p95 sits. */
  readonly p95Percent: number;
  /** Left edge and width, in percent, of the p50-to-p95 bar. */
  readonly barLeftPercent: number;
  readonly barWidthPercent: number;
}

export interface ProviderRow {
  readonly id: string;
  readonly state: HealthStateInfo;
  /** "rate limited", shown after "Down ·" only when down with a known error kind. */
  readonly errorNote: string | undefined;
  readonly p50Text: string;
  readonly p95Text: string;
  readonly plot: LatencyPlot | undefined;
  readonly samples: number;
  /** The local HH:MM:SS of the last check; undefined when none happened yet. */
  readonly lastCheckedText: string | undefined;
  /** "100 samples · checked 15:21:50", or "First check pending". */
  readonly metaText: string;
}

function plotOf(provider: HealthProvider, axisMax: number): LatencyPlot | undefined {
  if (provider.p50_ms === null || provider.p95_ms === null) return undefined;
  const scale = axisMax > 0 ? 100 / axisMax : 0;
  const p50Percent = provider.p50_ms * scale;
  const p95Percent = provider.p95_ms * scale;
  return {
    p50Percent,
    p95Percent,
    barLeftPercent: Math.min(p50Percent, p95Percent),
    barWidthPercent: Math.max(0, p95Percent - p50Percent),
  };
}

function providerRow(id: string, provider: HealthProvider, axisMax: number): ProviderRow {
  const lastCheckedText = provider.last_checked === null ? undefined : formatClock(new Date(provider.last_checked));
  return {
    id,
    state: HEALTH_STATE_INFO[provider.state],
    errorNote:
      provider.state === 'down' && provider.last_error_kind !== null
        ? HEALTH_ERROR_TEXT[provider.last_error_kind]
        : undefined,
    p50Text: formatMs(provider.p50_ms),
    p95Text: formatMs(provider.p95_ms),
    plot: plotOf(provider, axisMax),
    samples: provider.samples,
    lastCheckedText,
    metaText:
      lastCheckedText === undefined
        ? 'First check pending'
        : `${plural(provider.samples, 'sample', 'samples')} · checked ${lastCheckedText}`,
  };
}

export interface AxisTick {
  readonly text: string;
  /** Percent (0 to 100) of the axis width at which this tick sits. */
  readonly percent: number;
}

export interface ProvidersView {
  readonly summaryText: string;
  readonly downCount: number;
  readonly rows: readonly ProviderRow[];
  /** The shared x axis (DESIGN.md §14.2): "0 ms" up to a "nice" maximum covering every p95. */
  readonly axisMaxText: string;
  readonly axisTicks: readonly AxisTick[];
}

/** The whole Providers view (DESIGN.md §14.2), built from one GET /api/health snapshot. */
export function buildProvidersView(health: HealthSnapshot): ProvidersView {
  const providers = [...health.providers.values()];
  const downCount = providers.filter((provider) => provider.state === 'down').length;
  const summaryText = `${formatCount(providers.length)} configured · ${downCount === 0 ? 'all up' : `${formatCount(downCount)} down`}`;

  const maxP95 = providers.reduce(
    (max, provider) => (provider.p95_ms !== null ? Math.max(max, provider.p95_ms) : max),
    0,
  );
  // Labels are whole milliseconds, so the step never goes below 1 ms (a 2 ms maximum is 0, 1, 2 ms).
  const ticks = computeTicks(maxP95, 0, Math.max(1, Math.min(4, Math.ceil(maxP95))));
  const axisMax = ticks.max > 0 ? ticks.max : 1;
  const axisTicks = ticks.values.map((value) => ({
    text: value === 0 ? '0 ms' : `${formatCount(value)} ms`,
    percent: (value / axisMax) * 100,
  }));

  const rows = [...health.providers.entries()].map(([id, provider]) => providerRow(id, provider, axisMax));

  return { summaryText, downCount, rows, axisMaxText: `${formatCount(axisMax)} ms`, axisTicks };
}
