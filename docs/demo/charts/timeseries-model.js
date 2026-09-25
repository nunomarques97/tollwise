// The Savings view's savings-over-time / spend-over-time chart: bucket selection, per-bucket marks
// (DESIGN.md §12.4 -- unknown savings is never drawn as $0 or a zero-height column, negative savings
// never mistaken for zero), x-axis labels, the readout line and the accessible table alternative. Pure:
// no DOM, so it runs unchanged under Node's test runner; the element in ../elements only draws it.
import { formatCount, formatUsd, parseMicros, plural } from '../format.js';
import { rangeOption } from '../ranges.js';
import { computeTicks } from './scale.js';
/** The bucket a Savings-view chart uses for `range` at the current width (DESIGN.md §12.2 table). */
export function bucketForRange(range, narrow) {
    if (range === '1h')
        return narrow ? '5m' : '1m';
    if (range === '7d')
        return narrow ? '1d' : '1h';
    if (range === '24h')
        return '1h';
    return '1d';
}
/** The word the chart titles use for one bucket: "Saved per minute", "Spend per day (UTC)". */
export function bucketWord(bucket) {
    switch (bucket) {
        case '1m':
            return 'minute';
        case '5m':
            return '5 minutes';
        case '1h':
            return 'hour';
        case '1d':
            return 'day (UTC)';
    }
}
/** Classifies every bucket for drawing; a value of 'unknown' is never confused with a $0 value. */
export function classifyBuckets(buckets) {
    const lastIndex = buckets.length - 1;
    return buckets.map((bucket, index) => {
        const savingsMicros = parseMicros(bucket.savings_usd);
        const spendMicros = parseMicros(bucket.spend_usd);
        const requests = bucket.requests;
        let savings;
        if (requests === 0)
            savings = { kind: 'empty' };
        else if (savingsMicros === null)
            savings = { kind: 'unknown' };
        else if (savingsMicros === 0)
            savings = { kind: 'zero' };
        else
            savings = { kind: 'value', amount: savingsMicros / 1_000_000 };
        const spend = requests === 0 || spendMicros === null ? { kind: 'gap' } : { kind: 'value', amount: spendMicros / 1_000_000 };
        return {
            index,
            start: new Date(bucket.bucket_start),
            inProgress: index === lastIndex,
            requests,
            unknownSavingsRequests: bucket.unknown_savings_requests,
            leftOut: requests > 0 && savingsMicros !== null && bucket.unknown_savings_requests > 0,
            savings,
            spend,
        };
    });
}
/** The largest known savings amount across `buckets`, for the savings axis; 0 when none is known. */
export function maxSavings(buckets) {
    return buckets.reduce((max, b) => (b.savings.kind === 'value' ? Math.max(max, b.savings.amount) : max), 0);
}
/** The smallest known savings amount (<= 0 only when a bucket is negative); 0 when none is negative. */
export function minSavings(buckets) {
    return buckets.reduce((min, b) => (b.savings.kind === 'value' ? Math.min(min, b.savings.amount) : min), 0);
}
/** The largest known spend amount across `buckets`, for the spend axis; 0 when none is known. */
export function maxSpend(buckets) {
    return buckets.reduce((max, b) => (b.spend.kind === 'value' ? Math.max(max, b.spend.amount) : max), 0);
}
export function spendRuns(buckets) {
    const lines = [];
    const dots = [];
    let run = [];
    const close = () => {
        if (run.length === 1 && run[0] !== undefined)
            dots.push(run[0]);
        else if (run.length > 1)
            lines.push(run);
        run = [];
    };
    for (const bucket of buckets) {
        if (bucket.spend.kind === 'value')
            run.push(bucket.index);
        else
            close();
    }
    close();
    return { lines, dots };
}
/**
 * The spend line's SVG geometry: one `d` string with a moveto per run (never a lone moveto) and the
 * centre of each isolated dot. `x` maps a bucket index to its slot centre, `y` a dollar amount to a height.
 */
export function spendGeometry(buckets, x, y) {
    const pointOf = (index) => {
        const spend = buckets[index]?.spend;
        return { x: x(index), y: y(spend?.kind === 'value' ? spend.amount : 0) };
    };
    const runs = spendRuns(buckets);
    const d = runs.lines
        .map((line) => line
        .map((index, position) => {
        const point = pointOf(index);
        return `${position === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
        .join(' '))
        .join(' ');
    return { d, dots: runs.dots.map(pointOf) };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad2(value) {
    return String(value).padStart(2, '0');
}
function hourMinute(date, utc) {
    const hours = utc ? date.getUTCHours() : date.getHours();
    const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
    return `${pad2(hours)}:${pad2(minutes)}`;
}
function isoDate(date, utc) {
    if (utc)
        return date.toISOString().slice(0, 10);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
/**
 * A bucket's start for the readout and the table: the UTC ISO date for daily buckets, local `HH:MM`
 * otherwise, with the local ISO date in front when the range spans several days (`1h` in 7 days), so
 * "14:00" never repeats ambiguously across days.
 */
export function bucketStartText(date, bucketSize, multiDay) {
    if (bucketSize === '1d')
        return isoDate(date, true);
    const time = hourMinute(date, false);
    return multiDay ? `${isoDate(date, false)} ${time}` : time;
}
/** The short "Mon D" date form (en-US), the one place it is allowed (DESIGN.md §12.3). */
function shortDate(date, utc) {
    const month = utc ? date.getUTCMonth() : date.getMonth();
    const day = utc ? date.getUTCDate() : date.getDate();
    return `${MONTHS[month]} ${day}`;
}
function thinLabels(labels, max) {
    if (labels.length <= max)
        return [...labels];
    const step = Math.ceil(labels.length / max);
    return labels.filter((_, index) => index % step === 0);
}
/**
 * The x-axis labels for `buckets`, per the frequency/format table of DESIGN.md §12.3. At 390 px
 * (`narrow`) the result is thinned to at most 5 labels (§12.9).
 */
export function xAxisLabels(buckets, range, bucket, narrow) {
    const labels = [];
    for (const entry of buckets) {
        const date = entry.start;
        let matches = false;
        let text = '';
        switch (bucket) {
            case '1m':
                matches = date.getMinutes() % 10 === 0;
                text = hourMinute(date, false);
                break;
            case '5m':
                matches = date.getMinutes() % 15 === 0;
                text = hourMinute(date, false);
                break;
            case '1h':
                if (range === '7d') {
                    matches = date.getHours() === 0;
                    text = shortDate(date, false);
                }
                else {
                    matches = date.getHours() % (narrow ? 6 : 3) === 0;
                    text = hourMinute(date, false);
                }
                break;
            case '1d':
                matches = entry.index % (range === '30d' ? 7 : 2) === 0;
                text = shortDate(date, true);
                break;
        }
        if (matches)
            labels.push({ index: entry.index, text });
    }
    return narrow ? thinLabels(labels, 5) : labels;
}
/** Bucket `index` as one readout line; `undefined` if there is no such bucket. Daily buckets use ISO dates. */
export function readoutAt(buckets, index, bucketSize = '1m', multiDay = false) {
    const bucket = buckets[index];
    if (bucket === undefined)
        return undefined;
    const start = new Date(bucket.bucket_start);
    const empty = bucket.requests === 0;
    const dash = { text: '—', exact: undefined, unknown: false };
    return {
        time: bucketStartText(start, bucketSize, multiDay),
        inProgress: index === buckets.length - 1,
        saved: empty ? dash : formatUsd(bucket.savings_usd),
        spend: empty ? dash : formatUsd(bucket.spend_usd),
        requests: formatCount(bucket.requests),
    };
}
/** The newest bucket that has requests -- the readout's default row before any hover; undefined if none. */
export function defaultReadout(buckets, bucketSize = '1m', multiDay = false) {
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
        if ((buckets[index]?.requests ?? 0) > 0)
            return readoutAt(buckets, index, bucketSize, multiDay);
    }
    return undefined;
}
// ---------------------------------------------------------------- aria labels (DESIGN.md §12.6)
/** "Savings per minute over the last hour, 61 bars. $0.00459 saved in total; highest ... left out ...". */
export function savingsAriaLabel(range, bucket, buckets, totalSavings, leftOutCount) {
    const word = bucketWord(bucket);
    const span = rangeOption(range);
    const head = `Savings per ${word} over the last ${span.span}, ${formatCount(buckets.length)} bars.`;
    const highest = maxSavings(buckets);
    // No bucket saved money (all known values are zero or negative): a "highest $0.00" would mislead.
    const highestPart = highest > 0 ? `; highest ${formatUsd(String(highest)).text} in one ${word}` : '';
    const totalPart = totalSavings.unknown
        ? ' Total savings unknown.'
        : ` ${totalSavings.text} saved in total${highestPart}.`;
    const leftOutPart = leftOutCount > 0 ? ` ${plural(leftOutCount, 'request', 'requests')} left out: savings unknown.` : '';
    return `${head}${totalPart}${leftOutPart}`;
}
/** "Spend per minute over the last hour. $0.539 in total; highest $0.0216 in one minute." */
export function spendAriaLabel(range, bucket, buckets, totalSpend) {
    const word = bucketWord(bucket);
    const span = rangeOption(range);
    const head = `Spend per ${word} over the last ${span.span}.`;
    const highest = maxSpend(buckets);
    const totalPart = totalSpend.unknown
        ? ' Total spend unknown.'
        : ` ${totalSpend.text} in total; highest ${formatUsd(String(highest)).text} in one ${word}.`;
    return `${head}${totalPart}`;
}
/**
 * Everything the `<tw-savings-chart>` element needs to draw one refresh, built once from the raw API
 * responses so the element itself only draws what this function already decided (DESIGN.md §12.2-12.6).
 */
export function buildSavingsChartView(response, summary, range, narrow) {
    const buckets = classifyBuckets(response.buckets);
    const word = bucketWord(response.bucket);
    const savingsTotal = formatUsd(summary.savings_usd);
    const spendTotal = formatUsd(summary.spend_usd);
    const multiDay = range === '7d' || range === '30d';
    return {
        bucket: response.bucket,
        bucketWord: word,
        buckets,
        savingsTotalText: savingsTotal.unknown ? 'Unknown in total' : `${savingsTotal.text} in total`,
        spendTotalText: spendTotal.unknown ? 'Unknown in total' : `${spendTotal.text} in total`,
        savingsTicks: computeTicks(maxSavings(buckets), minSavings(buckets), 3),
        spendTicks: computeTicks(maxSpend(buckets), 0, 2),
        xLabels: xAxisLabels(buckets, range, response.bucket, narrow),
        readout: defaultReadout(response.buckets, response.bucket, multiDay),
        readouts: response.buckets.map((_, index) => readoutAt(response.buckets, index, response.bucket, multiDay)),
        savingsAriaLabel: savingsAriaLabel(range, response.bucket, buckets, savingsTotal, summary.unknown_savings_requests),
        spendAriaLabel: spendAriaLabel(range, response.bucket, buckets, spendTotal),
        tableRows: tableRows(response.buckets, response.bucket, multiDay),
    };
}
/** Every bucket as a table row, in the order the chart draws them; every bucket gets a row (DESIGN.md §12.6). */
export function tableRows(buckets, bucketSize, multiDay = false) {
    const lastIndex = buckets.length - 1;
    return buckets.map((bucket, index) => {
        const start = new Date(bucket.bucket_start);
        return {
            start: bucketStartText(start, bucketSize, multiDay),
            inProgress: index === lastIndex,
            requests: formatCount(bucket.requests),
            spend: bucket.requests === 0 ? undefined : formatUsd(bucket.spend_usd).text,
            saved: bucket.requests === 0 ? undefined : formatUsd(bucket.savings_usd).text,
            leftOut: formatCount(bucket.unknown_savings_requests),
        };
    });
}
