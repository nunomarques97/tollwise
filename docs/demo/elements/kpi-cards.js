// <tw-kpi-cards>: the overview's secondary blocks, Requests, Spend and Baseline. Three cards side by side;
// at 720 px and below the stylesheet merges them into one grouped list (one surface, rows with
// dividers), never cards inside a card. Updated in place like the savings block.
import { h } from '../dom.js';
import { spokenValue } from '../overview-model.js';
export class KpiCards extends HTMLElement {
    parts = [];
    connectedCallback() {
        this.classList.add('kpi-grid');
        if (this.childElementCount === 0)
            this.showLoading();
    }
    showLoading() {
        this.parts = [];
        this.classList.remove('is-busy');
        this.replaceChildren(...[0, 1, 2].map(() => h('div', { class: 'kpi-card', 'aria-hidden': 'true' }, [
            h('div', { class: 'skeleton skeleton-card-label' }),
            h('div', { class: 'skeleton skeleton-card-value' }),
        ])));
    }
    setBusy(busy) {
        if (this.parts.length === 0)
            return;
        this.classList.toggle('is-busy', busy);
    }
    show(cards) {
        if (this.parts.length !== cards.length)
            this.build(cards.length);
        this.classList.remove('is-busy');
        cards.forEach((card, index) => {
            const part = this.parts[index];
            if (part === undefined)
                return;
            part.label.textContent = card.label;
            part.shown.textContent = card.value.text;
            part.spoken.textContent = spokenValue(card.value);
            part.value.classList.toggle('is-muted', card.value.unknown);
            if (card.value.exact === undefined)
                part.value.removeAttribute('title');
            else
                part.value.title = card.value.exact;
            part.note.textContent = card.note;
        });
    }
    build(count) {
        this.parts = Array.from({ length: count }, () => {
            const label = h('h2', { class: 'kpi-label' });
            const shown = h('span', { 'aria-hidden': 'true' });
            const spoken = h('span', { class: 'visually-hidden' });
            const value = h('p', { class: 'kpi-value' }, [shown, spoken]);
            const note = h('p', { class: 'kpi-note' });
            const root = h('div', { class: 'kpi-card' }, [label, value, note]);
            return { root, label, value, shown, spoken, note };
        });
        this.replaceChildren(...this.parts.map((part) => part.root));
    }
}
