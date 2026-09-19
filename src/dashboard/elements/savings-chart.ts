// <tw-savings-chart>: the Savings view's primary block (DESIGN.md §12.1-12.6). Two hand-drawn SVG charts
// sharing one time axis -- savings columns on their own scale, a spend line under them -- plus the
// readout line, legend, basis chips and a native <details> table alternative. Geometry (x, y, width,
// height, d) is set as SVG attributes from script; every colour comes from a stylesheet class, never a
// style attribute or a colour written into HTML (DESIGN.md §12; keeps the page's strict CSP).

import type { Summary } from '../api.ts';
import { bucketLayout } from '../charts/layout.ts';
import { formatAxisTick } from '../charts/scale.ts';
import { hatchPattern, svgEl, svgText } from '../charts/svg.ts';
import { type Readout, type SavingsChartView, spendGeometry } from '../charts/timeseries-model.ts';
import { h, replaceChildren, runs } from '../dom.ts';
import { type Chip, chipsOf } from '../overview-model.ts';

const HEADING_ID = 'savings-chart-heading';
const NARROW_QUERY = '(max-width: 720px)';
const SAVINGS_HATCH_ID = 'chart-hatch-savings';
const LEGEND_HATCH_ID = 'chart-hatch-legend';

function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function legendSwatchHatch(): SVGSVGElement {
  const svg = svgEl('svg', { class: 'swatch', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  svg.append(hatchPattern(LEGEND_HATCH_ID));
  svg.append(svgEl('rect', { x: 0.5, y: 0.5, width: 9, height: 9, class: 'chart-unknown-band-legend' }));
  return svg;
}

/** Where the plots' bucket slots sit, in CSS pixels from each plot's left edge. */
interface SlotGeometry {
  readonly left: number;
  readonly slot: number;
  readonly count: number;
}

/** The newest bucket's savings column as last drawn, so a refresh can ease it to its new height. */
interface NewestColumn {
  readonly start: number;
  readonly height: number;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function legendItem(swatch: Node, label: string): HTMLElement {
  return h('span', { class: 'legend-item' }, [swatch, label]);
}

export class SavingsChart extends HTMLElement {
  private readonly heading = h('h1', { id: HEADING_ID, class: 'label-text' });
  private readonly savingsTitleWord = h('span', {});
  private readonly savingsTitleTotal = h('span', { class: 'chart-total' });
  private readonly readout = h('p', { class: 'chart-readout', 'aria-hidden': 'true' });
  private readonly savingsPlot = h('div', { class: 'chart-plot' });
  private readonly spendTitleWord = h('span', {});
  private readonly spendTitleTotal = h('span', { class: 'chart-total' });
  private readonly spendPlot = h('div', { class: 'chart-plot' });
  private readonly legend = h('div', { class: 'chart-legend' });
  private readonly chips = h('div', { class: 'chips' });
  private readonly tableBody = h('tbody');
  private readonly tableWrap = h('div', { class: 'scroll-region', role: 'region', tabindex: '0' });
  private readonly disclosure = h('details', { class: 'data-disclosure' });

  private built = false;
  private view: SavingsChartView | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private geometry: SlotGeometry | undefined;
  private hoverIndex: number | undefined;
  private newestColumn: NewestColumn | undefined;

  connectedCallback(): void {
    this.classList.add('panel', 'chart-card');
    this.setAttribute('role', 'region');
    if (this.childElementCount === 0) this.showLoading('minute');
    this.resizeObserver = new ResizeObserver(() => {
      if (this.view !== undefined) this.drawCharts(this.view);
    });
    this.resizeObserver.observe(this);
    for (const plot of [this.savingsPlot, this.spendPlot]) {
      plot.addEventListener('pointermove', (event) => this.hover(plot, event));
      plot.addEventListener('pointerleave', () => this.hover(plot, undefined));
    }
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
  }

  /** Chart titles without totals; skeleton bars stand in for the plots (DESIGN.md §12.7). */
  showLoading(word: string): void {
    this.built = false;
    this.view = undefined;
    this.removeAttribute('aria-labelledby');
    this.setAttribute('aria-busy', 'true');
    this.setAttribute('aria-label', 'Loading savings chart');
    this.classList.remove('is-busy');
    replaceChildren(this, [
      h('div', { class: 'chart-title' }, [`Saved per ${word}`]),
      h('div', { class: 'skeleton chart-skeleton' }),
      h('div', { class: 'chart-title' }, [`Spend per ${word}`]),
      h('div', { class: 'skeleton chart-skeleton chart-skeleton-small' }),
    ]);
  }

  /** Dims the charts while a new range loads; they stay until the new ones arrive (DESIGN.md §6.3). */
  setBusy(busy: boolean): void {
    if (!this.built) return;
    this.toggleAttribute('aria-busy', busy);
    this.classList.toggle('is-busy', busy);
  }

  /** Only the h1 and the empty-range sentence; no charts, legend, chips or table (DESIGN.md §12.7). */
  showEmpty(heading: string, baseUrl: string): void {
    this.built = false;
    this.view = undefined;
    this.removeAttribute('aria-busy');
    this.removeAttribute('aria-label');
    this.setAttribute('aria-labelledby', HEADING_ID);
    this.heading.textContent = heading;
    replaceChildren(this, [
      this.heading,
      h('p', { class: 'lead' }, [
        "No requests in this range yet. Point your SDK's ",
        h('code', {}, ['base_url']),
        ' at ',
        h('code', {}, [baseUrl]),
        ' and send a request; it appears here as soon as it completes.',
      ]),
    ]);
  }

  /** The timeseries request failed while the range is not empty: keep the h1, drop the charts. */
  showFailed(heading: string): void {
    this.built = false;
    this.view = undefined;
    this.removeAttribute('aria-busy');
    this.removeAttribute('aria-label');
    this.setAttribute('aria-labelledby', HEADING_ID);
    this.heading.textContent = heading;
    replaceChildren(this, [this.heading, h('p', { class: 'chart-failed' }, ['Could not load this chart.'])]);
  }

  /** Draws `view`: two charts, the readout, legend, basis chips (from `summary`) and the data table. */
  show(heading: string, view: SavingsChartView, summary: Summary): void {
    if (!this.built) this.build();
    this.removeAttribute('aria-busy');
    this.classList.remove('is-busy');
    this.heading.textContent = heading;
    this.view = view;

    this.savingsTitleWord.textContent = `Saved per ${view.bucketWord}`;
    this.savingsTitleTotal.textContent = view.savingsTotalText;
    this.spendTitleWord.textContent = `Spend per ${view.bucketWord}`;
    this.spendTitleTotal.textContent = view.spendTotalText;

    this.renderReadout(view.readout);

    replaceChildren(
      this.chips,
      chipsOf(summary).map((chip: Chip) =>
        h('span', { class: chip.warning ? 'chip is-warning' : 'chip' }, runs(chip.runs)),
      ),
    );

    replaceChildren(
      this.tableBody,
      view.tableRows.map((row) =>
        h('tr', {}, [
          h('td', { class: row.inProgress ? 'nowrap' : undefined }, [
            row.inProgress ? `${row.start} (in progress)` : row.start,
          ]),
          h('td', {}, [row.requests]),
          h('td', { class: row.spend === undefined ? 'is-muted' : undefined }, [row.spend ?? '—']),
          h('td', { class: row.saved === undefined ? 'is-muted' : undefined }, [row.saved ?? '—']),
          h('td', {}, [row.leftOut]),
        ]),
      ),
    );
    this.tableWrap.setAttribute('aria-label', `Savings and spend per ${view.bucketWord}, as a table`);

    this.drawCharts(view);
  }

  private renderReadout(readout: Readout | undefined): void {
    replaceChildren(
      this.readout,
      readout === undefined
        ? []
        : [
            h('b', { class: 'readout-value' }, [readout.time]),
            readout.inProgress ? ' (in progress)' : '',
            ' · Saved ',
            h('b', { class: 'readout-value' }, [readout.saved.text]),
            ' · Spend ',
            h('b', { class: 'readout-value' }, [readout.spend.text]),
            ` · ${readout.requests} ${readout.requests === '1' ? 'request' : 'requests'}`,
          ],
    );
  }

  /** Pointer over a bucket slot: that bucket in the readout and a vertical rule across both charts. */
  private hover(plot: HTMLElement, event: PointerEvent | undefined): void {
    const view = this.view;
    const geometry = this.geometry;
    if (view === undefined || geometry === undefined) return;
    let index: number | undefined;
    if (event !== undefined) {
      const offset = event.clientX - plot.getBoundingClientRect().left - geometry.left;
      const candidate = Math.floor(offset / geometry.slot);
      if (offset >= 0 && candidate < geometry.count) index = candidate;
    }
    if (index === this.hoverIndex) return;
    this.applyHover(view, geometry, index);
  }

  /** Shows bucket `index` (or the default row when undefined) in the readout and moves the rule to it. */
  private applyHover(view: SavingsChartView, geometry: SlotGeometry, index: number | undefined): void {
    this.hoverIndex = index;
    this.renderReadout(index === undefined ? view.readout : view.readouts[index]);
    for (const rule of this.querySelectorAll<SVGLineElement>('.chart-hover-rule')) {
      if (index === undefined) {
        rule.classList.remove('is-shown');
        continue;
      }
      const x = geometry.left + (index + 0.5) * geometry.slot;
      rule.setAttribute('x1', String(x));
      rule.setAttribute('x2', String(x));
      rule.classList.add('is-shown');
    }
  }

  private drawCharts(view: SavingsChartView): void {
    const narrow = isNarrow();
    const savingsWidth = Math.max(280, Math.floor(this.savingsPlot.clientWidth) || this.clientWidth || 280);
    const spendWidth = Math.max(280, Math.floor(this.spendPlot.clientWidth) || this.clientWidth || 280);
    const savingsSvg = drawSavingsSvg(view, savingsWidth, narrow);
    replaceChildren(this.savingsPlot, [savingsSvg]);
    replaceChildren(this.spendPlot, [drawSpendSvg(view, spendWidth, narrow)]);
    const left = narrow ? LEFT_GUTTER_NARROW : LEFT_GUTTER;
    const count = Math.max(1, view.buckets.length);
    const geometry = { left, slot: Math.max(1, savingsWidth - left - RIGHT_PAD) / count, count: view.buckets.length };
    this.geometry = geometry;
    // A live refresh or resize replaces the SVGs: keep the pointer's bucket in the readout and the rule.
    const hovered = this.hoverIndex;
    this.applyHover(view, geometry, hovered !== undefined && hovered < geometry.count ? hovered : undefined);
    this.easeNewestColumn(view, savingsSvg);
  }

  /**
   * The view's one signature moment (DESIGN.md §12.8): when a refresh changes the newest bucket's
   * savings, its column eases from the old height to the new one (200 ms, ease-out). Instant under
   * reduced motion, on a new bucket, and for anything other than a positive column.
   */
  private easeNewestColumn(view: SavingsChartView, svg: SVGSVGElement): void {
    const newest = view.buckets.at(-1);
    const column = svg.querySelector<SVGRectElement>('.chart-save.is-newest');
    const previous = this.newestColumn;
    if (newest === undefined || column === null) {
      this.newestColumn = undefined;
      return;
    }
    const height = Number(column.getAttribute('height'));
    this.newestColumn = { start: newest.start.getTime(), height };
    if (
      previous === undefined ||
      previous.start !== newest.start.getTime() ||
      previous.height === height ||
      height <= 0 ||
      reducedMotion() ||
      typeof column.animate !== 'function'
    ) {
      return;
    }
    const from = Math.max(0, previous.height / height);
    column.animate([{ transform: `scaleY(${from})` }, { transform: 'scaleY(1)' }], {
      duration: 200,
      easing: 'ease-out',
    });
  }

  private build(): void {
    this.built = true;
    this.removeAttribute('aria-label');
    this.setAttribute('aria-labelledby', HEADING_ID);

    replaceChildren(this.legend, [
      legendItem(h('span', { class: 'swatch swatch-save', 'aria-hidden': 'true' }), 'Saved'),
      legendItem(h('span', { class: 'swatch swatch-spend-line', 'aria-hidden': 'true' }), 'Spend'),
      legendItem(h('span', { class: 'swatch swatch-left-out', 'aria-hidden': 'true' }), 'Some requests left out'),
      legendItem(legendSwatchHatch(), 'Savings unknown (not $0)'),
    ]);

    this.tableWrap.replaceChildren(
      h('table', {}, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { scope: 'col' }, ['Start']),
            h('th', { scope: 'col' }, ['Requests']),
            h('th', { scope: 'col' }, ['Spend']),
            h('th', { scope: 'col' }, ['Saved']),
            h('th', { scope: 'col' }, ['Left out']),
          ]),
        ]),
        this.tableBody,
      ]),
    );
    this.disclosure.replaceChildren(h('summary', {}, ['Show the data as a table']), this.tableWrap);

    replaceChildren(this, [
      this.heading,
      h('div', { class: 'chart-title' }, [this.savingsTitleWord, this.savingsTitleTotal]),
      this.readout,
      this.savingsPlot,
      h('div', { class: 'chart-title' }, [this.spendTitleWord, this.spendTitleTotal]),
      this.spendPlot,
      this.legend,
      this.chips,
      this.disclosure,
    ]);
  }
}

// ---------------------------------------------------------------- drawing (DESIGN.md §12.3)

const LEFT_GUTTER = 72;
const LEFT_GUTTER_NARROW = 56;
const RIGHT_PAD = 8;

function drawSavingsSvg(view: SavingsChartView, width: number, narrow: boolean): SVGSVGElement {
  const height = narrow ? 160 : 200;
  const left = narrow ? LEFT_GUTTER_NARROW : LEFT_GUTTER;
  const top = 8;
  const bottom = 10;
  const plotHeight = height - top - bottom;
  const ticks = view.savingsTicks;
  const span = ticks.max - ticks.min || 1;
  const yFor = (value: number): number => top + plotHeight - ((value - ticks.min) / span) * plotHeight;
  const zeroY = yFor(0);

  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': view.savingsAriaLabel,
  });
  svg.append(hatchPattern(SAVINGS_HATCH_ID));
  for (const tick of ticks.values) {
    const y = yFor(tick);
    svg.append(
      svgEl('line', {
        x1: left,
        x2: width - RIGHT_PAD,
        y1: y,
        y2: y,
        class: tick === 0 ? 'chart-zero-line' : 'chart-grid-line',
      }),
    );
    svg.append(svgText(left - 8, y + 4, formatAxisTick(tick, ticks.step), 'end'));
  }

  const layout = bucketLayout(Math.max(1, width - left - RIGHT_PAD), left, view.buckets.length);
  for (const bucket of view.buckets) {
    const x = layout.x(bucket.index);
    if (bucket.savings.kind === 'unknown') {
      svg.append(
        svgEl('rect', {
          x: x + 0.5,
          y: top + 0.5,
          width: Math.max(layout.barWidth - 1, 0),
          height: Math.max(plotHeight - 1, 0),
          class: 'chart-unknown-band',
        }),
      );
    } else if (bucket.savings.kind === 'zero') {
      svg.append(svgEl('rect', { x, y: zeroY - 2, width: layout.barWidth, height: 2, class: 'chart-zero-stub' }));
    } else if (bucket.savings.kind === 'value') {
      const amount = bucket.savings.amount;
      const barY = Math.min(zeroY, yFor(amount));
      const barHeight = Math.max(1, Math.abs(zeroY - yFor(amount)));
      svg.append(
        svgEl('rect', {
          x,
          y: barY,
          width: layout.barWidth,
          height: barHeight,
          class: amount < 0 ? 'chart-negative' : bucket.inProgress ? 'chart-save is-newest' : 'chart-save',
        }),
      );
    }
    if (bucket.leftOut) {
      svg.append(
        svgEl('rect', { x, y: zeroY + 3, width: Math.max(layout.barWidth, 3), height: 4, class: 'chart-left-out' }),
      );
    }
  }
  svg.append(hoverRule(top, top + plotHeight));
  return svg;
}

/** The 1 px vertical rule that marks the hovered bucket; hidden until a pointer is over a slot. */
function hoverRule(y1: number, y2: number): SVGLineElement {
  return svgEl('line', { x1: 0, x2: 0, y1, y2, class: 'chart-hover-rule' });
}

function drawSpendSvg(view: SavingsChartView, width: number, narrow: boolean): SVGSVGElement {
  const height = narrow ? 104 : 124;
  const left = narrow ? LEFT_GUTTER_NARROW : LEFT_GUTTER;
  const top = 8;
  const bottom = 26;
  const plotHeight = height - top - bottom;
  const ticks = view.spendTicks;
  const span = ticks.max || 1;
  const yFor = (value: number): number => top + plotHeight - (value / span) * plotHeight;

  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': view.spendAriaLabel,
  });
  for (const tick of ticks.values) {
    const y = yFor(tick);
    svg.append(
      svgEl('line', {
        x1: left,
        x2: width - RIGHT_PAD,
        y1: y,
        y2: y,
        class: tick === 0 ? 'chart-zero-line' : 'chart-grid-line',
      }),
    );
    svg.append(svgText(left - 8, y + 4, formatAxisTick(tick, ticks.step), 'end'));
  }

  const layout = bucketLayout(Math.max(1, width - left - RIGHT_PAD), left, view.buckets.length);
  const line = spendGeometry(view.buckets, (index) => layout.center(index), yFor);
  if (line.d !== '') svg.append(svgEl('path', { d: line.d, class: 'chart-spend-line' }));
  for (const point of line.dots) {
    svg.append(svgEl('circle', { cx: point.x, cy: point.y, r: 3, class: 'chart-spend-dot' }));
  }
  svg.append(hoverRule(top, top + plotHeight));
  for (const label of view.xLabels) {
    svg.append(svgText(layout.center(label.index), height - 6, label.text, 'middle'));
  }
  return svg;
}
