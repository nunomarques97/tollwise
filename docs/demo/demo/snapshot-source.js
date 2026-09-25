// The static demo's data source: answers the dashboard's API reads from a recorded snapshot
// (demo/snapshot.json, built into the site as a script module). Each answer is the API response recorded
// for the exact path and query the dashboard asks for, so the page parses and renders it with the same
// code as the live dashboard. It never touches the network: a path the snapshot does not hold gets a
// 404-shaped answer built in memory. No DOM access, so it runs unchanged under Node's test runner.
/** The static demo opens on 30 days, the range whose figures equal the modeled benchmark scenario. */
export const DEMO_DEFAULT_RANGE = '30d';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The snapshot in `value` (the content of demo/snapshot.json); throws when it does not have that shape. */
export function parseSnapshot(value) {
    if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.responses)) {
        throw new Error('The demo snapshot must be an object with "meta" and "responses".');
    }
    const recordedAt = value.meta.recorded_at;
    if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
        throw new Error('The demo snapshot has no valid "meta.recorded_at" timestamp.');
    }
    const responses = new Map();
    for (const path of Object.keys(value.responses)) {
        if (!path.startsWith('/api/'))
            throw new Error('Every demo snapshot response must be keyed by an /api/ path.');
        responses.set(path, value.responses[path]);
    }
    return { recordedAt, responses };
}
function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}
/** A fetch-shaped reader that answers every path from `snapshot` and everything else with a 404. */
export function snapshotReader(snapshot) {
    return async (input) => {
        if (snapshot.responses.has(input))
            return jsonResponse(200, snapshot.responses.get(input));
        return jsonResponse(404, {
            error: {
                message: 'This data is not part of the static demo snapshot.',
                type: 'invalid_request_error',
                code: 'not_found',
            },
        });
    };
}
/** The range bar's line for the snapshot: its recording date (DESIGN.md §6.9 dates: YYYY-MM-DD, UTC here). */
export function recordedLine(snapshot) {
    return `Recorded ${new Date(snapshot.recordedAt).toISOString().slice(0, 10)}`;
}
/** The dashboard's data source for the static demo, reading `value` (the content of demo/snapshot.json). */
export function snapshotSource(value) {
    const snapshot = parseSnapshot(value);
    return {
        kind: 'snapshot',
        read: snapshotReader(snapshot),
        defaultRange: DEMO_DEFAULT_RANGE,
        asOf: recordedLine(snapshot),
    };
}
