// Which top-level view the dashboard shows, and the URL fragment shared by every view: #view=<id>&range=
// <range> (DESIGN.md §12: "the range in the fragment is shared by all views, so switching tabs keeps
// it"). Pure: no DOM access.
import { DEFAULT_RANGE } from './ranges.js';
/** Tab order (DESIGN.md §13/§14): Overview · Routing · Savings · Providers. */
export const VIEWS = [
    { id: 'overview', label: 'Overview' },
    { id: 'routing', label: 'Routing' },
    { id: 'savings', label: 'Savings' },
    { id: 'providers', label: 'Providers' },
];
export const DEFAULT_VIEW = 'overview';
export function isViewId(value) {
    return VIEWS.some((view) => view.id === value);
}
/** The view named by a URL fragment such as "#view=savings&range=7d"; the default for anything else. */
export function viewFromHash(hash) {
    const value = new URLSearchParams(hash.replace(/^#/, '')).get('view');
    return value !== null && isViewId(value) ? value : DEFAULT_VIEW;
}
/** The URL fragment that keeps both the view and the range: "#view=savings&range=7d". */
export function hashFor(view, range = DEFAULT_RANGE) {
    return `#view=${view}&range=${range}`;
}
