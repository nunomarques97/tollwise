// <tw-breakdown-card>: one "Spend by provider" / "Spend by model" card of the Savings view (DESIGN.md
// §12.5). Horizontal bars with value and share on every row, a "Show all N" disclosure past 8 rows, and
// a native <details> table alternative. Bar widths are set through element.style.width from script (the
// page's CSP forbids style attributes in HTML); colours come only from stylesheet classes.
import { keepExpanded, rowsToDraw } from '../charts/breakdown-model.js';
import { h, replaceChildren } from '../dom.js';
const TITLE_ID_PREFIX = 'breakdown-title-';
let instanceCount = 0;
function nextInstanceId() {
    instanceCount += 1;
    return instanceCount;
}
export class BreakdownCard extends HTMLElement {
    headingId = `${TITLE_ID_PREFIX}${nextInstanceId()}`;
    heading = h('h2', { id: this.headingId, class: 'kpi-label' });
    // Plain <div>s, not <ul>/<li>: role="img" replaces list semantics on its host element, so a nested
    // <li> would be an orphaned listitem with no list ancestor in the accessibility tree (an axe-core
    // "listitem" violation) -- the rows are presentational under this one role=img, exactly like the
    // hand-drawn SVG charts elsewhere on this page; the real accessible data is the table below (§12.6).
    // tabindex -1: "Show all N" moves focus here once it hides itself, so focus never drops to <body>.
    rows = h('div', { class: 'breakdown-rows', role: 'img', tabindex: '-1' });
    footnote = h('p', { class: 'breakdown-footnote', hidden: true });
    showAll = h('button', { type: 'button', class: 'text-button', hidden: true });
    tableBody = h('tbody');
    tableWrap = h('div', { class: 'scroll-region', role: 'region', tabindex: '0' });
    disclosure = h('details', { class: 'data-disclosure' });
    built = false;
    expanded = false;
    /** The range the drawn rows cover; undefined in the loading, empty and failed states. */
    shownRange;
    view;
    mono = false;
    keyLabel = 'Provider';
    connectedCallback() {
        this.classList.add('card', 'breakdown-card');
        this.setAttribute('aria-labelledby', this.headingId);
        if (this.childElementCount === 0)
            this.showLoading('Spend by provider');
        this.showAll.addEventListener('click', () => {
            if (this.view === undefined)
                return;
            this.expanded = true;
            this.renderRows(this.view);
            this.rows.focus();
        });
    }
    /** Drops the drawn rows: the next `show` starts collapsed. */
    reset() {
        this.built = false;
        this.expanded = false;
        this.shownRange = undefined;
        this.view = undefined;
    }
    showLoading(title) {
        this.reset();
        this.heading.textContent = title;
        replaceChildren(this, [
            this.heading,
            ...[0, 1, 2, 3].map(() => h('div', { class: 'skeleton breakdown-skeleton-line' })),
        ]);
    }
    showEmpty(title) {
        this.reset();
        this.heading.textContent = title;
        replaceChildren(this, [this.heading, h('p', { class: 'breakdown-empty' }, ['No requests in this range yet.'])]);
    }
    showFailed(title) {
        this.reset();
        this.heading.textContent = title;
        replaceChildren(this, [this.heading, h('p', { class: 'breakdown-failed' }, ['Could not load this breakdown.'])]);
    }
    /** `mono`: model ids render in the monospace font (DESIGN.md §12.5); provider ids do not. */
    show(title, view, options) {
        this.mono = options.mono;
        this.keyLabel = options.keyLabel;
        if (!this.built)
            this.build();
        this.heading.textContent = title;
        this.expanded = keepExpanded(this.expanded, this.shownRange, view.range);
        this.shownRange = view.range;
        this.view = view;
        this.renderRows(view);
        this.footnote.hidden = view.footnote === undefined;
        this.footnote.textContent = view.footnote ?? '';
        replaceChildren(this.tableBody, view.tableRows.map((row) => h('tr', {}, [
            h('td', { class: this.mono ? 'is-mono' : undefined }, [row.key]),
            h('td', {}, [row.requests]),
            h('td', { class: row.spend.unknown ? 'is-muted' : undefined }, [row.spend.text]),
            h('td', {}, [row.unpriced]),
        ])));
        this.tableWrap.setAttribute('aria-label', `${title}, as a table`);
    }
    renderRows(view) {
        this.rows.setAttribute('aria-label', view.ariaLabel);
        const visible = rowsToDraw(view, this.expanded);
        replaceChildren(this.rows, visible.map((row) => {
            const track = h('span', { class: 'breakdown-track', 'aria-hidden': 'true' });
            if (row.bar.kind === 'unknown') {
                track.classList.add('is-unknown');
            }
            else if (row.bar.percent === 0) {
                const fill = h('span', { class: 'breakdown-fill is-zero' });
                fill.style.width = '2px';
                track.append(fill);
            }
            else {
                const fill = h('span', { class: 'breakdown-fill' });
                fill.style.width = `${row.bar.percent}%`;
                track.append(fill);
            }
            return h('div', { class: 'breakdown-row' }, [
                h('span', { class: this.mono ? 'breakdown-name is-mono' : 'breakdown-name' }, [
                    row.key,
                    row.note === undefined
                        ? ''
                        : h('span', { class: row.noteIsWarning ? 'breakdown-note is-warning' : 'breakdown-note' }, [row.note]),
                ]),
                h('span', { class: 'breakdown-bar' }, [track]),
                h('span', { class: row.value.unknown ? 'breakdown-value is-muted' : 'breakdown-value' }, [row.value.text]),
                h('span', { class: 'breakdown-share' }, [row.share]),
            ]);
        }));
        this.showAll.hidden = this.expanded || view.hiddenCount === 0;
        this.showAll.textContent = `Show all ${view.rows.length}`;
    }
    build() {
        this.built = true;
        this.tableWrap.replaceChildren(h('table', {}, [
            h('thead', {}, [
                h('tr', {}, [
                    h('th', { scope: 'col' }, [this.keyLabel]),
                    h('th', { scope: 'col' }, ['Requests']),
                    h('th', { scope: 'col' }, ['Spend']),
                    h('th', { scope: 'col' }, ['Unpriced']),
                ]),
            ]),
            this.tableBody,
        ]));
        this.disclosure.replaceChildren(h('summary', {}, ['Show the data as a table']), this.tableWrap);
        replaceChildren(this, [this.heading, this.rows, this.footnote, this.showAll, this.disclosure]);
    }
}
