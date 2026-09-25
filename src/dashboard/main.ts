// Entry point of the live dashboard page, loaded as an ES module from /dashboard/main.js: runs the shell
// (./shell.ts) on the Tollwise API of the origin that served the page. The static demo has its own entry
// (./demo/entry.ts) that runs the same shell on a recorded snapshot.

import { liveSource } from './data-source.ts';
import { startDashboard } from './shell.ts';

/** Marks the page as scripted, so a check can tell the module loaded under the page's CSP. */
export function markScriptLoaded(root: HTMLElement): void {
  root.dataset.script = 'loaded';
}

markScriptLoaded(document.documentElement);
startDashboard(liveSource(window.fetch.bind(window)));
