// <tw-range-selector>: the segmented control for the time range. One tab stop (roving tabindex); the
// arrow keys, Home and End move between the options and select them. Fires "range-change" with the
// new range in `detail`.
import { h } from '../dom.js';
import { DEFAULT_RANGE, RANGES, rangeAfterKey } from '../ranges.js';
export class RangeSelector extends HTMLElement {
    selected = DEFAULT_RANGE;
    buttons = new Map();
    connectedCallback() {
        if (this.buttons.size > 0)
            return;
        const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Time range' });
        for (const range of RANGES) {
            const button = h('button', { type: 'button' }, [range.label]);
            button.addEventListener('click', () => this.choose(range.id, false));
            button.addEventListener('keydown', (event) => {
                const next = rangeAfterKey(this.selected, event.key);
                if (next === undefined)
                    return;
                event.preventDefault();
                this.choose(next, true);
            });
            this.buttons.set(range.id, button);
            group.append(button);
        }
        this.append(group);
        this.render();
    }
    get value() {
        return this.selected;
    }
    /** Shows `range` as selected without firing an event (e.g. after the URL fragment changed). */
    set value(range) {
        this.selected = range;
        this.render();
    }
    choose(range, moveFocus) {
        const changed = range !== this.selected;
        this.selected = range;
        this.render();
        if (moveFocus)
            this.buttons.get(range)?.focus();
        if (changed)
            this.dispatchEvent(new CustomEvent('range-change', { detail: range, bubbles: true }));
    }
    render() {
        for (const [id, button] of this.buttons) {
            const pressed = id === this.selected;
            button.setAttribute('aria-pressed', String(pressed));
            button.tabIndex = pressed ? 0 : -1;
        }
    }
}
