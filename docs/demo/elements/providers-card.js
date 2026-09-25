// <tw-providers-card>: the Providers view's primary block (DESIGN.md §14). One row per configured
// provider, in a fixed order that never reorders on a live update; a shared latency plot (p50 to p95,
// with p50 and p95 marks) on one linear scale, and a native <details> table alternative.
//
// The card is built once; every later snapshot (a `health` event every 5 seconds) updates the rows in
// place, so the dot, bar and tick ease to their new positions (§14.6), the table disclosure keeps its
// open state and keyboard focus stays where it was.
import { h, replaceChildren } from '../dom.js';
import { buildProvidersView } from '../providers-model.js';
function stateChildren(row) {
    return [
        h('i', { class: `status-shape shape-${row.state.shape}`, 'aria-hidden': 'true' }),
        row.state.tone === 'danger' ? h('b', {}, [row.state.text]) : row.state.text,
        row.errorNote === undefined ? '' : ` · ${row.errorNote}`,
    ];
}
/** Sets a text node's content only when it changed, so an unchanged value is not touched. */
function setText(element, text) {
    if (element.textContent !== text)
        element.textContent = text;
}
/** The DOM of one provider row, kept across snapshots and updated in place. */
class ProviderRowNodes {
    item = h('li', { class: 'provider-row' });
    tableRow = h('tr');
    name = h('span', { class: 'provider-name' });
    state = h('span', { class: 'status-cell' });
    p50Value = h('span', { class: 'p-value' });
    p95Value = h('span', { class: 'p-value' });
    plot = h('span', { class: 'latency-plot', 'aria-hidden': 'true' });
    bar = h('span', { class: 'latency-bar' });
    dot = h('span', { class: 'latency-dot' });
    tick = h('span', { class: 'latency-tick' });
    noSamples = h('span', { class: 'latency-plot is-empty' }, [
        h('span', { class: 'is-muted' }, ['No samples yet']),
    ]);
    meta = h('span', { class: 'provider-meta is-muted' });
    cells = Array.from({ length: 7 }, () => h('td'));
    stateKey = '';
    constructor(id) {
        this.name.textContent = id;
        this.plot.append(h('span', { class: 'latency-rule' }), this.bar, this.dot, this.tick);
        this.item.append(this.name, this.state, h('span', { class: 'provider-p' }, [h('span', { class: 'p-label is-muted' }, ['p50']), ' ', this.p50Value]), h('span', { class: 'provider-p' }, [h('span', { class: 'p-label is-muted' }, ['p95']), ' ', this.p95Value]), this.noSamples, this.meta);
        this.tableRow.append(...this.cells);
    }
    update(row) {
        const stateKey = `${row.state.shape}|${row.state.tone}|${row.state.text}|${row.errorNote ?? ''}`;
        if (stateKey !== this.stateKey) {
            this.stateKey = stateKey;
            this.state.className = `status-cell tone-${row.state.tone}`;
            replaceChildren(this.state, stateChildren(row));
        }
        setText(this.p50Value, row.p50Text);
        setText(this.p95Value, row.p95Text);
        setText(this.meta, row.metaText);
        // Checked by parent, not isConnected: a new row is updated before its item is in the document.
        if (row.plot === undefined) {
            if (this.plot.parentNode !== null)
                this.plot.replaceWith(this.noSamples);
        }
        else {
            // Positions change on the same elements, so the CSS transition eases them (DESIGN.md §14.6).
            this.bar.style.left = `${row.plot.barLeftPercent}%`;
            this.bar.style.width = `${row.plot.barWidthPercent}%`;
            this.dot.style.left = `${row.plot.p50Percent}%`;
            this.tick.style.left = `${row.plot.p95Percent}%`;
            if (this.noSamples.parentNode !== null)
                this.noSamples.replaceWith(this.plot);
        }
        const values = [
            row.id,
            `${row.state.text}${row.errorNote === undefined ? '' : ` · ${row.errorNote}`}`,
            row.p50Text,
            row.p95Text,
            String(row.samples),
            row.lastCheckedText ?? '—',
            row.errorNote ?? '—',
        ];
        values.forEach((value, index) => {
            setText(this.cells[index], value);
        });
    }
}
export class ProvidersCard extends HTMLElement {
    heading = h('h1', { class: 'label-text' }, ['Providers']);
    summary = h('span', { class: 'providers-summary is-muted' });
    scale = h('span', { class: 'legend-scale' });
    list = h('ul', { class: 'providers-list' });
    axis = h('div', { class: 'providers-axis', 'aria-hidden': 'true' });
    tableBody = h('tbody');
    disclosure = h('details', { class: 'data-disclosure' }, [
        h('summary', {}, ['Show the data as a table']),
        h('div', { class: 'scroll-region', role: 'region', tabindex: '0', 'aria-label': 'Providers, as a table' }, [
            h('table', {}, [
                h('thead', {}, [
                    h('tr', {}, [
                        h('th', { scope: 'col' }, ['Provider']),
                        h('th', { scope: 'col' }, ['State']),
                        h('th', { scope: 'col' }, ['p50']),
                        h('th', { scope: 'col' }, ['p95']),
                        h('th', { scope: 'col' }, ['Samples']),
                        h('th', { scope: 'col' }, ['Last checked']),
                        h('th', { scope: 'col' }, ['Last error']),
                    ]),
                ]),
                this.tableBody,
            ]),
        ]),
    ]);
    content = [
        h('div', { class: 'phead' }, [this.heading, this.summary]),
        h('p', { class: 'providers-lead' }, [
            'Latency is measured on the last 100 samples per provider: health checks and the requests routed to it.',
        ]),
        h('div', { class: 'providers-legend', 'aria-hidden': 'true' }, [
            h('span', {}, [h('i', { class: 'legend-dot' }), 'p50 (median)']),
            h('span', {}, [h('i', { class: 'legend-bar' }), 'p50 to p95']),
            h('span', {}, [h('i', { class: 'legend-tick' }), 'p95']),
            this.scale,
        ]),
        this.list,
        this.axis,
        this.disclosure,
    ];
    /** Provider rows by id; a provider keeps its nodes for as long as it is configured. */
    rowNodes = new Map();
    summaryKey = '';
    axisKey = '';
    connectedCallback() {
        this.classList.add('card', 'providers-card');
        if (this.childElementCount === 0)
            this.showLoading();
    }
    showLoading() {
        replaceChildren(this, [
            h('div', { class: 'phead' }, [h('h1', { class: 'label-text' }, ['Providers'])]),
            h('div', { class: 'providers-body', 'aria-busy': 'true', 'aria-label': 'Loading provider health' }, [0, 1, 2, 3].map(() => h('div', { class: 'skeleton-row provider-skeleton-row' }, [h('span', { class: 'skeleton skeleton-cell' })]))),
        ]);
    }
    showEmpty() {
        replaceChildren(this, [
            h('div', { class: 'phead' }, [h('h1', { class: 'label-text' }, ['Providers'])]),
            h('p', { class: 'is-muted' }, [
                'No provider is being checked. A provider is checked once it is enabled and its key is set in the environment.',
            ]),
        ]);
    }
    /** Shows a snapshot; the first call builds the card, every later one updates it in place. */
    show(health) {
        const view = buildProvidersView(health);
        if (this.list.parentNode !== this)
            replaceChildren(this, this.content);
        const summaryKey = `${view.rows.length}|${view.downCount}`;
        if (summaryKey !== this.summaryKey) {
            this.summaryKey = summaryKey;
            replaceChildren(this.summary, [
                `${view.rows.length} configured · `,
                view.downCount === 0 ? 'all up' : h('b', { class: 'is-danger' }, [`${view.downCount} down`]),
            ]);
        }
        setText(this.scale, `Scale 0 to ${view.axisMaxText}`);
        const ids = new Set(view.rows.map((row) => row.id));
        for (const [id, nodes] of this.rowNodes) {
            if (ids.has(id))
                continue;
            nodes.item.remove();
            nodes.tableRow.remove();
            this.rowNodes.delete(id);
        }
        const ordered = [];
        for (const row of view.rows) {
            let nodes = this.rowNodes.get(row.id);
            if (nodes === undefined) {
                nodes = new ProviderRowNodes(row.id);
                this.rowNodes.set(row.id, nodes);
            }
            nodes.update(row);
            ordered.push(nodes);
        }
        // Rows keep their API order (§14.1); nodes are moved only when that order actually changed, which
        // happens only when a provider is added or removed.
        const inOrder = this.list.children.length === ordered.length &&
            ordered.every((nodes, index) => this.list.children[index] === nodes.item);
        if (!inOrder) {
            this.list.replaceChildren(...ordered.map((nodes) => nodes.item));
            this.tableBody.replaceChildren(...ordered.map((nodes) => nodes.tableRow));
        }
        // The axis labels change without animation (§14.6).
        const axisKey = view.axisTicks.map((tick) => `${tick.text}@${tick.percent}`).join('|');
        if (axisKey !== this.axisKey) {
            this.axisKey = axisKey;
            replaceChildren(this.axis, view.axisTicks.map((tick) => {
                const label = h('span', { class: 'axis-tick' }, [tick.text]);
                label.style.left = `${tick.percent}%`;
                return label;
            }));
        }
    }
}
