# Tollwise dashboard design system

The dashboard is served by Tollwise itself at `/dashboard`. It is built with plain TypeScript, native Web Components and hand-drawn SVG, with no framework, no external font, no CDN and no asset loaded from anywhere but the Tollwise process. Everything below uses system font stacks and CSS custom properties only. The page's Content-Security-Policy allows same-origin files only (`default-src 'self'`), so there are no inline `<script>` or `<style>` blocks and no `style="…"` attributes; dynamic values such as the meter widths are set from script through `element.style` or SVG attributes.

Direction: **Meter**. The overview leads with one number, what routing saved in the selected range, and shows next to it everything needed to trust that number: the share of the baseline, where the usage figures came from, how many requests were left out, and the date of the prices. Reference mocks: `docs/design/mocks/meter.html` and `docs/design/mocks/screens/meter-*`.

## 1. Principles

1. **One answer first.** Each view has one primary figure or element; everything else is visibly secondary.
2. **Every money figure carries its basis.** Savings are never shown without the usage origin (reported / estimated), the count of requests left out, and the price date. A missing price is the word "Unknown", never `$0`.
3. **Calm when idle.** Nothing moves unless data changed. Live updates change numbers in place without shifting the layout.
4. **Same process, same origin.** No request leaves for another host; the access key stays in the tab (session storage) and travels only in a request header.

## 2. Colour

Colours are CSS custom properties on `:root[data-theme="light"]` and `:root[data-theme="dark"]`. Contrast ratios are WCAG 2.x relative-luminance ratios, computed for each pair listed.

| Role | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F7F7F8` | `#121316` | Page background |
| `--surface` | `#FFFFFF` | `#1B1D21` | Cards, header controls, form panel |
| `--text` | `#1A1C21` | `#ECEDEF` | Primary text and figures |
| `--muted` | `#5C626C` | `#A2A7B0` | Labels, secondary text, inactive tabs |
| `--accent` | `#2D56C8` | `#8DA8FF` | Interactive: focus ring, active tab underline, primary button, links |
| `--on-accent` | `#FFFFFF` | `#0E1430` | Text on `--accent` |
| `--positive` | `#17704A` | `#6CC79C` | Savings only: the percentage, the meter's saved segment, the live dot |
| `--warning` | `#8A5300` | `#E5AA50` | Requests left out of savings; paused live updates |
| `--warning-bg` | `#FDF4E6` | `#2A2217` | Background of warning chips and banners |
| `--danger` | `#B42318` | `#F38A80` | Errors: rejected key, metrics unavailable |
| `--danger-bg` | `#FDECEA` | `#2E1B1A` | Background of error banners |
| `--line` | `#E3E5E9` | `#2C2F35` | Decorative borders and dividers (not a control boundary) |
| `--control` | `#80868F` | `#6E7481` | Borders of inputs, buttons and segmented controls |
| `--meter-spend` | `#B7BDC7` | `#4A4F58` | The meter's spend segment |
| `--meter-track` | `#E3E5E9` | `#2C2F35` | The meter's empty track |
| `--skeleton` | `#ECEDF0` | `#25282D` | Loading placeholders |
| `--chart-spend` | `#7A818C` | `#858B96` | Spend in charts: the spend line and the breakdown bars (§12); the p50-to-p95 bar (§14) |
| `--highlight` | `#EAF0FC` | `#1D2436` | Background of a request row that just arrived live (§13.6) |
| `--scrim` | `rgba(26, 28, 33, 0.45)` | `rgba(0, 0, 0, 0.6)` | Behind the request drawer (§13.4); never behind text that must be read |

Measured contrast (light / dark):

- `--text` on `--bg` 15.92 / 15.86; on `--surface` 17.05 / 14.41.
- `--muted` on `--bg` 5.74 / 7.69; on `--surface` 6.14 / 6.98.
- `--accent` on `--bg` 5.99 / 8.12; on `--surface` 6.41 / 7.38; `--on-accent` on `--accent` 6.41 / 7.90.
- `--positive` on `--surface` 6.08 / 8.27; on `--bg` 5.68 / 9.10.
- `--warning` on `--surface` 6.33 / 8.20; on `--warning-bg` 5.80 / 7.61; `--text` on `--warning-bg` 15.63 / 13.38.
- `--danger` on `--surface` 6.57 / 7.04; on `--danger-bg` 5.75 / 6.80; `--text` on `--danger-bg` 14.91 / 13.92.
- `--bg` on `--text` (selected segment) 15.92 / 15.86.
- `--control` on `--surface` 3.67 / 3.60; on `--bg` 3.43 / 3.96 (non-text minimum 3:1).
- `--positive` against `--meter-spend` 3.22 / 4.03 (the two meter segments are distinguishable).
- `--chart-spend` on `--surface` 3.93 / 4.93; on `--bg` 3.67 / 5.42; against `--meter-track` (a breakdown bar on its track) 3.11 / 3.92 (non-text minimum 3:1).
- `--warning` on `--line` (the unknown-savings hatch crossing a gridline) 5.02 / 6.52.
- On `--highlight`: `--text` 14.91 / 13.20; `--muted` 5.37 / 6.40; `--accent` 5.61 / 6.76; `--positive` 5.32 / 7.58; `--danger` 5.75 / 6.45; `--warning` 5.54 / 7.51.
- On `--bg` (a hovered or selected table row): `--danger` 6.14 / 7.75; `--warning` 5.91 / 9.02.

`--line` and `--meter-spend` against the surface are below 3:1 on purpose: they are decoration, and every piece of information they carry is also given in text.

### Theme

- First visit: follow `prefers-color-scheme`. Set `color-scheme: light` or `dark` on the root so native controls and scrollbars match.
- The header toggle switches between light and dark and stores the choice in `localStorage` under `tollwise.theme`. Once stored, the choice wins over the system setting. The toggle's visible text names the theme it switches to ("Dark" / "Light"); its accessible name is "Switch to dark theme" / "Switch to light theme".
- Apply the stored theme before first paint so the page never flashes the wrong theme: a small same-origin script loaded first in `<head>` (a classic script, not a module and not inline) sets `data-theme` on the root.

## 3. Typography

System stacks only. No web font is ever loaded.

- `--font`: `system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
- `--font-mono`: `ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace` — only for values a user may copy: environment variable names, URLs, model ids in tables, the access-key input.

Every figure uses `font-variant-numeric: tabular-nums` so live updates do not make digits jump.

| Token | Size / line height | Weight | Letter spacing | Use |
|---|---|---|---|---|
| `display` | 64 / 1.05 (44 at ≤ 720 px) | 700 | -0.03em | The one primary figure of a view |
| `figure` | 32 / 1.1 (22 at ≤ 720 px) | 700 | -0.02em | KPI card values |
| `title` | 22 / 1.3 | 700 | -0.01em | Form and empty-state titles |
| `lead` | 17 / 1.5 | 400 | 0 | The sentence under the display figure |
| `body` | 15 / 1.5 | 400 | 0 | Default text |
| `label` | 14–15 / 1.4 | 600 | 0 | Card and section labels (`--muted`) |
| `small` | 13 / 1.4 | 400 | 0 | Chips, legends, timestamps, hints |

Brand wordmark: "Tollwise", 18 px, 700, -0.02em, preceded by the meter mark (see §7). No other decorative type.

## 4. Spacing, radii, elevation, layout

- Spacing scale (px): `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24, `--s-6` 32, `--s-7` 48. No other values.
- Radii: `--r-s` 6 px (inputs, meter track, skeletons, code), `--r-m` 12 px (cards, form panel, banners), `--r-full` 999 px (chips, segmented controls, header buttons). Three values only.
- Elevation: none. Surfaces are separated by a 1 px `--line` border and the `--bg` / `--surface` step. No shadows, no blur, no gradients.
- Content column: `max-width: 1200px`, centred, side padding `--s-6` (32) above 720 px and `--s-4` (16) at or below.
- Vertical rhythm between blocks: `--s-5` (24) above 720 px, `--s-4` (16) at or below.

## 5. Layout of the shell

```
[mark Tollwise]  Overview  Routing  Savings  Providers          (•) Live  [ Dark ]
[ 1 hour | 24 hours | 7 days | 30 days ]                      Last request 13:11:03
+---------------------------------------------------------------------------------+
| Saved in the last 24 hours                                                      |
| $0.000192                                                                       |
| 0.84% less than the requested models would have cost at catalog prices.         |
| [============================== spend ==============================|saved]     |
| ■ Spend                                        ■ Saved, of a baseline of $0.0228 |
| (Usage 240 reported · 0 estimated) (Savings known for all requests) (Prices …)  |
+---------------------------------------------------------------------------------+
+-------------------------+ +-------------------------+ +-------------------------+
| Requests  240  0 errors | | Spend  $0.0226  …       | | Baseline  $0.0228  …    |
+-------------------------+ +-------------------------+ +-------------------------+
```

- **Header** (one row above 720 px): wordmark, view tabs, flexible space, live-status indicator, theme toggle.
- **Tabs** are links (`<nav aria-label="Views">`, `aria-current="page"` on the active one), 15 px, weight 500, `--muted`; the active tab is `--text` with a 2 px `--accent` underline. A tab appears only when its view exists; the shell ships with Overview alone and hides the nav when there is a single view.
- **Range bar**: the range selector on the left, the "as of" line (`small`, `--muted`) on the right.
- **Primary block**, then **secondary blocks** in a 3-column grid (gap 24).

Later views keep this frame (header, tabs, range bar) and put their own primary element in the primary block: routing decisions puts the table there, savings over time the chart, provider health a list of providers. They do not repeat the overview's summary.

### At 390 px (breakpoint: `max-width: 720px`)

- Header wraps: wordmark, live status and theme toggle on the first row; tabs on a second, full-width row that scrolls horizontally if it overflows (never wraps to two lines).
- The range selector spans the full width; each option is an equal share with a 44 px minimum height. Every other interactive control (theme toggle, tabs, skip link, form controls) is also at least 44 px high.
- The "as of" line goes under the range selector, left aligned.
- `display` drops to 44 px, `figure` to 22 px, card padding to 16 / 20.
- Secondary cards merge into one grouped list: a single surface with 1 px dividers, each row label + note on the left, value right-aligned. This is one card with rows, not cards inside a card.
- Chips wrap onto as many lines as needed; banners stack title over text.
- No horizontal scroll of the page at 390 px, in any state, in either theme.

## 6. Components

### 6.1 Live-status indicator

`<span role="status">` in the header: an 8 px shape followed by a text label. The text always says the state, so colour is never the only signal; the shape changes too.

| State | Shape | Text | When |
|---|---|---|---|
| Live | filled circle, `--positive` | "Live" | The `/api/events` stream is open |
| Connecting | 2 px ring, `--muted` | "Connecting" | First load, or while opening the stream |
| Paused | filled square, `--warning` | "Reconnecting" | The stream dropped; retry every 5 s |
| Not connected | filled square, `--warning` | "Not connected" | The metrics API answered with an error that retrying will not fix |

The "as of" line in the range bar says "Last request HH:MM:SS" (local time, 24-hour) while live, "As of HH:MM:SS" while paused, "Waiting for the first request" when the range is empty, and "Loading…" while loading.

### 6.2 Theme toggle

A pill button (`--r-full`, 36 px high (44 at ≤ 720 px), 1 px `--control` border, `--surface` fill) in the header. See §2 Theme for behaviour.

### 6.3 Range selector

- A segmented control: `role="group"` with `aria-label="Time range"` and four `<button type="button">` children with `aria-pressed`. Labels: "1 hour", "24 hours", "7 days", "30 days", mapping to `range=1h|24h|7d|30d`. Default: 24 hours (the API's default).
- Container: `--surface`, 1 px `--control` border, `--r-full`, 3 px inner padding. Option: 14 px, 32 px high (44 at ≤ 720 px), `--muted`. Selected: `--text` fill, `--bg` text, weight 600.
- Arrow keys move between options and select; Tab enters and leaves the group as one stop (roving `tabindex`).
- The selected range is kept in the URL fragment (`#range=7d`) so a reload keeps it. Changing range refetches the summary; the previous figures stay visible, dimmed to 60 % opacity with `aria-busy="true"` on the primary block, until the new ones arrive.

### 6.4 Savings block (primary block of the overview)

Anatomy, top to bottom:

1. **Label** (`label`, `--muted`, an `<h1>`): "Saved in the last 1 hour | 24 hours | 7 days | 30 days".
2. **Figure** (`display`): `savings_usd` formatted per §6.9. "Unknown" in `--muted` when `savings_usd` is `unknown`.
3. **Lead** (`lead`, `--muted`, max 60ch): "**0.84%** less than the requested models would have cost at catalog prices." The percentage is `--positive`, weight 700. When `savings_percent` is `null` with a known baseline of zero, show "No baseline cost in this range." When savings are unknown: "None of these requests has a catalog price for the model the caller asked for, so there is nothing to compare against."
4. **Meter** (the signature element): a 20 px bar, `--r-s`, `--meter-track` background. Spend segment width = `100 − savings_percent` %, `--meter-spend`; saved segment the rest, `--positive`, at least 4 px wide so a small saving stays visible. The bar is `role="img"` with an `aria-label` such as "Spend is 99.16% of baseline; savings are 0.84%". Legend below (`small`, `--muted`), each with a 10 px square swatch: left "Spend", right "Saved, of a baseline of $0.0228". The meter is omitted when savings are unknown or the range is empty. If savings are negative (routing cost more than the baseline), the figure shows a leading minus, the lead says "more than the requested models would have cost", the meter shows a full spend bar with no saved segment, and nothing is coloured `--positive`.
5. **Basis chips** (`small`, `--r-full`, 1 px `--line` border, values in `--text` weight 600), always all three:
   - "Usage **N reported** · M estimated" from `origin.reported` / `origin.estimated`.
   - "Savings known for **all requests**" when `unknown_savings_requests` is 0; otherwise the warning chip "**N requests** left out: savings unknown" (`--warning` border and value, `--warning-bg` fill). The warning chip is never hidden or collapsed.
   - "Prices verified **YYYY-MM-DD**", or "Prices verified **YYYY-MM-DD to YYYY-MM-DD**" when the priced requests in the range used catalog prices checked on different days. These are the catalog `verified_on` dates stored with each request.
6. **Substitution line** (13 px, `--muted`, max 64ch, 12 px above it; the count in `--text` weight 600): "Substituted models served **N requests**. Substitution happens only inside equivalence groups turned on in the configuration." from `substituted_requests`. Always shown for a non-empty range, "0 requests" included, so the reader learns that another model never serves a request silently; omitted for an empty range.

### 6.5 KPI cards (secondary blocks of the overview)

Three cards, in this order. Card: `--surface`, 1 px `--line`, `--r-m`, padding 24. Label (`label`, `--muted`, `<h2>`), value (`figure`), note (14 px, `--muted`).

| Card | Value | Note |
|---|---|---|
| Requests | `requests` | "N errors" (`errors`, "1 error" singular) |
| Spend | `spend_usd` | "Every served request priced" when `unpriced_requests` is 0; "Lower bound: N requests unpriced" otherwise; "No request could be priced" when `spend_usd` is `unknown`; "No requests yet" when `requests` is 0 |
| Baseline | `baseline_usd` | "Requested models at catalog price" |

An `unknown` value shows the word "Unknown" in `--muted`, never `$0`.

### 6.6 Access-key form

Shown instead of the whole view when the API answers 401, with no key in session storage or with one that was refused. The header keeps the wordmark and theme toggle; tabs and live status are hidden.

- Panel: `--surface`, 1 px `--line`, `--r-m`, padding 32 (24 at ≤ 720 px), max 440 px wide, centred, 48 px below the header (full width at ≤ 720 px).
- Title (`title`): "Enter the access key".
- Text (`--muted`): "This Tollwise instance is protected by an access key. It is the value of `TOLLWISE_ACCESS_KEY` where Tollwise runs."
- Field: visible `<label for>` "Access key"; `<input type="password" autocomplete="off" spellcheck="false">` in `--font-mono`, 44 px high, `--bg` fill, 1 px `--control` border, `--r-s`; a "Show" / "Hide" button beside it (`aria-pressed`) that toggles the input type.
- Hint (`small`, `--muted`): "Kept only in this browser tab and sent as a request header, never in the address bar."
- Submit: full-width primary button "Open dashboard", 44 px high, `--accent` fill, `--on-accent` text, weight 600.
- Refused key: the input gets `aria-invalid="true"` and `aria-describedby` pointing to the message under it, in `--danger`: "That key was not accepted. Check the value of TOLLWISE_ACCESS_KEY and try again." Focus returns to the input with its content selected. The refused key is removed from session storage.
- The form is a real `<form>`; Enter submits. The key is never placed in the URL, a cookie, `localStorage`, the page title or any log line.

### 6.7 Banners

Full-width blocks above the primary block, `--r-m`, padding 12 / 16, a bold lead-in followed by one or two sentences that say what happened and what to do. `role="alert"` when they appear after the page loaded.

- **Warning** (`--warning-bg`, 1 px `--warning` border): live updates paused. "**Live updates paused.** The connection to Tollwise was lost. Retrying every 5 seconds; the numbers below are from 13:11:03."
- **Error** (`--danger-bg`, 1 px `--danger` border): metrics unavailable. Lead-in "Metrics unavailable." followed by the API's own error message (for example the analytics-disabled message), which is fixed server text and safe to show.

### 6.8 Loading placeholders

Grey blocks (`--skeleton`, `--r-s`) at the size and position of the text they stand for, inside the real card frames, so nothing shifts when data arrives. The primary block has `aria-busy="true"` and an `aria-label` "Loading summary". No shimmer or pulse.

### 6.9 Numbers and time

- Money: `$` plus the amount. At or above $1: two decimals with thousands separators (`$1,204.50`). Below $1: enough decimals for three significant digits, between 2 and 6 (`$0.0226`, `$0.000192`); exactly zero is `$0.00`. The full six-decimal value from the API is available in the element's `title` and accessible name when the displayed value is rounded.
- `unknown` is the word "Unknown", never a number.
- Percentages: up to two decimals, trailing zeros dropped (`0.84%`, `12.5%`).
- Counts: thousands separators (`12,480`).
- Times: the viewer's local time, 24-hour `HH:MM:SS`. Dates: ISO `YYYY-MM-DD`.
- Locale for all formatting: `en-US`, to match the rest of the product.

## 7. Brand mark

A 22 px inline SVG: a 20 × 4 rounded bar in `currentColor` with its last 6 px in `--positive` — the meter in miniature. `aria-hidden="true"`; the wordmark text carries the name. No other logo, icon font or emoji anywhere. Icons, if a later view needs any, are inline SVG in `currentColor`.

## 8. States of the overview

| State | Trigger | What the user sees |
|---|---|---|
| Locked | API answers 401 | Access-key form only (§6.6) |
| Key refused | Submitted key answered 401 | Form with the danger message (§6.6) |
| Loading | First fetch in flight | Frame, range bar, placeholders (§6.8); status "Connecting" |
| Empty | `requests` is 0 | Figure `$0.00` in `--muted`; lead "No requests in this range yet. Point your SDK's `base_url` at `http://127.0.0.1:8484/v1` and send a request; it appears here as soon as it completes." (use the address the page itself was served from); no meter, no chips; cards show 0 / `$0.00` with the "No requests yet" note |
| Live | Data loaded, stream open | §5 layout |
| Partly unknown | `unknown_savings_requests` > 0 | Figure and meter from the known requests; warning chip "N requests left out: savings unknown"; spend note "Lower bound: …" when some are unpriced |
| Unknown | `savings_usd` is `unknown` | Figure "Unknown" in `--muted`, explanatory lead, no meter, warning chip, Spend/Baseline cards "Unknown" as applicable |
| Paused | Event stream dropped | Last numbers stay; warning banner; status "Reconnecting"; "As of HH:MM:SS" |
| Error | Metrics API answers 5xx (e.g. analytics off) | Error banner with the API message; no figures; status "Not connected" |
| Long text | Long model ids, large amounts | Figures never truncate: `overflow-wrap: anywhere` on the display figure; labels wrap; chips wrap to new lines |

Reference screenshots for each: `docs/design/mocks/screens/meter-<state>-<theme>-<width>.png`.

## 9. Motion

- Nothing animates while nothing changes. No idle pulse, shimmer or looping animation.
- One signature moment per screen: when a live update changes the summary, the meter's segments ease to their new widths (200 ms, `ease-out`) and the live dot scales once (1 → 1.6 → 1, 400 ms). Numbers swap without animation.
- Theme change, tab change and range change are instant.
- Under `prefers-reduced-motion: reduce`, both signature transitions are off.

## 10. Accessibility floor (WCAG 2.2 AA)

- Contrast as measured in §2: text ≥ 4.5:1, control boundaries and focus ring ≥ 3:1, both themes.
- Focus: every interactive element shows `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`. Never remove an outline without that replacement. Focus is never hidden behind other content.
- Targets: at least 24 × 24 px everywhere (WCAG 2.5.8); at ≤ 720 px every interactive control (theme toggle, tabs, skip link, range options) is at least 44 px high; the access-key form controls are 44 px at every width.
- Keyboard: a "Skip to content" link first; the order is header → tabs → range → content; the range selector is one tab stop with arrow keys; everything reachable and operable without a pointer.
- Semantics: one `<h1>` per view (the primary block's label); card labels are `<h2>`; landmarks `header`, `nav`, `main`. The live status is `role="status"`; the "as of" line is not live, to avoid chatter. Summary updates are not announced one by one.
- Colour is never the only signal: states carry text and a shape change; the meter has a text alternative and a text legend; the warning chip says what is wrong.
- Zoom and reflow: usable at 200 % zoom and at 320 px wide without horizontal scrolling.
- Language: `<html lang="en">`.

See [`docs/accessibility.md`](../accessibility.md) for how this floor is checked (the automated axe-core scan and the keyboard walkthrough) and its last result.

## 11. Do and don't

Do:

- Lead each view with one primary element and let the rest recede.
- Show the basis of every savings figure (origin, left-out count, price date), in every state.
- Use tokens only; add a token here before using a new colour, size or radius.
- Keep live updates in place: same positions, tabular figures, no layout shift.
- Verify every change at 1440 and 390, light and dark, and check the empty, loading, error and unknown states.

Don't:

- Load a font, stylesheet, script, image or icon from anywhere but Tollwise itself.
- Show `$0` for a missing price, or hide the left-out count when it is not zero.
- Put the access key in a URL, cookie, `localStorage`, title or log.
- Use purple-to-blue or any other gradient, glass or blur effects, drop shadows, emoji as icons, or cards inside cards.
- Use cream backgrounds with serif type and terracotta, near-black with acid green or vermilion, or a newspaper hairline grid.
- Use green for anything but savings and the live state, or colour as the only difference between two states.
- Animate anything that did not just change, or loop an animation.
- Use placeholder text (lorem ipsum) or invented numbers in the product or in screenshots of it.

## 12. Savings view: charts

The Savings view shows how savings and spend moved over the selected range, and where the spend went. It keeps the shell of §5 (header, tabs, range bar, banners) and adds a "Savings" tab after "Overview"; the tab nav therefore appears as soon as this view ships (§5 hides it only while there is a single view). The view is reached by its tab link, `/dashboard#view=savings&range=1h`; the range in the fragment (§6.3) is shared by all views, so switching tabs keeps it. The view does not repeat the overview's display figure or meter. Reference mocks: `docs/design/mocks/charts-split.html` and `docs/design/mocks/screens/charts-split-*`.

All charts are hand-drawn SVG from one small shared helper (linear scales, "nice" ticks, axes, columns, a line, horizontal bars). No chart library, no canvas. Colours come only from classes in the stylesheet (for example `.chart-save { fill: var(--positive); }`), never from `style` attributes or colour attributes written into HTML; geometry (`x`, `y`, `width`, `height`, `d`) is set from script as SVG attributes, and bar widths in HTML through `element.style.width`.

### 12.1 Layout

```
[ 1 hour | 24 hours | 7 days | 30 days ]                          Last request 14:12:59
+-------------------------------------------------------------------------------------+
| Savings over the last hour                                            (h1, label)   |
| Saved per minute                                               $0.00459 in total     |
| 14:12 (in progress) · Saved $0.000181 · Spend $0.0214 · 227 requests    (readout)   |
| $0.0002 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -   |
|           savings columns, --positive, own scale                 ||||||||||||||     |
| $0      ------------------------------------------------------------------------   |
|           left-out strip (--warning) under buckets with requests left out          |
| Spend per minute                                                 $0.539 in total     |
| $0.04   - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -   |
|           spend line, --chart-spend, own scale              /‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾     |
| $0      ------------------------------------------------------------------------   |
|         13:20        13:30        13:40        13:50        14:00        14:10       |
| ■ Saved  ─ Spend  ▬ Some requests left out  ▨ Savings unknown (not $0)   (legend)   |
| (Usage N reported · M estimated) (N requests left out …) (Prices verified …)        |
| ----------------------------------------------------------------------------------- |
| Show the data as a table                                              (disclosure)  |
+-------------------------------------------------------------------------------------+
+-----------------------------------------+ +-----------------------------------------+
| Spend by provider                       | | Spend by model                          |
| openrouter    [#############]  $0.310 57%| | anthropic/claude-opus-5 [####] $0.301 56%|
| openai        [########     ]  $0.201 37%| | ...                                     |
| Lower bound: 1 request unpriced         | | llama3.2:latest  [- - - -] Unknown   —  |
| Show the data as a table                | | Show the data as a table                |
+-----------------------------------------+ +-----------------------------------------+
```

- **Primary block**: one card (`--surface`, 1 px `--line`, `--r-m`, padding 32; 16 at ≤ 720 px) holding two charts that share one time axis: **Saved per `<bucket>`** (columns) on top, **Spend per `<bucket>`** (a line) under it. Each chart has its own y scale. Together they are the view's one primary element (§1).
- **Why two scales**: real savings are often a small share of spend (0.84 % in the demo). On a shared axis, or stacked on spend, the saved amount is a line of pixels. Savings get their own chart so their shape over time is readable; the spend chart gives the context. The two are never drawn on one axis and never stacked.
- **Secondary blocks**: "Spend by provider" and "Spend by model", two cards side by side (2-column grid, gap 24) above 720 px, stacked (gap 16) at or below. They are separate cards, not rows of one card, because each carries its own table disclosure.

### 12.2 Data and buckets

- Savings and spend per bucket come from `GET /api/metrics/timeseries?range=&bucket=`; the totals and basis chips from `GET /api/metrics/summary?range=` (the request the overview already makes); the bars from `GET /api/metrics/breakdown?range=&by=provider` and `…&by=model`. The charts draw exactly what the API returns. They never compute a per-bucket baseline or percentage of their own (the timeseries has no per-bucket baseline, and spend plus savings is not a baseline when some requests are unpriced or left out).
- The page picks the bucket per range and width and always passes it explicitly:

| Range | Above 720 px | At or below 720 px |
|---|---|---|
| 1 hour | `1m` (61 columns) | `5m` (13) |
| 24 hours | `1h` (25) | `1h` (25) |
| 7 days | `1h` (169) | `1d` (8) |
| 30 days | `1d` (31) | `1d` (31) |

  Crossing the 720 px breakpoint refetches with the other bucket. Chart titles name the bucket: "Saved per minute", "per 5 minutes", "per hour", "per day (UTC)".
- The last bucket is still filling. It is drawn like the others; the readout and the table mark it "(in progress)".

### 12.3 Chart anatomy

Sizes: savings chart 200 px high (160 at ≤ 720 px), spend chart 124 px (104). Left gutter for y labels 72 px (56 at ≤ 720 px), right padding 8 px. The SVG `viewBox` width equals the rendered width in CSS pixels and is redrawn on resize, so text is never scaled.

- **Chart title** (14 px, 600, `--text`) on the left; the range total on the right (`small`, `--muted`): "$0.00459 in total", from the summary's `savings_usd` / `spend_usd` ("Unknown in total" when `unknown`).
- **Y axis**: no axis line. Three "nice" ticks for savings, two for spend (steps of 1, 2 or 5 × 10ⁿ, starting at `$0`); each is a 1 px `--line` gridline across the plot and a label right-aligned in the gutter (`small`, `--muted`, tabular). The zero line is 1 px `--control`. Tick labels use the fewest decimals the step needs, between 2 and 6 (`$0.0001`, `$0.02`, `$0.20`); zero is `$0`. If any bucket's savings are negative, the savings axis extends below zero with the same step.
- **X axis**: labels under the spend chart only (the two charts share it), `small`, `--muted`, centred on the bucket they name, in local time:

| Bucket | A label every | Format |
|---|---|---|
| `1m` | 10 minutes | `13:20` |
| `5m` | 15 minutes | `13:15` |
| `1h` in 24 hours | 3 hours (6 at ≤ 720 px) | `15:00` |
| `1h` in 7 days | day, at local midnight | `Sep 14` |
| `1d` in 7 days / 30 days | 2 days / 7 days | `Sep 14` |

  Axis ticks are the one place the short `Mon D` date form is allowed (en-US); the readout and the table use ISO dates (§6.9). Daily buckets are UTC days because the API aligns them to UTC; their labels are UTC dates, and the title says "(UTC)".
- **Savings columns**: one per bucket, `--positive` fill, square corners (no radius). Gap between columns: 2 px when a slot is at least 8 px wide, 1 px when 4–8 px, none below. A column's height is the bucket's `savings_usd`.
- **Spend line**: 2 px `--chart-spend` stroke, round joins and caps, through the centre of each bucket slot. No area fill and no markers, except a 3 px dot for every bucket with known spend whose neighbours on both sides have none (a line needs two points), so sparse traffic never vanishes from the chart.
- **Readout**: one line above the savings chart (`small`, `--muted`; values `--text` 600): "14:12 (in progress) · Saved $0.000181 · Spend $0.0214 · 227 requests". It shows the newest bucket with requests. On pointer hover over a bucket slot it shows that bucket, and a 1 px `--control` vertical rule marks the slot across both charts; leaving the chart restores the newest bucket. It is `aria-hidden="true"`: the table is the accessible route to the same values. Its height is fixed (one line; two lines reserved at ≤ 720 px) so hover and live updates never shift the layout.
- **Legend** under the charts (`small`, `--muted`), a swatch plus text for each: "Saved" (10 px `--positive` square), "Spend" (14 × 2 px `--chart-spend` line), "Some requests left out" (10 × 4 px `--warning` bar), "Savings unknown (not $0)" (10 px hatched square, as §12.4). The legend is the same in every state that shows charts; it does not change between refreshes.
- **Basis chips** under the legend, exactly as §6.4 item 5, from the summary. They are required because this view shows savings figures (§1, principle 2).

### 12.4 Unknown, zero and partial buckets

Each case has its own mark, so none can be mistaken for another, and none relies on colour alone: the shape differs, the legend names it and the table spells it out.

| Bucket | Savings chart | Spend chart | Table |
|---|---|---|---|
| No requests | Nothing drawn (empty slot) | Line breaks (a gap) | Requests `0`, Spend `—`, Saved `—` |
| Requests, savings exactly `$0.00` | 2 px `--muted` stub on the zero line | Point on the line | `$0.00` |
| Some requests left out (`unknown_savings_requests` > 0, `savings_usd` known) | Column of the known savings, plus a 4 px `--warning` mark just under the zero line in that slot (the left-out strip) | Point on the line | Saved value; the "Left out" column gives the count |
| All requests left out (`savings_usd` is `unknown`) | Full-height hatched band in the slot: 1 px `--warning` outline and 1.5 px `--warning` hatch lines at 45°, every 5 px (an SVG `<pattern>` defined once per chart) | Point on the line if spend is known | Saved "Unknown" in `--muted`; the "Left out" count |
| Spend `unknown` (no request in the bucket could be priced) | As the row above | Line breaks (a gap) | Spend "Unknown" in `--muted` |
| Negative savings | Column below the zero line in `--chart-spend` (never `--positive`) | Point on the line | Value with a leading minus |

A bucket with unknown savings is never drawn as a zero-height column, and the spend line never drops to `$0` where spend is unknown or where there were no requests.

### 12.5 Spend by provider and by model

- Card label (`<h2>`, `label`, `--muted`): "Spend by provider", "Spend by model".
- One row per group, in API order (known spend descending, unknown last). Row grid above 720 px: name (up to 190 px, wraps) · bar (flexible) · value (84 px, right aligned, 14 px 600, tabular) · share (44 px, right aligned, `small`, `--muted`); column gap 12, rows 12 apart.
- Names: provider ids in `--font`; model ids in `--font-mono` 13 px (§3), wrapping anywhere so a long id never overflows.
- Bar: 12 px high, square corners, a `--meter-track` track across the whole column with a `--chart-spend` fill; fill width = spend ÷ the largest known spend in the card. A known `$0.00` shows a 2 px `--muted` stub. Share = spend ÷ the sum of known spend in the card, whole percent ("0%" for `$0.00`).
- `unpriced_requests` > 0 with known spend: the value is a lower bound, and under the name, in `small` `--warning`: "Lower bound: N requests unpriced" ("1 request").
- `spend_usd` is `unknown`: no fill; the track becomes a 1 px dashed `--warning` outline with no background; the value is "Unknown" in `--muted`, weight 400; the share is "—"; under the name, in `small` `--warning`: "N requests, no catalog price".
- `unrouted_requests` > 0: a footnote under the rows (`small`, `--muted`): "N requests refused before routing are not in these bars." Omitted when 0.
- More than 8 groups: the first 8 rows, then a text button "Show all N" (`--accent`, at least 24 px high, 44 at ≤ 720 px) that reveals the rest in place and moves focus to the row list. The rows stay revealed across live refreshes of the same range; a range change, or the loading, empty or failed state, collapses them again. The table always lists every group.

### 12.6 Accessible alternative

- Each chart SVG has `role="img"` and an `aria-label` built from the data on every render, saying what it shows. Savings: "Savings per minute over the last hour, 61 bars. $0.00459 saved in total; highest $0.000184 in one minute. 1 request left out: savings unknown." Spend: "Spend per minute over the last hour. $0.539 in total; highest $0.0216 in one minute." Each breakdown's row list is `role="img"` with, for example, "Spend by provider over the last hour, 5 bars, highest first: openrouter $0.310, openai $0.201, anthropic $0.0201, and 2 more." Groups with unknown spend are counted as "N with unknown spend". Everything inside a `role="img"` element is presentational.
- Under each chart card's content: a native `<details>` whose `<summary>` reads "Show the data as a table" (`--accent`, 14 px, at least 24 px high, 44 at ≤ 720 px). Closed by default; one Tab stop; Enter or Space opens it. Inside, a real `<table>` with `<th scope="col">` headers, in a wrapper that scrolls horizontally when it must (`role="region"`, `aria-label` "<chart title>, as a table", `tabindex="0"`), so the page itself never scrolls sideways.
  - Savings and spend: Start (local `HH:MM`, or the ISO date for `1d`, or local `YYYY-MM-DD HH:MM` for `1h` buckets in 7 days so a time never repeats ambiguously; the readout uses the same form; "(in progress)" on the last row, kept on one line) · Requests · Spend · Saved · Left out. Every bucket is a row, including empty ones.
  - Breakdowns: Provider or Model · Requests · Spend · Unpriced.
  - Cells: 14 px (13 at ≤ 720 px), tabular, right aligned except the first column, 1 px `--line` row dividers, "Unknown" in `--muted`.
- A disclosure's open or closed state survives live refreshes; rows are updated in place.

### 12.7 States

| State | Primary block | Breakdown cards |
|---|---|---|
| Loading (first fetch) | Chart titles without totals; the gridlines of both charts and one `--skeleton` bar where the x labels go; `aria-busy="true"` and `aria-label` "Loading savings chart" | Label plus four `--skeleton` lines, 14 px high, 12 apart |
| Range change | Previous charts stay, dimmed to 60 % with `aria-busy="true"` (as §6.3), until the new data arrives | Same |
| Empty (`requests` is 0) | Only the h1 and the §8 empty sentence ("No requests in this range yet. Point your SDK's `base_url` at …"); no charts, legend, chips or table | "No requests in this range yet." (`body`, `--muted`) |
| Live | §12.1 | §12.5 |
| Partly unknown | Left-out marks and hatched bands (§12.4); the warning chip | Lower-bound notes; dashed unknown rows |
| Paused | Last data stays; §6.7 warning banner; "As of HH:MM:SS" | Same |
| Error (metrics API 5xx) | No card; the §6.7 error banner with the API's own message | No cards |
| One request fails (e.g. a breakdown fails, the timeseries loads) | What loaded is shown | The failed card shows "Could not load this breakdown." in `--danger` `small` in place of its rows; the next refresh retries |
| Long text | Totals and values never truncate | Model ids wrap anywhere |

### 12.8 Live updates and motion

- The view refreshes on the same batched live refresh as the overview (one refresh after a burst of `request` events). A refresh refetches the summary, the timeseries and both breakdowns for the current range; only the visible view fetches.
- Updates happen in place: same card sizes, same chart heights, tabular figures. The y scale is recomputed from the new data; tick values change without animation.
- The view's one signature moment: when a refresh changes the newest bucket, its savings column eases to the new height (200 ms, `ease-out`). Nothing else moves; breakdown bars and the spend line change instantly. Under `prefers-reduced-motion: reduce` the column changes instantly too.
- When a new bucket starts, the series shifts by one slot without animation.

### 12.9 At 390 px

- Coarser buckets (§12.2) keep every column at least about 4 px wide.
- Chart heights and the gutter shrink (§12.3); the x axis shows at most 5 labels.
- The readout may wrap to its reserved second line; legend items and chips wrap.
- Breakdown rows: name, value and share on the first line; the bar full width on a second line, 6 px below.
- Tables fit at 390 px with 8 px cell padding and 13 px text; long model ids wrap. Where a table still does not fit (320 px, 200 % zoom) its wrapper scrolls, never the page.

### 12.10 Do and don't for charts

Do:

- Give savings their own scale and label every axis value in dollars.
- Mark every bucket with requests left out (strip or hatched band), and keep the warning chip.
- Keep the table alternative complete: every bucket, every group, the same values as the charts.

Don't:

- Draw unknown savings or unknown spend as `$0`, as a zero-height column, or as a line dropping to zero.
- Stack savings on spend, put them on one axis, or chart a baseline or percentage the API did not return.
- Use a chart library, canvas, gradients, shadows, rounded bar ends, 3D, two y axes on one plot, or pie and donut charts.
- Use green for spend or for anything other than savings.
- Animate axes, gridlines, or the whole chart on load.

## 13. Routing view: recent requests and the routing trace

The Routing view answers two questions: where did the latest requests go, and why did any one of them go there. It keeps the shell of §5 and adds the "Routing" tab between "Overview" and "Savings"; with the Providers view (§14) the tabs read **Overview · Routing · Savings · Providers**. The view is reached by `/dashboard#view=routing&range=<range>`. Reference mocks: `docs/design/mocks/routing-drawer.html` and `docs/design/mocks/screens/routing-drawer-*`.

### 13.1 Layout

```
[mark Tollwise]  Overview  Routing  Savings  Providers                       (•) Live  [ Dark ]
Every recorded request, newest first                                      Last request 15:22:04
+----------------------------------------------------------------------------------------------+
| Recent requests                                                                (h1, label)   |
| Time     Requested       Routed to             Policy        Cost    Saved Latency Status    |
| 15:22:04 claude-opus-5   □■ openrouter         cheapest $0.000175    $0.00    3 ms ○ Complete|
|                          after 1 failure                          reported                   |
|                          anthropic/claude-opus-5                                             |
| 15:22:04 deepseek-v4-pro Not routed            cheapest   Unknown  Unknown  < 1 ms ■ Refused |
| ...                                                                                          |
| -------------------------------------------------------------------------------------------- |
| Showing 50 of the newest requests                                 ( Load 50 older requests ) |
+----------------------------------------------------------------------------------------------+

                                   drawer, 520 px, over a scrim:
                                   +----------------------------------------------------+
                                   | Request at 15:22:04                        (Close) |
                                   | 301f2116-fd3c-4755-bb26-ea1b2deb8e1e               |
                                   | Anthropic Messages · ○ Complete                    |
                                   | (Tools) (Streaming)                                |
                                   | Routed by the cheapest policy to openrouter, after |
                                   | anthropic failed (server error, HTTP 500).         |
                                   | [Requested claude-opus-5] → [1. anthropic, dashed] |
                                   |   → [2. openrouter, served]                        |
                                   | Cost and price source                              |
                                   | Candidates · Excluded · Attempts                   |
                                   +----------------------------------------------------+
```

- **Range bar.** The request log has no time range (`/api/requests` returns the newest requests whatever their age), so the range selector is not shown on this view. In its place, on the left: "Every recorded request, newest first" (14 px, `--muted`). The "as of" line on the right behaves as §6.1. The range stays in the URL fragment, so switching back to Overview or Savings keeps it.
- **Primary block**: one card (`--surface`, 1 px `--line`, `--r-m`, padding 24 / 24 / 16; 16 at ≤ 720 px) holding the h1 "Recent requests" (`label`, `--muted`), the table and the pager. There are no secondary blocks.
- **Detail**: a modal drawer (§13.4) over the page. It is not reflected in the URL.

### 13.2 Data

- First load: `GET /api/requests?limit=50`. Older pages: `GET /api/requests?limit=50&before=<nextCursor>` (§13.5). Live rows: the `request` events of `/api/events`, which have the same shape as an entry (§13.6).
- Each entry gives `requestId`, `timestamp`, `status`, `route` (`format`, `requestedModel`, `requestedProvider`, `usedModel`, `usedProvider`, `policy`, `decision`), `reason`, `cost_usd`, `savings_usd`, `trace` (the attempts), `substituted` (`true`, `false`, or `null` for a request stored before substitutions were recorded) and `substitution` (`requested_model`, `served_model`, `group` when `substituted` is `true`, otherwise `null`; see `docs/api.md`).
- The view also shows the fields below. They are stored with every request or known when it is routed, but `/api/requests` does not return them yet. The view reads them from each entry under these names once they are added, and until then shows each one's fallback. A fallback is never a guessed value.

| Field | Content | Fallback while absent |
|---|---|---|
| `latency_ms`, `first_byte_ms` | Total time; time to the first byte of a streamed response (`null` otherwise) | Latency cell "—"; no total line under Attempts |
| `origin` | `reported` or `estimated`: where the usage behind the cost came from | No origin under Saved; drawer usage row "Origin not recorded" |
| `baseline_usd` | What the requested model would have cost at its catalog price, or `unknown` | "Unknown" |
| `usage` | `input` and `output` token counts | Omitted from the usage row |
| `needs` | `tools`, `json_mode`, `vision`, `streaming` booleans | The needs chips are omitted |
| `price.used`, `price.requested` | For the model used and the model requested: `input` and `output` USD per 1M tokens, `verified_on` (ISO date), `source_url` | "No catalog price for this model" |
| `selection` | `considered` (a count), `candidates` (`provider`, `model`, in the policy's ranking order), `excluded` (`provider`, `model`, `reason` code) | The Candidates and Excluded sections say "Not recorded for this request." |

### 13.3 The table (above 720 px)

A real `<table>` with a visually hidden `<caption>` "Recent requests, newest first" and `<th scope="col">` headers (13 px, 600, `--muted`; left aligned, numeric columns right aligned). Rows: 14 px, `tabular-nums`, cell padding 8 / 12, top aligned, 1 px `--line` dividers. A hovered row gets a `--bg` background. A click anywhere on a row opens the drawer; the keyboard target is the Time button (§13.7).

| Column | Width | Content and formatting |
|---|---|---|
| Time | 88 px, no wrap | Local `HH:MM:SS` (§6.9) in a `<button>` styled as text (`--text`, underline on hover). Accessible name: "Open request at 15:22:04, claude-opus-5 to openrouter". The full ISO timestamp in `title` |
| Requested | flexible, min 160 px | `requestedModel`, `--font-mono` 13 px, wraps anywhere |
| Routed to | flexible, min 200 px | Line 1: the attempt pips (§13.3.1), then `usedProvider` (600), then, when `trace` has more than one attempt, "after 1 failure" / "after N failures" (12 px, `--warning`). Line 2: `usedModel` (`--font-mono` 13 px, `--muted`, wraps anywhere), followed, when `substituted` is `true`, by the **"Substituted" marker** (§13.3.3). A refused request (`usedProvider` `null`) shows "Not routed" in `--muted` |
| Policy | 96 px | `cheapest`, `fastest`, `balanced` or `pinned`, as in the configuration |
| Cost | 96 px, right | `cost_usd` per §6.9; `null` or `unknown` is "Unknown" in `--muted` |
| Saved | 104 px, right | `savings_usd` per §6.9: positive in `--positive`, 600; `$0.00` and negative values in `--text` (a negative value keeps its minus sign and is never green); `null` or `unknown` is "Unknown" in `--muted`. Line 2: the origin, "reported" or "estimated" (12 px, `--muted`); nothing for a refused request |
| Latency | 80 px, right | `latency_ms`: "< 1 ms" for 0, otherwise whole milliseconds with thousands separators ("1,204 ms") |
| Status | 140 px | Shape plus text (below); never colour alone |

Status (`status`):

| Value | Shape (8 px) | Text | Colour |
|---|---|---|---|
| `complete` | 1.5 px ring | "Complete" | `--muted` (success is the normal case and stays calm) |
| `provider_error` | filled square | "Provider error" | `--danger`, 600 |
| `translation_failed` | filled square | "Translation failed" | `--danger`, 600 |
| `refused` | filled square | "Refused" | `--danger`, 600 |
| `interrupted` | filled diamond (a square at 45°) | "Interrupted" | `--warning`, 600 |
| `client_aborted` | filled diamond | "Client closed" | `--warning`, 600 |

#### 13.3.1 Attempt pips

One 8 × 8 px square per entry in `trace`, in order, 3 px apart, before the provider name: a filled `--text` square for the attempt that served (`outcome` `ok`), a hollow square with a 1.5 px `--danger` outline for each failed attempt. They are `aria-hidden="true"`: the "after N failures" text and the row's accessible name carry the same fact. A refused request has no pips.

#### 13.3.2 Widths between 721 and 1023 px

The table keeps all eight columns at a minimum width of 940 px inside a wrapper that scrolls horizontally (`role="region"`, `aria-label` "Recent requests", `tabindex="0"`), so the page itself never scrolls sideways.

#### 13.3.3 The "Substituted" marker

Shown only when another model than the requested one served the request (`substituted` is `true`), which only an equivalence group turned on in the configuration allows. It is the §6.4 chip, compact inside a row: 12 px, weight 600, `--text`, `--r-full`, 1 px `--line` border, padding 0 / 8, 6 px after the served model, never wrapping inside itself. There is no new badge style and no colour of its own: the word carries the meaning. The requested model stays readable as text in the Requested column; the chip also holds visually hidden text, so its accessible name is "Substituted: requested gpt-5.6-luna, served deepseek-v4.1-flash" (the same text is its `title`). The row's accessible name (the Time button's, §13.3) ends with the same sentence: "Open request at 15:22:04, gpt-5.6-luna to deepseek. Substituted: requested gpt-5.6-luna, served deepseek-v4.1-flash". `false` and `null` show nothing in the table.

### 13.4 The request drawer

A modal dialog that shows one request's full routing trace.

- **Container**: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` its title. Fixed to the right edge, full height, 520 px wide (100 % at ≤ 720 px, where it is a full-screen sheet), `--surface`, 1 px `--line` left border (none at ≤ 720 px), padding 24 (16 at ≤ 720 px); it scrolls vertically on its own. Behind it, a full-page `--scrim`; the page under it does not scroll (`overflow: hidden` on the body) and is `inert`. No shadow (§4).
- **Head**, sticky at the top of the drawer while its content scrolls (`--surface` background; a 1 px `--line` bottom border once the content has scrolled under it):
  - Title (`<h2>`, 22 px, 700, -0.01em; 20 px at ≤ 720 px): "Request at 15:22:04".
  - A Close button on the right: the §6.2 pill, text "Close", accessible name "Close request details", 36 px high (44 at ≤ 720 px).
  - Meta (13 px, `--muted`): the `requestId` on its own line in `--font-mono` 12 px (selectable, for copying); then the wire format in words ("OpenAI Chat Completions" / "Anthropic Messages") and the status as in §13.3.
  - Needs chips (§6.4 chip style): one per need, in the order Tools, JSON mode, Images, Streaming; "No special capabilities" when there is none.
- **Sentence** (15 px, `--text`, max 64ch), composed from stored fields only, never from provider text:
  - `routed`, one attempt: "Routed by the **cheapest** policy to openrouter."
  - `routed`, with failed attempts: "Routed by the **cheapest** policy to openrouter, after anthropic failed (server error, HTTP 500)." Several failures are listed in order, separated by commas.
  - `passthrough`: "Passed through to `llama3.2:latest` on ollama: the catalog has no entry for this model, so there was nothing to route between." When `selection` shows entries that were all excluded: "Passed through to `<model>` on `<provider>`: every catalog entry for it was excluded (see Excluded), so the request went to the model it named."
  - `fail`: "Refused. No configured provider can serve `deepseek-v4-pro` with the capabilities this request uses, and routing is set to fail rather than pass it through."
- **Route strip** (the view's signature element): a horizontal `<ol aria-label="Route">` that wraps. First item: "Requested" (12 px, `--muted`) over the requested model (mono 13 px). Then one item per attempt: "1. anthropic" (12 px, `--muted`) over the result ("Server error · HTTP 500", 13 px). Items are separated by `→` in `--muted` (`aria-hidden="true"`). Each item: padding 6 / 10, `--r-s`. Borders: the requested item 1 px `--control`; a failed attempt 1 px **dashed** `--danger` with its result in `--danger` 600; the attempt that served 2 px solid `--text` with its result in 600. A refused request ends with a dashed item "No provider" over "Refused".
- **Sections**, in this order. Each has a 1 px `--line` top border with 16 px under it and 24 px above it; its title is an `<h3>` (14 px, 600) followed by a count or note (13 px, `--muted`).
  1. **Model substitution.** When `substituted` is `true`, the title is followed by the §13.3.3 chip, and a `<dl>` laid out like the Cost rows gives "Requested model" and "Served model" (both mono, wrapping anywhere) and "Equivalence group" (the group's name; a preset's name for a preset). Otherwise a note in 13 px `--muted`: "Same model as requested." when `substituted` is `false` and a provider was called; "No provider was called, so no model was substituted." for a refused request; "Not recorded for this request." when `substituted` is `null`.
  2. **Cost and price source.** A `<dl>`:
     - "Cost", "Requested model would have cost", "Saved": label on the left (14 px, `--muted`), value on the right (15 px, 600, `tabular-nums`), formatted as in §6.9 and §13.3 (Saved is green only when positive).
     - "Usage": "10 in · 5 out tokens, **reported** by the provider", or "…, **estimated** by Tollwise (the provider reported no usage)".
     - "Price of the model used" and "Price of the model requested": "$5.00 in · $25.00 out per 1M tokens, verified **2026-09-19**", then the `source_url` on its own line as a link (`--accent`, `--font-mono` 12 px, wraps anywhere, `target="_blank"`, `rel="noreferrer noopener"`, accessible name "Price source for <model>, opens in a new tab"). A model with no catalog price: "No catalog price for this model" in `--muted`, so a missing price is never read as `$0`.
     - A refused request shows only the note "No provider was called, so nothing was charged and there is no saving to report."
  3. **Candidates**, with the note "2 eligible of 2 considered · ranked by cheapest". An `<ol>`, one item per candidate: rank (600, `--muted`; `--text` for the one that served) · provider (600) and model (mono) · the catalog price "$5.00 in · $25.00 out" (13 px, `--muted`) · on its own line, the result when it was tried ("Server error · HTTP 500" in `--danger` 600, "Served · HTTP 200" in `--text` 600) or "Not tried" in `--muted`. No candidate: "No eligible candidate."
  4. **Excluded**, with the count as its note. A list, one item per excluded entry: provider (600) and model (mono); the reason in words (14 px, `--text`); under it the stable reason code (`--font-mono` 12 px, `--muted`). None: "No catalog entry was excluded." Reason texts:

     | Code | Text |
     |---|---|
     | `missing_capability:vision` | Does not accept images; this request has one |
     | `missing_capability:tools` | Does not support tool calls; this request uses them |
     | `missing_capability:json_mode` | Has no JSON mode; this request asks for it |
     | `missing_capability:streaming` | Cannot stream; this request streams |
     | `context_too_small` | Context window too small for this request |
     | `max_output_too_small` | Cannot produce the requested output length |
     | `provider_down` | Provider was down at the time |
     | `provider_not_configured` | Provider not configured (no key set) |
     | `provider_not_requested` | The request named another provider |
     | `untranslatable:<code>` | Speaks the other API format, which cannot carry `<code>` |

  5. **Attempts**, with the count as its note. An `<ol>`: number · provider and model · result (as in Candidates) · duration on the right (13 px, `--muted`, "< 1 ms" for 0). Then "Total 3 ms, first byte after 2 ms." (the first-byte part only for a streamed response). None: "No provider was called."
- Result words for an attempt `outcome`: `ok` Served, `server` Server error, `rate_limit` Rate limited, `overloaded` Overloaded, `timeout` Timed out, `connection` Connection failed, `auth` Key refused, `bad_request` Bad request, `unknown` Failed, `client_aborted` Client closed; followed by "· HTTP <status>" when `status` is not `null`.
- A request's record never changes once written, so the drawer's content is static while it is open; live rows keep arriving behind it (§13.6).
- Known limit of this version: the drawer shows one request at a time; to read another, close it and open the other row.

### 13.5 Pagination

- Under the table, after a 1 px `--line` divider: on the left "Showing N of the newest requests" (13 px, `--muted`; N includes live rows); on the right a button "Load 50 older requests" (pill, 1 px `--control` border, `--accent` text, 36 px high; full width and 44 px high at ≤ 720 px).
- Activating it fetches the next page with the latest `nextCursor` and appends its rows at the bottom; focus stays on the button. While loading, the button reads "Loading…" with `aria-disabled="true"`, and the table has `aria-busy="true"`. On failure: under the button, in `--danger` `small`, "Could not load older requests.", and the button reads "Try again".
- When `nextCursor` is `null`, the button is replaced by "That is every recorded request." (13 px, `--muted`).
- Rows are keyed by `requestId`: a request that arrives both live and in a page is shown once.

### 13.6 Live prepend and motion

- A `request` event adds its row at the top **directly** only when all of these hold: the table's header row is in the viewport, focus is not inside the table, and the drawer is closed. The new row's cells start with a `--highlight` background that fades to transparent over 1,200 ms (`ease-out`). This is the view's one signature moment.
- Otherwise the row waits, so nothing the user is reading moves. A pill button (`--accent` fill, `--on-accent` text, 14 px 600, `--r-full`, 32 px high; 44 at ≤ 720 px) says "1 new request · Show" or "N new requests · Show". It floats centred over the top edge of the table in a zero-height sticky container (`position: sticky; top: 16px`), so showing and hiding it never moves a row. Activating it inserts the waiting rows (without the fade), scrolls the table header into view and moves focus to the newest row's Time button. When the conditions above hold again (the user scrolls back up, closes the drawer, or tabs out of the table), the waiting rows are inserted by themselves and the button goes away.
- The button's text is in an `aria-live="polite"` region that is updated at most once every 5 seconds, so a burst is announced once. Rows inserted directly are not announced.
- The "as of" line updates with each event (§6.1). Nothing else moves. Under `prefers-reduced-motion: reduce` there is no fade.
- The drawer opens and closes instantly (no slide), like tab and theme changes (§9).

### 13.7 Keyboard and focus

- **Table**: one Tab stop. The Time buttons use a roving `tabindex` (the last focused row's button is `0`, all others `-1`; the newest row's at first). Up and Down move between rows; Home and End go to the first and the last loaded row; Enter or Space opens the drawer. Tab moves on to the pager.
- **Opening**: focus moves to the drawer title (`tabindex="-1"`), so a screen reader starts with "Request at 15:22:04, dialog". The header, tabs and main content behind it get `inert`.
- **Inside**: Tab and Shift+Tab cycle through the drawer's own controls (Close, the source links) and never leave it (focus trap).
- **Closing**: Escape, the Close button, or a click on the scrim. Focus returns to the Time button of the row that opened the drawer. That row keeps a 3 px `--accent` bar on its left edge and a `--bg` background until another row is opened, so the eye finds its place again.
- Everything is reachable without a pointer. Every target is at least 24 × 24 px, and 44 px high at ≤ 720 px (§10).

### 13.8 States

| State | What the user sees |
|---|---|
| Loading (first fetch) | The card, h1 and table header; eight rows of `--skeleton` bars (14 px high) in every cell; `aria-busy="true"` and `aria-label` "Loading requests"; no pager |
| Empty (`entries` is empty) | The h1 and the sentence "No requests yet. Point your SDK's `base_url` at `http://127.0.0.1:8484/v1` and send a request; it appears here as soon as it completes." (`body`, `--muted`; the address the page itself was served from). No table, no pager. The first live event replaces it with the table |
| Live | §13.1 |
| Rows waiting | The §13.6 button over the table |
| Paused | Rows stay; the §6.7 warning banner; "As of HH:MM:SS". On reconnect the first page is fetched again and merged by `requestId` |
| Error (`/api/requests` answers 5xx, e.g. analytics off) | No card; the §6.7 error banner with the lead-in "Requests unavailable." and the API's own message |
| Older page fails | The §13.5 message and "Try again"; rows already shown stay |
| Long text | Model ids wrap anywhere in the table and the drawer; amounts never truncate; the route strip wraps onto more lines |
| Unknown price | "Unknown" in `--muted` for Cost and Saved; the drawer says "No catalog price for this model" |
| Fields not returned yet | The §13.2 fallbacks |

### 13.9 At 390 px

- The table becomes a list (`<ul>`), one item per request, each a single full-width `<button>` (at least 44 px high, padding 12 / 0, 1 px `--line` between items) with three lines:
  1. Time (600) on the left; the status (§13.3) on the right.
  2. The requested model (mono) `→` the routed provider, then the attempt pips; "Not routed" in `--muted` when refused.
  - Only for a substituted request, a line between 2 and 3: the §13.3.3 chip, then "served deepseek-v4.1-flash" (mono 13 px, `--muted`, wraps anywhere). The item's accessible name ends with the §13.3.3 sentence.
  3. 13 px, `--muted`: "Cost $0.000175", "Saved $0.00 reported" (the amount formatted and coloured as in the table), and the latency.
- Each item's accessible name is the same as the Time button's above 720 px; the roving focus and arrow keys work the same way.
- The drawer is a full-screen sheet; its head stays at the top while the content scrolls; the route strip wraps.
- The pager button spans the full width.

### 13.10 Do and don't

Do:

- Show every attempt: a fallback is marked in the table (pips and "after N failures") and shown in full in the drawer.
- Show the price source URL and its verified date next to each price in the drawer, for the model used and for the model requested.
- Keep what is being read still: hold live rows while the user is scrolled down, focused in the table or reading the drawer.

Don't:

- Show a refused or unpriced request as `$0`, or colour a zero or negative saving green.
- Hide a failed attempt because the request completed in the end.
- Guess candidates or exclusions that were not recorded; say "Not recorded for this request."
- Show provider error text, request or response bodies, headers, or any URL other than the catalog's price source.

## 14. Providers view: latency and health

The Providers view shows, for each configured provider, whether it is answering and how fast. It keeps the §5 shell and adds the "Providers" tab last: `/dashboard#view=providers&range=<range>`. Reference mock: `docs/design/mocks/routing-drawer.html?view=providers` and `docs/design/mocks/screens/providers-*`.

### 14.1 Data

- `GET /api/health` on first load, then the `health` events of `/api/events` (one when the stream opens, then every 5 seconds) in the same shape: `providers`, keyed by provider id, each with `state` (`up`, `down`, `unknown`), `p50_ms` and `p95_ms` (whole milliseconds or `null`), `last_checked` (ISO timestamp or `null`), `samples` and `last_error_kind`.
- The latency window is the health monitor's last 100 samples per provider: its own health checks plus the requests routed to that provider. The view says so in one line and does not present the figures as belonging to a range: as in §13, the range selector is not shown on this view, and the left of the range bar reads "Latest health checks and routed requests".
- Rows appear in the order of the API object and never reorder on a live update, so a provider does not move while being read.

### 14.2 Layout

- One primary card (`--surface`, 1 px `--line`, `--r-m`, padding 32; 16 at ≤ 720 px):
  - The h1 "Providers" (`label`, `--muted`), followed by a summary (13 px, `--muted`): "5 configured · all up", or "5 configured · **1 down**" with the count in `--danger`, 600.
  - One line (14 px, `--muted`, max 70ch): "Latency is measured on the last 100 samples per provider: health checks and the requests routed to it."
  - A legend (13 px, `--muted`): a 10 px `--text` dot "p50 (median)"; a 16 × 6 px `--chart-spend` bar "p50 to p95"; a 2 × 12 px `--text` tick "p95". At ≤ 720 px it adds "Scale 0 to N ms".
  - One row per provider, a 1 px `--line` above each, padding 12 / 0, 14 px, `tabular-nums`. Grid above 720 px: name (130 px, 600) · state (200 px) · p50 (80 px, right) · p95 (80 px, right) · plot (flexible) · meta (200 px, right, 13 px, `--muted`).
  - A shared x axis under the rows, aligned with the plot column: 3 to 5 tick labels (12 px, `--muted`) from "0 ms" to the nice maximum (steps of 1, 2 or 5 × 10ⁿ, as §12.3) of every provider's p95.
  - A `<details>` "Show the data as a table", exactly as §12.6, with the columns Provider · State · p50 · p95 · Samples · Last checked · Last error.
- No secondary blocks.

### 14.3 Latency presentation

- Values: the prefixes "p50" and "p95" (12 px, `--muted`), then the value in `--text`: "< 1 ms" for 0; whole milliseconds with thousands separators; "—" for `null`.
- The plot (the view's signature element): a 16 px high track with a 1 px `--line` rule through its middle, on the shared linear scale; a 6 px high `--chart-spend` bar from p50 to p95; a 10 px `--text` dot at p50; a 2 × 12 px `--text` tick at p95. When p50 equals p95 the dot and the tick overlap, which is true. The plot is `aria-hidden="true"`: the p50 and p95 text and the table carry the values. A provider with no samples has no plot, only "No samples yet" in `--muted`.
- Never a pie, gauge, sparkline or colour scale for latency, and never green for "fast".

### 14.4 Health states

| `state` | Shape (8 px) | Text | Colour |
|---|---|---|---|
| `up` | filled circle | "Up" | `--text` (green stays reserved for savings and the live dot) |
| `down` | filled square | "Down · rate limited": the `last_error_kind` in words (rate limited, overloaded, server error, timed out, connection failed, key refused, bad request, failed) | `--danger`; "Down" in 600, the reason in 400 |
| `unknown` | 1.5 px ring | "Not checked yet" | `--muted` |

- Meta: "100 samples · checked 15:21:50" (local time); "First check pending" when `last_checked` is `null`.
- A provider that goes down stays in its place; only its state shape, text and colour change, with no animation.

### 14.5 States

| State | What the user sees |
|---|---|
| Loading | The card, h1 and legend; four placeholder rows with `--skeleton` bars for the values and the plot; `aria-busy="true"` and `aria-label` "Loading provider health" |
| Empty (`providers` is `{}`) | "No provider is being checked. A provider is checked once it is enabled and its key is set in the environment." (`body`, `--muted`) |
| Live | §14.2 |
| Some down | Their rows as §14.4; the summary count in `--danger` |
| Paused | The last snapshot stays; the §6.7 warning banner; "As of HH:MM:SS" |
| Error (`/api/health` fails) | The §6.7 error banner with the lead-in "Provider health unavailable." and "Retrying every 5 seconds." |
| Long text | Provider ids wrap; values never truncate |

### 14.6 Motion

When a snapshot changes a provider's p50 or p95, its dot, bar and tick ease to their new positions (200 ms, `ease-out`); the axis labels change without animation. This is the view's one signature moment. Numbers swap without animation. Under `prefers-reduced-motion: reduce` everything changes instantly.

### 14.7 At 390 px

- Each row stacks: line 1, the name (600) on the left and the state on the right; line 2, p50 on the left and p95 on the right; line 3, the plot at full width; line 4, the meta, left aligned.
- There is no shared axis; the legend states the scale ("Scale 0 to N ms").
- No horizontal scroll; the table disclosure's wrapper scrolls on its own when it must (§12.6).

### 14.8 Do and don't

Do:

- Say on the view where the latency comes from (the last 100 samples: health checks and routed requests).
- Keep provider rows in a stable order and update them in place.

Don't:

- Colour "Up" green, or rank providers by speed with colour.
- Show a latency for a provider with no samples, or "0 ms" for a sub-millisecond one (it is "< 1 ms").
- Show a provider's raw error message; only the normalised error kind, in words.
