# Dashboard design directions

Three directions were built as static mocks for the first dashboard screen (the shell: header, views, theme, access-key form, range selector and the live summary). Each uses the same real numbers: `npm run demo -- --count 240 --seed 7`, then `GET /api/metrics/summary?range=24h` and the six newest entries of `GET /api/requests`. The "partial" and "unknown" states of the chosen direction use illustrative numbers and say so in the source.

Open a mock with a local static server and add `?theme=light|dark` (and, for Meter, `&state=locked|wrong-key|loading|empty|partial|unknown|offline|error`). Screenshots are in `screens/`, named `<direction>[-<state>]-<theme>-<width>.png`, at 1440×1000 and 390×844.

## The brief

- **Who:** a developer or small team running Tollwise on their laptop or their own server, glancing at the dashboard while their code sends requests.
- **Single job:** show what routing saved over a range, and how far that figure can be trusted.
- **Mood:** precise, calm, auditable.
- **Avoid:** external fonts or assets, any savings figure without its basis (reported or estimated usage, price date, requests left out), a missing price shown as `$0`, and the usual dashboard clichés (gradient heroes, glass panels, emoji icons, cards inside cards).
- **Readable in five seconds:** how much was saved in the selected range, and whether any requests were left out of that figure.

## The three directions

| | A. Statement | B. Console | C. Meter |
|---|---|---|---|
| Layout logic | Left sidebar for views; a single "statement" sheet: baseline, minus spend, equals saved | Top bar; four equal KPI tiles; a live tape of routed requests | Top tabs; one savings hero with a spend/saved meter; three KPI cards below |
| Type | System serif headings + system sans + monospace figures | Monospace throughout, system sans for nothing but form text | System sans only, heavy display weight, tabular figures |
| Signature | The `Baseline − Spend = Saved` equation | The live request tape | The meter: the baseline as one bar, the saved share in green |
| Palette | Cool grey paper, ink blue, green for saved | Navy, amber highlight | Neutral grey and graphite, blue for interaction, green only for savings |
| Radii | 4, 8 | 2 | 6, 12, full |
| Screens | `screens/statement-*` | `screens/console-*` | `screens/meter-*` |

## The pick: C. Meter

1. **Five-second question.** Meter answers it first and alone: the page's largest element is the saved amount for the selected range, with its share of the baseline right under it and a chip that turns amber the moment any requests are left out. In Statement the eye lands on the baseline row before reaching the result; in Console savings is one tile out of four, with the same weight as the request count.
2. **Honest with small numbers.** The real demo saves 0.84 % of baseline. The meter shows that as a sliver, which is true, and the headline and legend carry the exact figures. Nothing in the layout needs a large number to look right, and the unknown state replaces the figure with the word "Unknown" instead of `$0`.
3. **Sets the pattern for the later views.** Full-width content under top tabs gives routing decisions (a table) and savings over time (a chart) the whole width. Statement's sidebar costs 232 px at 1440 and collapses into a menu at 390; Console's tape is the routing-decisions view in miniature, so the overview would duplicate a later screen.
4. **Accessibility and 390.** Every text pair clears 4.5:1 in both themes, controls clear 3:1, and at 390 the range selector becomes a full-width segmented control with 40 px targets. Console's all-monospace text wraps poorly at 390 ("240 reported · 0 / estimated") and its uppercase labels are harder to read.
5. **Slop check.** No gradient, no glass, no emoji, no card inside a card (the three KPI cards merge into one grouped list at 390 rather than nesting), system fonts only. The dark theme's green is a muted jade used only for savings, never as the brand colour, so it does not become the near-black + acid-green look.

What the others do better, and what Meter keeps from them: Statement's explicit arithmetic is the clearest audit trail, so the meter legend names the baseline and the lead line says "less than the requested models would have cost at catalog prices". Console's density suits power users, and that belongs in the routing-decisions view, not the overview.

# Savings view: chart treatments

Three chart treatments were built inside the Meter direction for the Savings view: savings over time, spend over time, and spend by provider and by model. All three use the same real API responses, captured from `npm run demo -- --seed 7` and stored in `charts-data.js` (`timeseries?range=1h&bucket=1m|5m`, `breakdown?range=1h&by=provider|model`, `summary?range=1h`). The "unknown" state marks two real buckets as wholly unknown and one as partly unknown; those figures are illustrative and the source says so.

Open `charts-<treatment>.html?theme=light|dark` from a local static server (for Split also `&state=loading|empty|unknown|error`). Screenshots: `screens/charts-<treatment>[-<state>]-<theme>-<width>.png`; `screens/charts-split-table-*` show the table alternatives open.

## The brief

- **Who:** the same developer as the overview, checking whether routing keeps saving money and which provider or model the money goes to.
- **Single job:** show the shape of savings over the range, with spend as context, and where the spend went.
- **Mood:** precise, calm, auditable (unchanged).
- **Avoid:** a missing price drawn as `$0`; a saving that only looks right when it is large; chart-library clichés (gradients, rounded 3D bars, pies); colour as the only signal.
- **Readable in five seconds:** is routing saving money in every period of this range, and is any period left out.

## The three treatments

| | A. Stack | B. Split | C. Ledger |
|---|---|---|---|
| Savings over time | Columns of spend with saved stacked on top (each column a small meter; height = baseline) | Two charts on one time axis: savings columns on their own scale, spend line under them | Running totals: cumulative baseline (dashed) and spend (solid), the gap between them filled green |
| Breakdown | One card with a By provider / By model switch, horizontal bars | Two cards side by side, horizontal bars with share and lower-bound notes | Two tables with inline bars |
| Unknown savings | Hatched column behind the spend | Full-height hatched band; a left-out strip under partly unknown buckets | Left-out strip only; the running totals silently exclude unknown buckets |
| Screens | `screens/charts-stack-*` | `screens/charts-split-*` | `screens/charts-ledger-*` |

## The pick: B. Split

1. **Five-second question.** With the real demo data (savings are 0.84 % of spend), Split is the only treatment where the savings are visible at all: 61 green columns with a readable shape and a hatched band wherever savings are unknown. In Stack the saved share is a one-pixel cap on grey columns; in Ledger the two running totals overlap into a single line and the green gap cannot be seen at 1440 or at 390.
2. **Honest with the data the API has.** Split draws `savings_usd` and `spend_usd` per bucket exactly as returned. Stack and Ledger both need a per-bucket baseline, which the timeseries does not return; computing it as spend + savings is wrong whenever some requests are unpriced or left out, which is exactly the case the product must be honest about.
3. **Unknown is never zero.** Split has a distinct mark for each case (empty slot, `$0.00` stub, left-out strip, hatched band, broken line). Ledger's running totals cannot show an unknown period at all: they carry on as if it cost nothing extra.
4. **390 px and accessibility.** At 390 Split uses 5-minute buckets and stacks the breakdown cards; every chart has a text alternative and a complete table behind a native disclosure. Stack's spend-over-saved stacking needs grey and green to be told apart at 1 px (1.55:1 between them); Ledger's end labels do not fit at 390 and are dropped.
5. **Slop check.** No gradient, no pie, no rounded bars, no card inside a card. Green stays reserved for savings; spend uses a new neutral chart token, `--chart-spend`, at 3.93:1 (light) and 4.93:1 (dark) against the surface.

What the others do better, and what Split keeps: Stack ties each period back to the baseline, which is the overview's meter idea, so Split keeps the baseline in the basis chips and the overview. Ledger's tables with inline bars are the most scannable breakdown, so Split's bars also show the value and the share on every row, and a full table is one keypress away.

# Routing and Providers views: request log and trace detail

Three directions were built inside the Meter system for the Routing view: the recent requests table with a detail panel for one request's routing trace. The system itself (tokens, type, spacing, radii, shell) is fixed by `DESIGN.md` §1–§11, so the directions differ in layout logic, in where the detail lives and in their signature element, not in palette or type. The Providers view (latency p50/p95 and health per provider) was designed once, inside the chosen direction.

Data: `routing-data.js` holds real responses captured from `npm run demo` on 2026-09-19 (`GET /api/requests?limit=200`, `GET /api/health`), plus each request's stored latency, cost origin, price dates, needs and usage read from the demo database, because `/api/requests` does not return them yet. Two rows are illustrative and say so in the detail (a refused request that needs images, and a passthrough to a model with no catalog price). Candidates and exclusions are not recorded by Tollwise yet; the mock derives them from the real catalog entries and the demo's equivalence group. In the Providers mock, one provider is shown down and one not yet checked (illustrative: in the demo all five are up, at 0 to 2 ms).

Open `routing-<direction>.html?theme=light|dark` from a local static server; add `&open=1` to open the detail, `&state=refused|new|loading|empty|error`, or `&view=providers`. Screenshots: `screens/routing-<direction>[-<state>]-<theme>-<width>.png` and `screens/providers[-<state>]-<theme>-<width>.png`, at 1440×1000 and 390×844, taken with Playwright on the system Chrome.

## The brief

- **Who:** the same developer, when a number on the overview needs explaining: which provider served a request, why that one, and what it cost against what they asked for.
- **Single job:** show the latest routing decisions at a glance, and the full reasoning for any one of them on demand.
- **Mood:** precise, calm, auditable (unchanged).
- **Avoid:** a detail that hides the price source or its date; a fallback that looks like a clean success; a missing price shown as `$0`; rows that jump while being read; colour as the only signal of a failure.
- **Readable in five seconds:** where the latest requests went, and whether any of them failed, fell back or was refused.

## The three directions

| | A. Drawer | B. Inline | C. Split |
|---|---|---|---|
| Layout logic | Full-width table; the detail opens in a modal side drawer (520 px) over it; a full-screen sheet at 390 | Full-width table; a row expands in place into a three-column detail band | Master and detail side by side (7 : 5); the pane always shows the selected request; at 390 the list opens a detail page |
| Table at 1440 | All eight columns | All eight columns | Five (Requested, Policy and Cost move to the pane) |
| Signature | The route strip: requested model, then each attempt in order, failed ones dashed | Attempt pips in the row: one square per provider call, hollow when it failed | The candidate ladder: ranked candidates with their catalog price as bars |
| Keyboard | Modal dialog: focus moves in, is trapped, Escape closes, focus returns to the row | Disclosure buttons, no trap | Selection moves the pane; no trap |
| Screens | `screens/routing-drawer-*` | `screens/routing-inline-*` | `screens/routing-split-*` |

## The pick: A. Drawer

1. **Five-second question.** The table is the answer, and A and B are the only directions that keep all eight columns at 1440 (time, requested model, routed provider and model, policy, cost, savings with origin, latency, status). Split has to drop three of them to fit next to its pane, so cost and policy are no longer visible at a glance.
2. **The detail has room to be honest.** The trace needs long model ids, two price rows with their source URLs and dates, ranked candidates and exclusion reasons. In the drawer they get 470 px of single-column text; in Inline's band the three columns squeeze attempt results and URLs into 280 px each and wrap them mid-word; in Split's pane results overflow their column.
3. **Live updates never move what is being read.** New requests arrive at the top. With the drawer, the request being read sits in a surface that does not move, and the table queues new rows behind a "N new requests" button while it is open or scrolled. Inline pushes the open band down with every new row, which is exactly the layout shift §1 principle 3 forbids; avoiding it would mean freezing the table whenever a row is open.
4. **Keyboard and 390.** A modal dialog is the best-understood pattern for focus management: focus moves to the title, is trapped, Escape closes, focus returns to the row that opened it. At 390 the same component becomes a full-screen sheet with a 44 px Close button. Split at 390 needs a second navigation model (a page with Back), and Inline at 390 makes a single list item several screens long.
5. **Slop check.** No gradient, glass, emoji or card inside a card (the drawer is a surface over a scrim, not a card in a card); green stays reserved for savings and the live state; failures are dashed outlines and hollow squares with text, never colour alone.

What the others do better, and what the Drawer keeps: Inline's attempt pips make a fallback visible in the table without opening anything, so the chosen table keeps them in the "Routed to" column, together with the "after 1 failure" note. Split's always-visible detail is fastest for comparing requests one after another; the drawer does not copy it in this version, and says so as a known limit in `DESIGN.md` §13.
