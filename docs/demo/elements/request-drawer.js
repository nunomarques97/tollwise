// <tw-request-drawer>: the modal dialog showing one request's full routing trace (DESIGN.md §13.4). Fixed
// to the right edge (a full-screen sheet at <= 720 px), over a scrim; a focus trap, Escape/scrim/Close to
// dismiss, focus returned to the row that opened it. The page behind it is `inert` while it is open.
import { h, replaceChildren } from '../dom.js';
import { formatClock, formatMs } from '../format.js';
import { attemptRows, candidateRows, costSection, excludedRows, needsChips, routeStrip, STATUS_INFO, sentenceRuns, substitutionSection, WIRE_FORMAT_TEXT, } from '../routing-model.js';
function renderRuns(runs) {
    return runs.map((run) => {
        if (run.strong === true)
            return h('b', {}, [run.text]);
        if (run.mono === true)
            return h('span', { class: 'is-mono' }, [run.text]);
        return document.createTextNode(run.text);
    });
}
const FOCUSABLE = 'button:not([disabled]), a[href]';
export class RequestDrawer extends HTMLElement {
    scrim = h('div', { class: 'drawer-scrim', 'aria-hidden': 'true' });
    panel = h('div', {
        class: 'drawer-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'drawer-title',
    });
    titleHeading = h('h2', { id: 'drawer-title', class: 'drawer-title', tabindex: '-1' });
    closeButton = h('button', { type: 'button', class: 'pill-button', 'aria-label': 'Close request details' }, ['Close']);
    body = h('div', { class: 'drawer-body' });
    opener;
    onCloseCallback;
    built = false;
    connectedCallback() {
        this.hidden = true;
        if (this.built)
            return;
        this.built = true;
        this.scrim.addEventListener('click', () => this.close());
        this.closeButton.addEventListener('click', () => this.close());
        this.panel.addEventListener('keydown', (event) => this.onKeydown(event));
        // The sticky head gets its bottom rule once the content has scrolled under it (§13.4).
        this.panel.addEventListener('scroll', () => this.markScrolled(), { passive: true });
        replaceChildren(this, [this.scrim, this.panel]);
    }
    /** Opens the drawer for `entry`; `opener` gets focus back when it closes. `onClose` fires once, after. */
    open(entry, opener, onClose) {
        this.opener = opener;
        this.onCloseCallback = onClose;
        this.render(entry);
        this.hidden = false;
        this.panel.scrollTop = 0;
        this.markScrolled();
        document.body.classList.add('drawer-locked');
        document.querySelector('.site-header')?.setAttribute('inert', '');
        document.getElementById('content')?.setAttribute('inert', '');
        this.titleHeading.focus();
    }
    close() {
        if (this.hidden)
            return;
        this.hidden = true;
        document.body.classList.remove('drawer-locked');
        document.querySelector('.site-header')?.removeAttribute('inert');
        document.getElementById('content')?.removeAttribute('inert');
        this.opener?.focus();
        this.opener = undefined;
        const callback = this.onCloseCallback;
        this.onCloseCallback = undefined;
        callback?.();
    }
    markScrolled() {
        this.body.querySelector('.drawer-head')?.classList.toggle('is-scrolled', this.panel.scrollTop > 0);
    }
    onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close();
            return;
        }
        if (event.key !== 'Tab')
            return;
        const focusable = [...this.panel.querySelectorAll(FOCUSABLE)];
        if (focusable.length === 0)
            return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
    render(entry) {
        this.titleHeading.textContent = `Request at ${formatClock(new Date(entry.timestamp))}`;
        const status = STATUS_INFO[entry.status];
        const needs = needsChips(entry.needs);
        const head = h('div', { class: 'drawer-head' }, [this.titleHeading, this.closeButton]);
        const meta = h('p', { class: 'drawer-meta' }, [
            h('span', { class: 'is-mono drawer-request-id' }, [entry.requestId]),
            h('br'),
            `${WIRE_FORMAT_TEXT[entry.route.format]} · `,
            h('span', { class: `status-cell tone-${status.tone}` }, [
                h('i', { class: `status-shape shape-${status.shape}`, 'aria-hidden': 'true' }),
                status.tone === 'muted' ? status.text : h('b', {}, [status.text]),
            ]),
        ]);
        const needsRow = h('p', { class: 'chips' }, needs.map((label) => h('span', { class: 'chip' }, [label])));
        const sentence = h('p', { class: 'drawer-sentence' }, renderRuns(sentenceRuns(entry)));
        const strip = this.renderStrip(entry);
        const substitution = this.renderSubstitution(entry);
        const cost = this.renderCost(entry);
        const candidates = this.renderCandidates(entry);
        const excluded = this.renderExcluded(entry);
        const attempts = this.renderAttempts(entry);
        replaceChildren(this.body, [
            head,
            meta,
            needsRow,
            sentence,
            strip,
            substitution,
            cost,
            candidates,
            excluded,
            attempts,
        ]);
        if (!this.panel.contains(this.body))
            this.panel.append(this.body);
    }
    renderStrip(entry) {
        const items = routeStrip(entry);
        const nodes = [];
        items.forEach((item, index) => {
            if (index > 0)
                nodes.push(h('li', { class: 'strip-sep', 'aria-hidden': 'true' }, ['→']));
            nodes.push(h('li', { class: `strip-item strip-${item.kind}` }, [
                h('span', { class: 'strip-label' }, [item.label]),
                h('span', { class: item.mono ? 'is-mono' : undefined }, [item.value]),
            ]));
        });
        return h('ol', { class: 'route-strip', 'aria-label': 'Route' }, nodes);
    }
    /** Which model served, when an equivalence group allowed another one than the requested (§13.4 item 1). */
    renderSubstitution(entry) {
        const section = substitutionSection(entry);
        const body = section.kind === 'substituted'
            ? h('dl', { class: 'kv-list' }, [
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Requested model']),
                    h('dd', { class: 'is-mono sub-model' }, [section.requestedModel]),
                ]),
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Served model']),
                    h('dd', { class: 'is-mono sub-model' }, [section.servedModel]),
                ]),
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Equivalence group']),
                    h('dd', { class: 'sub-model' }, [section.group]),
                ]),
            ])
            : h('p', { class: 'note' }, [section.note]);
        return h('section', { class: 'drawer-section' }, [
            h('h3', {}, [
                'Model substitution ',
                section.kind === 'substituted' ? h('span', { class: 'chip sub-chip' }, ['Substituted']) : '',
            ]),
            body,
        ]);
    }
    renderCost(entry) {
        const section = costSection(entry);
        const items = [];
        if (section.refused) {
            items.push(h('p', { class: 'note' }, ['No provider was called, so nothing was charged and there is no saving to report.']));
        }
        else {
            const savedClass = section.saved.amount.unknown
                ? 'is-muted'
                : section.saved.positive
                    ? 'is-positive-strong'
                    : undefined;
            items.push(h('dl', { class: 'kv-list' }, [
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Cost']),
                    h('dd', { class: section.cost.unknown ? 'is-muted' : undefined }, [section.cost.text]),
                ]),
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Requested model would have cost']),
                    h('dd', { class: section.baseline.unknown ? 'is-muted' : undefined }, [section.baseline.text]),
                ]),
                h('div', { class: 'kv-row' }, [
                    h('dt', {}, ['Saved']),
                    h('dd', { class: savedClass }, [section.saved.amount.text]),
                ]),
                section.usage === undefined
                    ? ''
                    : h('div', { class: 'kv-row is-stacked' }, [
                        h('dt', {}, ['Usage']),
                        h('dd', {}, [
                            section.usage.tokensText,
                            section.usage.originKnown ? h('b', {}, [section.usage.originText]) : section.usage.originText,
                        ]),
                    ]),
                this.priceRow('Price of the model used', section.usedPrice),
                this.priceRow('Price of the model requested', section.requestedPrice),
            ]));
        }
        return h('section', { class: 'drawer-section' }, [h('h3', {}, ['Cost and price source']), ...items]);
    }
    priceRow(label, price) {
        if (price === undefined) {
            return h('div', { class: 'kv-row is-stacked' }, [
                h('dt', {}, [label]),
                h('dd', { class: 'is-muted' }, ['No catalog price for this model']),
            ]);
        }
        return h('div', { class: 'kv-row is-stacked' }, [
            h('dt', {}, [label]),
            h('dd', {}, [
                `${price.text} per 1M tokens, verified `,
                h('b', { class: 'nowrap' }, [price.verifiedOn]),
                h('br'),
                price.sourceHref === undefined
                    ? h('span', { class: 'is-mono price-link is-muted' }, [price.sourceUrl])
                    : h('a', {
                        class: 'is-mono price-link',
                        href: price.sourceHref,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        'aria-label': price.linkLabel,
                    }, [price.sourceUrl]),
            ]),
        ]);
    }
    renderCandidates(entry) {
        const rows = candidateRows(entry);
        const note = entry.selection === null
            ? 'Not recorded for this request.'
            : `${rows.length} eligible of ${entry.selection.considered} considered · ranked by ${entry.route.policy}`;
        const body = entry.selection === null
            ? h('p', { class: 'note' }, ['Not recorded for this request.'])
            : rows.length === 0
                ? h('p', { class: 'note' }, ['No eligible candidate.'])
                : h('ol', { class: 'candidate-list' }, rows.map((row) => h('li', { class: row.served ? 'is-served' : undefined }, [
                    h('span', { class: 'rank' }, [String(row.rank)]),
                    h('span', { class: 'candidate-name' }, [
                        h('b', {}, [row.provider]),
                        ' ',
                        h('span', { class: 'is-mono' }, [row.model]),
                    ]),
                    h('span', { class: 'candidate-price is-muted' }, [
                        row.priceText ?? 'No catalog price for this model',
                    ]),
                    h('span', {
                        class: `candidate-result ${row.served ? 'res-ok' : row.resultText === undefined ? 'is-muted' : 'res-bad'}`,
                    }, [row.resultText ?? 'Not tried']),
                ])));
        return h('section', { class: 'drawer-section' }, [
            h('h3', {}, ['Candidates ', entry.selection === null ? '' : h('span', { class: 'section-note' }, [note])]),
            body,
        ]);
    }
    renderExcluded(entry) {
        const rows = excludedRows(entry);
        const body = entry.selection === null
            ? h('p', { class: 'note' }, ['Not recorded for this request.'])
            : rows.length === 0
                ? h('p', { class: 'note' }, ['No catalog entry was excluded.'])
                : h('ul', { class: 'excluded-list' }, rows.map((row) => h('li', {}, [
                    h('span', {}, [h('b', {}, [row.provider]), ' ', h('span', { class: 'is-mono' }, [row.model])]),
                    h('span', { class: 'excluded-why' }, [row.reasonText]),
                    h('code', { class: 'excluded-code' }, [row.reasonCode]),
                ])));
        return h('section', { class: 'drawer-section' }, [
            h('h3', {}, [
                'Excluded ',
                h('span', { class: 'section-note' }, [entry.selection === null ? '' : String(rows.length)]),
            ]),
            body,
        ]);
    }
    renderAttempts(entry) {
        const rows = attemptRows(entry);
        const total = rows.length === 0
            ? h('p', { class: 'note' }, ['No provider was called.'])
            : h('p', { class: 'note' }, [
                `Total ${formatMs(entry.latency_ms)}`,
                entry.first_byte_ms === null ? '' : `, first byte after ${formatMs(entry.first_byte_ms)}`,
                '.',
            ]);
        const list = rows.length === 0
            ? ''
            : h('ol', { class: 'attempt-list' }, rows.map((row) => h('li', {}, [
                h('span', { class: 'rank' }, [String(row.rank)]),
                h('span', {}, [h('b', {}, [row.provider]), ' ', h('span', { class: 'is-mono' }, [row.model])]),
                h('span', { class: row.failed ? 'res-bad' : 'res-ok' }, [row.resultText]),
                h('span', { class: 'attempt-duration is-muted' }, [row.durationText]),
            ])));
        return h('section', { class: 'drawer-section' }, [
            h('h3', {}, ['Attempts ', h('span', { class: 'section-note' }, [String(rows.length)])]),
            list,
            total,
        ]);
    }
}
