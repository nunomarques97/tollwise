// What the overview shows for a summary: the savings block (figure, lead sentence, meter, basis chips)
// and the three KPI cards. Every wording and state rule of the overview lives here, as pure data, so it
// is tested under Node without a browser; the elements in ./elements only render it.
import { formatCount, formatPercent, formatUsd, plural } from './format.js';
const UNKNOWN_LEAD = 'None of these requests has a catalog price for the model the caller asked for, so there is nothing to compare against.';
const NO_BASELINE_LEAD = 'No baseline cost in this range.';
/** A count shown as a card value: never rounded, so it has no exact form. */
function countValue(value) {
    return { text: formatCount(value), exact: undefined, unknown: false };
}
/** Rounds a meter width to two decimals, within 0 to 100. */
function clampPercent(value) {
    return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}
function meterOf(summary, percent) {
    const saved = clampPercent(percent);
    const spend = clampPercent(100 - saved);
    return {
        spendPercent: spend,
        savedPercent: saved,
        label: `Spend is ${formatPercent(spend)} of baseline; savings are ${formatPercent(saved)}`,
        baselineLegend: `Saved, of a baseline of ${formatUsd(summary.baseline_usd).text}`,
    };
}
/** The three basis chips of §6.4 item 5: usage origin, requests left out, price dates. Also used, as
 * required by DESIGN.md §12.3, under the Savings view's chart legend. */
export function chipsOf(summary) {
    const usage = {
        warning: false,
        runs: [
            { text: 'Usage ' },
            { text: `${formatCount(summary.origin.reported)} reported`, strong: true },
            { text: ` \u00b7 ${formatCount(summary.origin.estimated)} estimated` },
        ],
    };
    const unknown = summary.unknown_savings_requests;
    const leftOut = unknown === 0
        ? { warning: false, runs: [{ text: 'Savings known for ' }, { text: 'all requests', strong: true }] }
        : {
            warning: true,
            runs: [
                { text: plural(unknown, 'request', 'requests'), strong: true },
                { text: ' left out: savings unknown' },
            ],
        };
    const dates = summary.prices_verified_on;
    const prices = dates === null
        ? { warning: false, runs: [{ text: 'No catalog price in this range' }] }
        : {
            warning: false,
            runs: [
                { text: 'Prices verified ' },
                {
                    text: dates.oldest === dates.newest ? dates.oldest : `${dates.oldest} to ${dates.newest}`,
                    strong: true,
                },
            ],
        };
    return [usage, leftOut, prices];
}
/** The overview's substitution line (DESIGN.md §6.4 item 6). */
export function substitutionLine(summary) {
    return [
        { text: 'Substituted models served ' },
        { text: plural(summary.substituted_requests, 'request', 'requests'), strong: true },
        { text: '. Substitution happens only inside equivalence groups turned on in the configuration.' },
    ];
}
function spendNote(summary) {
    if (summary.requests === 0)
        return 'No requests yet';
    if (summary.spend_usd === 'unknown')
        return 'No request could be priced';
    if (summary.unpriced_requests > 0) {
        return `Lower bound: ${plural(summary.unpriced_requests, 'request', 'requests')} unpriced`;
    }
    return 'Every served request priced';
}
/**
 * The overview for `summary`. `baseUrl` is the OpenAI-style base URL of this Tollwise instance (the
 * page's own origin plus /v1), shown in the empty state.
 */
export function describeOverview(summary, baseUrl) {
    const empty = summary.requests === 0;
    const cards = [
        { label: 'Requests', value: countValue(summary.requests), note: plural(summary.errors, 'error', 'errors') },
        { label: 'Spend', value: formatUsd(summary.spend_usd), note: spendNote(summary) },
        { label: 'Baseline', value: formatUsd(summary.baseline_usd), note: 'Requested models at catalog price' },
    ];
    if (empty) {
        return {
            empty,
            cards,
            savings: {
                figure: formatUsd('0'),
                figureMuted: true,
                lead: { kind: 'empty', baseUrl },
                meter: undefined,
                chips: [],
                substitution: undefined,
            },
        };
    }
    const figure = formatUsd(summary.savings_usd);
    const chips = chipsOf(summary);
    const substitution = substitutionLine(summary);
    if (figure.unknown) {
        return {
            empty,
            cards,
            savings: {
                figure,
                figureMuted: true,
                lead: { kind: 'text', text: UNKNOWN_LEAD },
                meter: undefined,
                chips,
                substitution,
            },
        };
    }
    const percent = summary.savings_percent;
    if (percent === null) {
        return {
            empty,
            cards,
            savings: {
                figure,
                figureMuted: false,
                lead: { kind: 'text', text: NO_BASELINE_LEAD },
                meter: undefined,
                chips,
                substitution,
            },
        };
    }
    const negative = percent < 0;
    const lead = {
        kind: 'percent',
        percent: formatPercent(Math.abs(percent)),
        positive: !negative && percent > 0,
        rest: negative
            ? ' more than the requested models would have cost at catalog prices.'
            : ' less than the requested models would have cost at catalog prices.',
    };
    return {
        empty,
        cards,
        savings: { figure, figureMuted: false, lead, meter: meterOf(summary, percent), chips, substitution },
    };
}
/** The accessible text of a money value: the exact amount when the shown one is rounded. */
export function spokenValue(value) {
    return value.exact ?? value.text;
}
