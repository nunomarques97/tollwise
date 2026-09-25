# Static demo

**[Open the static demo](https://nunomarques97.github.io/tollwise/demo/)** to click through the Tollwise dashboard in a browser, with nothing to install.

It is the real dashboard, built from the same sources as the one Tollwise serves at `/dashboard`, reading a recorded snapshot instead of the local metrics API. It shows **sample data from a modeled workload**: 100 requests from the savings benchmark, routed by a real Tollwise against local stand-in providers and priced with `catalog/models.yaml`. It is not a live service and not a measured bill, and a permanent banner on every view says so.

## What works and what does not

- **Every view:** Overview, Routing (with the routing trace of each request), Savings and Providers, in dark and light, on a wide screen or a phone.
- **Every time range:** 1 hour, 24 hours, 7 days and 30 days. The demo opens on 30 days, the range whose totals equal the modeled benchmark; the shorter ranges show the part of the same requests that falls inside them.
- **Paging:** "Load older" in the Routing view pages through all 100 requests.
- **No live updates.** The live event stream needs a running Tollwise, so the status indicator reads "Static demo" instead of "Live", and the "as of" line shows the date the snapshot was recorded instead of a clock.
- **No network at all.** The page loads its scripts, stylesheet and snapshot from its own folder and calls no API. Its Content-Security-Policy (`connect-src 'none'`) makes the browser refuse any connection.

## How the snapshot was generated

The snapshot is `demo/snapshot.json`. Its `meta` block records how it was made; the values below are taken from it.

- **Command:** `npm run demo:snapshot` (`node scripts/record-demo-snapshot.ts`). It runs the demo's `presets-on` workload (the traffic `npm run demo -- --workload presets-on` sends) in the same process: five local stand-in providers on `127.0.0.1` with fake keys, and a Tollwise whose history goes to a temporary file that is deleted afterwards.
- **Workload:** the savings benchmark's realistic workload, 100 requests built from seed `424242`, imported from `benchmarks/savings.ts`. Its assumptions (model classes, formats, request kinds, input sizes) are listed in [the benchmark method](benchmarks.md#method-1).
- **Equivalence presets:** `frontier` and `small-fast` ([what they are](equivalence-presets.md)).
- **Policy:** `cheapest`.
- **Prices:** `catalog/models.yaml`, verified on 2026-09-19.
- **Recorded at:** 2026-09-25T16:58:50Z.
- **Answers:** for every path and query the dashboard requests (the summary, time series and breakdowns of each range, the provider health, and every page of the request history), the real API answer, stored unchanged under that path.

Over 30 days the snapshot shows a spend of $0.043280 against a baseline of $0.273849: $0.230569 saved, 84.2%, with 87 of the 100 requests served by a substituted model. These are the totals of the `presets-on` scenario with the `cheapest` policy in [`benchmarks/results/savings-2026-09-25.json`](../benchmarks/results/savings-2026-09-25.json), and a test fails if they ever differ. With the default configuration, which only switches between providers of the requested model, the same workload saves 0.07%.

### The timestamp schedule

A live run sends all 100 requests within a few seconds, which would put every request in the last hour and every chart in a single bar. The recorder therefore stores each request at a time on a fixed, seeded schedule within the 30 days before the recording time, and measures every range back from that time. The routing, cost and savings of each request are those of the live run; only its timestamp is set.

| Range | Requests placed | Seconds before the recording time |
| --- | ---: | --- |
| Last hour | 4 | 60 to 3,300 |
| 1 to 23 hours before | 10 | 3,600 to 82,800 |
| 1 to 6.5 days before | 26 | 86,400 to 561,600 |
| 7 to 29.5 days before | 60 | 604,800 to 2,548,800 |

So the last hour holds 4 requests, 24 hours 14, 7 days 40 and 30 days all 100. The generator is `mulberry32` seeded with `20260925`, the same generator the benchmark uses. It first draws each tier's offsets, uniformly within the tier and rounded down to a whole second, tier by tier in the order above. It then shuffles the request indices (Fisher-Yates, same generator) and gives the i-th offset to the i-th shuffled request, so the requests are not grouped in time by workload segment.

## Verify or regenerate the snapshot

To check that the committed snapshot is still what the code records, without writing anything:

```
node scripts/record-demo-snapshot.ts --verify
```

It records again with the committed recording time, compares every value, and exits 0 with `demo/snapshot.json matches a new recording (volatile values ignored).` Request ids, measured latencies and health-check times differ from run to run, so the fields named in `meta.volatile_fields` are left out of the comparison. It exits 1 and lists the first differences when anything else has changed, for example after a catalog price or a routing rule changed.

To record a new snapshot, as of now:

```
npm run demo:snapshot
```

Then rebuild the site (next section): the test suite fails while the built site and the snapshot disagree.

## Rebuild the site

```
npm run build:demo-site
```

It compiles the dashboard sources with `tsconfig.dashboard.json` into `docs/demo/`, together with the dashboard's stylesheet, its page with relative asset paths, the demo banner, the demo's Content-Security-Policy, and the snapshot embedded as a script module. It empties `docs/demo/` first, and refuses an output folder that holds files it did not build. `npm test` builds the site again into a temporary folder and fails when the result differs from the committed `docs/demo/`.

To check the built site in a browser:

```
npm run verify:demo-site
```

It serves `docs/demo/` locally under `/tollwise/demo/`, the way GitHub Pages does, and uses Playwright with the installed Google Chrome to open every view and the routing trace at 1440 and 390 pixels wide, in dark and light. For each one it saves a screenshot to `.tmp-demo-site/` and runs an axe-core accessibility scan (WCAG 2.2 AA). It also walks every time range, pages the Routing view to its end, checks the banner and the "Static demo" status, and fails on any network request the page makes. It exits 1 if anything fails.

## Serve it with GitHub Pages

The built site is committed in `docs/demo/`, and `docs/.nojekyll` tells GitHub Pages to serve the `docs/` folder as plain files, without running Jekyll. No workflow is needed. In the repository on GitHub:

1. Open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Set **Branch** to **main** and the folder to **/docs**, then select **Save**.

After the first deployment, the demo is at **https://nunomarques97.github.io/tollwise/demo/**. Pages publishes the whole `docs/` folder, so the documentation pages are served too, as plain Markdown files; the site has no page at its root, so `https://nunomarques97.github.io/tollwise/` itself answers 404. Each push to `main` that changes `docs/` deploys again.
