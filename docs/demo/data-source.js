// Where the dashboard shell reads its data from. The live page reads the Tollwise API of the origin that
// served it and keeps current from the event stream; the static demo (./demo/) answers the same reads
// from a recorded snapshot. Both answer with the same fetch-shaped function, so the parsing and rendering
// code is the same for either. Pure: no DOM access.
/** The live Tollwise API, read with the page's own fetch. */
export function liveSource(fetchFn) {
    return { kind: 'live', read: fetchFn };
}
