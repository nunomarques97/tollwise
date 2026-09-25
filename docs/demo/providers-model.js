// What the Providers view shows for each configured provider: state, latency and the shared latency
// plot (DESIGN.md §14). Pure: no DOM access, so it is tested under Node without a browser.
import { computeTicks } from './charts/scale.js';
import { formatClock, formatCount, formatMs, plural } from './format.js';
/** State shape, text and colour (DESIGN.md §14.4). */
export const HEALTH_STATE_INFO = {
    up: { shape: 'circle', text: 'Up', tone: 'text' },
    down: { shape: 'square', text: 'Down', tone: 'danger' },
    unknown: { shape: 'ring', text: 'Not checked yet', tone: 'muted' },
};
/** The words for a provider's last error kind, as it appears after "Down ·" (DESIGN.md §14.4). */
export const HEALTH_ERROR_TEXT = {
    rate_limit: 'rate limited',
    overloaded: 'overloaded',
    server: 'server error',
    timeout: 'timed out',
    connection: 'connection failed',
    auth: 'key refused',
    bad_request: 'bad request',
    unknown: 'failed',
};
function plotOf(provider, axisMax) {
    if (provider.p50_ms === null || provider.p95_ms === null)
        return undefined;
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
function providerRow(id, provider, axisMax) {
    const lastCheckedText = provider.last_checked === null ? undefined : formatClock(new Date(provider.last_checked));
    return {
        id,
        state: HEALTH_STATE_INFO[provider.state],
        errorNote: provider.state === 'down' && provider.last_error_kind !== null
            ? HEALTH_ERROR_TEXT[provider.last_error_kind]
            : undefined,
        p50Text: formatMs(provider.p50_ms),
        p95Text: formatMs(provider.p95_ms),
        plot: plotOf(provider, axisMax),
        samples: provider.samples,
        lastCheckedText,
        metaText: lastCheckedText === undefined
            ? 'First check pending'
            : `${plural(provider.samples, 'sample', 'samples')} · checked ${lastCheckedText}`,
    };
}
/** The whole Providers view (DESIGN.md §14.2), built from one GET /api/health snapshot. */
export function buildProvidersView(health) {
    const providers = [...health.providers.values()];
    const downCount = providers.filter((provider) => provider.state === 'down').length;
    const summaryText = `${formatCount(providers.length)} configured · ${downCount === 0 ? 'all up' : `${formatCount(downCount)} down`}`;
    const maxP95 = providers.reduce((max, provider) => (provider.p95_ms !== null ? Math.max(max, provider.p95_ms) : max), 0);
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
