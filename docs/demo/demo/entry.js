// Entry point of the static demo page (built by scripts/build-demo-site.ts): runs the same dashboard shell
// as the live page on the recorded snapshot, which the build writes next to this module as snapshot.js.
import { startDashboard } from '../shell.js';
import snapshot from './snapshot.js';
import { snapshotSource } from './snapshot-source.js';
// As markScriptLoaded in ../main.ts: lets a check tell the module loaded under the page's CSP.
document.documentElement.dataset.script = 'loaded';
startDashboard(snapshotSource(snapshot));
