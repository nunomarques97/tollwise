# Accessibility

The dashboard targets WCAG 2.2 AA (see [`docs/design/DESIGN.md`](design/DESIGN.md#10-accessibility-floor-wcag-22-aa)
for the floor it is built to). This page is the evidence: how it is checked, the last real result,
and the keyboard walkthrough a script cannot fully automate.

## Automated check (`npm run verify:dashboard`)

`scripts/verify-dashboard.ts` starts the demo (`scripts/demo.ts`, five local mock providers, no
account, no real key) on an ephemeral port, waits until it has produced live traffic, then for every
dashboard view -- Overview, Routing, Savings, Providers -- at 1440x900 and 390x844, in dark and
light (16 combinations):

- saves a full-page screenshot, and
- runs an axe-core scan ([`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm)),
  tagged `wcag2a`, `wcag2aa`, `wcag22aa`.

It scans all 16 combinations, collects every violation they report and prints them all; then it
exits 1 if there was at least one violation, or if any part of the keyboard walkthrough below does
not hold.

```
npm run verify:dashboard -- [--out DIR]
```

`--out DIR` sets where screenshots are written; default `.tmp-dashboard/` (already `.gitignore`d).
The directory is created if it does not exist and is never emptied: the script only replaces its own
`<view>-<width>-<theme>.png` files (for example `overview-1440-dark.png`) and leaves every other file
in it alone.

### Last real result (2026-09-19)

```
verify-dashboard: accessibility scan (wcag2a, wcag2aa, wcag22aa): 0 violations

verify-dashboard: keyboard walkthrough
  first Tab stop is the skip link: true
  activating the skip link moves focus to <main>: true
  no stuck focus across 8 Tab presses: true
  every stop shows a visible focus outline: true

verify-dashboard: request drawer focus trap (DESIGN.md §13.4/§13.7)
  drawer opened on Enter: true
  Tab stayed inside the drawer for 10 presses: true
  Escape closed it: true
  focus returned to the row that opened it: true

verify-dashboard: PASSED
```

16 screenshots (one per view x width x theme) were written to `.tmp-dashboard/`; each was checked by
eye against [`DESIGN.md`](design/DESIGN.md) (tokens, spacing, the Meter direction, the 390 px grouped
layout) as well as by axe.

One violation was found and fixed by this check before this result: `<tw-breakdown-card>`'s row list
used `<ul role="img"><li>...</li></ul>` (DESIGN.md §12.5) for the "Spend by provider" / "Spend by
model" bars. `role="img"` on the `<ul>` replaces its list semantics in the accessibility tree, which
turns every `<li>` into a listitem with no list ancestor -- axe's `listitem` rule (serious impact).
Fixed in `src/dashboard/elements/breakdown-card.ts` by using plain `<div>`s instead of `<ul>`/`<li>`
for that presentational, role="img" row group; the real accessible data stays in the `<table>`
alternative underneath (unaffected, still a real `<table>`/`<tr>`/`<td>`). This matches how the
hand-drawn SVG charts elsewhere on the page are already presentational under their own `role="img"`.

## Keyboard walkthrough checklist

Everything below was walked by the script above (Playwright driving the system Chrome), against the
Overview view at 1440x900, light theme, with live demo data loaded -- not just read from the code.

| Check | How it was verified | Result |
|---|---|---|
| **Skip link is the first stop** | First `Tab` press from a blank focus; the focused element's accessible name must be "Skip to content". | Pass |
| **Skip link jumps to content** | Activate it with `Enter`; the next `document.activeElement` must be `<main id="content">`. | Pass |
| **Focus order: header -> tabs -> range -> content** | Recorded the accessible name of each of the next 7 Tab stops. | Pass -- observed order: Skip link, Overview, Routing, Savings, Providers, theme toggle, "1 hour" (the range selector's one roving tab stop); the 8th Tab press leaves the page, because the Overview view has no further focusable content, matching DESIGN.md §10. |
| **Visible focus on every stop** | For each of the 7 real stops, `getComputedStyle(el).outlineStyle !== 'none'` and a non-zero `outlineWidth` (the page's own rule is `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible`, DESIGN.md §10). | Pass, all 7 |
| **No unintended traps while tabbing the page** | The same 7-stop walk never re-focused the same element twice in a row. | Pass |
| **The one intentional trap (request drawer) behaves correctly** | Opened the drawer on a routing row with `Enter`; pressed `Tab` 10 times and confirmed `document.activeElement` stayed inside `<tw-request-drawer>` every time (the header and the page behind it are `inert` while it is open, DESIGN.md §13.4); pressed `Escape` and confirmed the drawer closed and focus returned to the row's own Time button. | Pass |

### What this does not cover

axe-core's `wcag2a`/`wcag2aa`/`wcag22aa` rule set already checks accessible names, roles, and ARIA
attribute validity on every element in the 16 screenshots above (rules such as `button-name`,
`link-name`, `aria-required-attr`), which is most of what a first screen-reader pass would also
catch. What neither axe nor this script can judge is whether the *reading order* and *wording* make
sense out loud -- that is a human judgement call, not automated here, and stays a manual check before
a release if a screen reader becomes available in this environment.
