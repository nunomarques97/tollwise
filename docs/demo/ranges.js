// The time ranges the metrics API accepts, their labels, and how the selected one is kept in the URL
// fragment (#range=7d) so a reload keeps it. Pure: no DOM access.
export const RANGES = [
    { id: '1h', label: '1 hour', span: 'hour' },
    { id: '24h', label: '24 hours', span: '24 hours' },
    { id: '7d', label: '7 days', span: '7 days' },
    { id: '30d', label: '30 days', span: '30 days' },
];
/** The range the page shows when the fragment names none: the API's own default. */
export const DEFAULT_RANGE = '24h';
export function isRangeId(value) {
    return RANGES.some((range) => range.id === value);
}
export function rangeOption(id) {
    return RANGES.find((range) => range.id === id) ?? RANGES[1];
}
/** The range named by a URL fragment such as "#range=7d"; `fallback` (the default range) for anything else. */
export function rangeFromHash(hash, fallback = DEFAULT_RANGE) {
    const value = new URLSearchParams(hash.replace(/^#/, '')).get('range');
    return value !== null && isRangeId(value) ? value : fallback;
}
/** The URL fragment that keeps `range`: "#range=7d". */
export function hashForRange(range) {
    return `#range=${range}`;
}
/** The heading of the savings block: "Saved in the last 24 hours". */
export function savedHeading(range) {
    return `Saved in the last ${rangeOption(range).span}`;
}
/**
 * The option a key press on the range selector moves to, or undefined for keys the selector does not
 * handle. Arrow keys wrap around; Home and End go to the first and last option.
 */
export function rangeAfterKey(current, key) {
    const index = RANGES.findIndex((range) => range.id === current);
    const last = RANGES.length - 1;
    let next;
    switch (key) {
        case 'ArrowRight':
        case 'ArrowDown':
            next = index >= last ? 0 : index + 1;
            break;
        case 'ArrowLeft':
        case 'ArrowUp':
            next = index <= 0 ? last : index - 1;
            break;
        case 'Home':
            next = 0;
            break;
        case 'End':
            next = last;
            break;
        default:
            return undefined;
    }
    return RANGES[next]?.id;
}
