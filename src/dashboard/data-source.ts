// Where the dashboard shell reads its data from. The live page reads the Tollwise API of the origin that
// served it and keeps current from the event stream; the static demo (./demo/) answers the same reads
// from a recorded snapshot. Both answer with the same fetch-shaped function, so the parsing and rendering
// code is the same for either. Pure: no DOM access.

import type { FetchLike } from './api.ts';
import type { RangeId } from './ranges.ts';

export type DataSource =
  /** The Tollwise API: live event stream, retries while it is unreachable, the access-key form on 401. */
  | { readonly kind: 'live'; readonly read: FetchLike }
  /**
   * A recorded snapshot: every read is answered from memory, nothing is streamed or retried, and the
   * header says "Static demo" instead of a connection state.
   */
  | {
      readonly kind: 'snapshot';
      readonly read: FetchLike;
      /** The range the page opens on when the URL fragment names none. */
      readonly defaultRange: RangeId;
      /** The range bar's "as of" line: when the snapshot was recorded, never a live clock. */
      readonly asOf: string;
    };

/** The live Tollwise API, read with the page's own fetch. */
export function liveSource(fetchFn: FetchLike): DataSource {
  return { kind: 'live', read: fetchFn };
}
