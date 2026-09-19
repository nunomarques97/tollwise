// Which top-level view the dashboard shows, and the URL fragment shared by every view: #view=<id>&range=
// <range> (DESIGN.md §12: "the range in the fragment is shared by all views, so switching tabs keeps
// it"). Pure: no DOM access.

import { DEFAULT_RANGE, type RangeId } from './ranges.ts';

export type ViewId = 'overview' | 'routing' | 'savings' | 'providers';

export interface ViewOption {
  readonly id: ViewId;
  readonly label: string;
}

/** Tab order (DESIGN.md §13/§14): Overview · Routing · Savings · Providers. */
export const VIEWS: readonly ViewOption[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'routing', label: 'Routing' },
  { id: 'savings', label: 'Savings' },
  { id: 'providers', label: 'Providers' },
];

export const DEFAULT_VIEW: ViewId = 'overview';

export function isViewId(value: string): value is ViewId {
  return VIEWS.some((view) => view.id === value);
}

/** The view named by a URL fragment such as "#view=savings&range=7d"; the default for anything else. */
export function viewFromHash(hash: string): ViewId {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('view');
  return value !== null && isViewId(value) ? value : DEFAULT_VIEW;
}

/** The URL fragment that keeps both the view and the range: "#view=savings&range=7d". */
export function hashFor(view: ViewId, range: RangeId = DEFAULT_RANGE): string {
  return `#view=${view}&range=${range}`;
}
