// <tw-savings-block>: the overview's primary block. The saved amount for the range, the sentence that
// puts it against the baseline, the spend/saved meter and the chips that give the figure's basis. Built
// once and then updated in place, so a live update changes numbers without moving anything.

import { h, prefersReducedMotion, replaceChildren, runs } from '../dom.ts';
import { type SavingsView, spokenValue } from '../overview-model.ts';

const HEADING_ID = 'savings-heading';

export class SavingsBlock extends HTMLElement {
  private readonly heading = h('h1', { id: HEADING_ID, class: 'label-text' });
  private readonly figure = h('p', { class: 'display-figure' });
  private readonly figureShown = h('span', { 'aria-hidden': 'true' });
  private readonly figureSpoken = h('span', { class: 'visually-hidden' });
  private readonly lead = h('p', { class: 'lead' });
  private readonly meter = h('div', { class: 'meter' });
  private readonly track = h('div', { class: 'meter-track', role: 'img' });
  private readonly spend = h('span', { class: 'meter-spend' });
  private readonly saved = h('span', { class: 'meter-saved' });
  private readonly legendSaved = h('span', { class: 'legend-text' });
  private readonly chips = h('div', { class: 'chips' });
  private readonly substitution = h('p', { class: 'substitution-line' });
  private built = false;

  connectedCallback(): void {
    this.classList.add('panel', 'savings');
    this.setAttribute('role', 'region');
    if (this.childElementCount === 0) this.showLoading();
  }

  /** Placeholders at the size of the text they stand for; no shimmer. */
  showLoading(): void {
    this.built = false;
    this.removeAttribute('aria-labelledby');
    this.setAttribute('aria-busy', 'true');
    this.setAttribute('aria-label', 'Loading summary');
    this.classList.remove('is-busy');
    replaceChildren(this, [
      h('div', { class: 'skeleton skeleton-label' }),
      h('div', { class: 'skeleton skeleton-display' }),
      h('div', { class: 'skeleton skeleton-lead' }),
      h('div', { class: 'skeleton skeleton-meter' }),
    ]);
  }

  /** Dims the figures while a new range loads; they stay until the new ones arrive. */
  setBusy(busy: boolean): void {
    if (!this.built) return;
    this.toggleAttribute('aria-busy', busy);
    this.classList.toggle('is-busy', busy);
  }

  /** Shows `view`; `animate` eases the meter to its new widths (live updates only). */
  show(heading: string, view: SavingsView, animate: boolean): void {
    if (!this.built) this.build();
    this.removeAttribute('aria-busy');
    this.classList.remove('is-busy');

    this.heading.textContent = heading;

    this.figure.classList.toggle('is-muted', view.figureMuted);
    this.figureShown.textContent = view.figure.text;
    this.figureSpoken.textContent = spokenValue(view.figure);
    if (view.figure.exact === undefined) this.figure.removeAttribute('title');
    else this.figure.title = view.figure.exact;

    const lead = view.lead;
    if (lead.kind === 'percent') {
      replaceChildren(this.lead, [
        h('b', { class: lead.positive ? 'is-positive' : undefined }, [lead.percent]),
        lead.rest,
      ]);
    } else if (lead.kind === 'text') {
      replaceChildren(this.lead, [lead.text]);
    } else {
      replaceChildren(this.lead, [
        "No requests in this range yet. Point your SDK's ",
        h('code', {}, ['base_url']),
        ' at ',
        h('code', {}, [lead.baseUrl]),
        ' and send a request; it appears here as soon as it completes.',
      ]);
    }

    const meter = view.meter;
    this.meter.hidden = meter === undefined;
    if (meter !== undefined) {
      this.meter.classList.toggle('is-animated', animate && !prefersReducedMotion());
      this.track.setAttribute('aria-label', meter.label);
      this.spend.style.width = `${meter.spendPercent}%`;
      this.saved.style.width = `${meter.savedPercent}%`;
      this.saved.hidden = meter.savedPercent === 0;
      this.legendSaved.textContent = meter.baselineLegend;
    }

    this.chips.hidden = view.chips.length === 0;
    replaceChildren(
      this.chips,
      view.chips.map((chip) => h('span', { class: chip.warning ? 'chip is-warning' : 'chip' }, runs(chip.runs))),
    );

    this.substitution.hidden = view.substitution === undefined;
    replaceChildren(this.substitution, view.substitution === undefined ? [] : runs(view.substitution));
  }

  private build(): void {
    this.built = true;
    this.removeAttribute('aria-label');
    this.setAttribute('aria-labelledby', HEADING_ID);
    this.figure.replaceChildren(this.figureShown, this.figureSpoken);
    this.track.replaceChildren(this.spend, this.saved);
    this.meter.replaceChildren(
      this.track,
      h('div', { class: 'meter-legend' }, [
        h('span', { class: 'legend-item' }, [
          h('span', { class: 'swatch swatch-spend', 'aria-hidden': 'true' }),
          'Spend',
        ]),
        h('span', { class: 'legend-item' }, [
          h('span', { class: 'swatch swatch-saved', 'aria-hidden': 'true' }),
          this.legendSaved,
        ]),
      ]),
    );
    replaceChildren(this, [this.heading, this.figure, this.lead, this.meter, this.chips, this.substitution]);
  }
}
