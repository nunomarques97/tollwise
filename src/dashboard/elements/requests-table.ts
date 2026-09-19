// <tw-requests-table>: the Routing view's primary block (DESIGN.md §13). A real <table> above 720 px, a
// list of buttons below it (§13.9); one roving tab stop over the Time buttons (Up/Down/Home/End, Enter or
// Space opens the drawer; a click anywhere on a row does too); live rows arrive at the top directly, or
// wait behind a "N new requests" button when the table is scrolled, focused or the drawer is open (§13.6);
// a pager loads older pages. Rows are keyed by requestId everywhere, so no request is shown twice.

import { h, prefersReducedMotion, replaceChildren } from '../dom.ts';
import {
  announceDelay,
  type RoutedToView,
  type SavedCell,
  type StatusInfo,
  type SubstitutionMark,
  shouldPrependLive,
  type TableRow,
  unseenRows,
} from '../routing-model.ts';

function pipsOf(routed: RoutedToView): HTMLElement | undefined {
  if (routed.pips.length === 0) return undefined;
  return h(
    'span',
    { class: 'pips', 'aria-hidden': 'true' },
    routed.pips.map((pip) => h('i', { class: pip.ok ? 'pip is-ok' : 'pip is-failed' })),
  );
}

/**
 * The "Substituted" chip (DESIGN.md §13.3): the word is shown; the requested and served models follow it
 * as visually hidden text, so its accessible name is "Substituted: requested X, served Y".
 */
function substitutionChip(mark: SubstitutionMark): HTMLElement {
  return h('span', { class: 'chip sub-chip', title: mark.label }, [
    'Substituted',
    h('span', { class: 'visually-hidden' }, [`: requested ${mark.requestedModel}, served ${mark.servedModel}`]),
  ]);
}

function routedCell(routed: RoutedToView, mark: SubstitutionMark | undefined): HTMLElement[] {
  if (routed.notRouted) return [h('span', { class: 'is-muted' }, ['Not routed'])];
  return [
    h('span', { class: 'routed-line1' }, [
      pipsOf(routed),
      h('b', {}, [routed.provider ?? '']),
      routed.afterFailures === undefined ? '' : h('span', { class: 'after-note' }, [` ${routed.afterFailures}`]),
    ]),
    h('span', { class: 'routed-line2' }, [
      h('span', { class: 'is-mono is-muted' }, [routed.model ?? '']),
      mark === undefined ? '' : substitutionChip(mark),
    ]),
  ];
}

function savedCellNodes(saved: SavedCell): HTMLElement[] {
  const amount = h(
    'span',
    { class: saved.amount.unknown ? 'is-muted' : saved.positive ? 'is-positive-strong' : undefined },
    [saved.amount.text],
  );
  if (saved.originText === undefined) return [amount];
  return [amount, h('span', { class: 'saved-origin is-muted' }, [saved.originText])];
}

function statusNode(status: StatusInfo): HTMLElement {
  return h('span', { class: `status-cell tone-${status.tone}` }, [
    h('i', { class: `status-shape shape-${status.shape}`, 'aria-hidden': 'true' }),
    status.tone === 'muted' ? status.text : h('b', {}, [status.text]),
  ]);
}

export class RequestsTable extends HTMLElement {
  private readonly heading = h('h1', { class: 'label-text' }, ['Recent requests']);
  private readonly liveRegion = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  private readonly newBar = h('div', { class: 'new-bar', hidden: true });
  private readonly newButton = h('button', { type: 'button', class: 'pill-button is-accent' });
  private readonly body = h('div', { class: 'requests-body' });
  private readonly count = h('span', { class: 'pager-count' });
  private readonly pagerButton = h('button', { type: 'button', class: 'pill-button' }, ['Load 50 older requests']);
  private readonly pagerError = h('p', { class: 'pager-error', hidden: true }, ['Could not load older requests.']);
  private readonly pagerEnd = h('span', { class: 'is-muted pager-end', tabindex: '-1', hidden: true }, [
    'That is every recorded request.',
  ]);
  private readonly pager = h('div', { class: 'pager', hidden: true }, [
    h('div', { class: 'pager-divider' }),
    this.count,
    this.pagerButton,
    this.pagerError,
    this.pagerEnd,
  ]);

  private rows: TableRow[] = [];
  private pending: TableRow[] = [];
  private nextCursor: string | null = null;
  private narrow = false;
  private drawerOpen = false;
  private lastOpenedId: string | undefined;
  private readonly freshIds = new Set<string>();
  private tabbableId: string | undefined;
  private built = false;
  private pagerBusy = false;
  /** When the "N new requests" live region last changed, and the pending update of it (§13.6). */
  private lastAnnouncedAt: number | undefined;
  private announceTimer: number | undefined;

  connectedCallback(): void {
    this.classList.add('card', 'requests-card');
    if (this.built) return;
    this.built = true;
    this.newButton.addEventListener('click', () => this.flushPending(true));
    this.pagerButton.addEventListener('click', () => {
      if (this.pagerBusy) return;
      this.dispatchEvent(new CustomEvent('load-older', { bubbles: true }));
    });
    this.newBar.append(this.newButton);
    // A click anywhere on a row opens the drawer (§13.3); the row's Time button is the keyboard target and
    // gets focus back when the drawer closes. A click that ends a text selection (copying a model id) does not.
    this.body.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.request-row');
      if (row === null) return;
      const button = row.querySelector<HTMLButtonElement>('.time-button');
      const requestId = button?.dataset.requestId;
      if (button === null || requestId === undefined) return;
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
      this.open(requestId, button);
    });
    this.body.addEventListener('keydown', (event) => this.onKeydown(event));
    window.addEventListener('scroll', () => this.notifyConditionsChanged(), { passive: true });
    document.addEventListener('focusout', () => window.setTimeout(() => this.notifyConditionsChanged(), 0));
    replaceChildren(this, [this.heading, this.liveRegion, this.newBar, this.body, this.pager]);
  }

  private open(requestId: string, opener: HTMLElement): void {
    this.lastOpenedId = requestId;
    this.setTabbable(requestId);
    this.refreshRowClasses();
    this.dispatchEvent(
      new CustomEvent<{ requestId: string; opener: HTMLElement }>('open-request', {
        detail: { requestId, opener },
        bubbles: true,
      }),
    );
  }

  private onKeydown(event: KeyboardEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.time-button');
    if (button === null) return;
    const ids = this.rows.map((row) => row.requestId);
    const index = ids.indexOf(button.dataset.requestId ?? '');
    if (index === -1) return;
    let next = -1;
    if (event.key === 'ArrowDown') next = Math.min(ids.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    else return;
    event.preventDefault();
    this.focusRequest(ids[next] as string);
  }

  /** Whether focus is currently on one of the table's own controls (DESIGN.md §13.6). */
  private focusInside(): boolean {
    return this.contains(document.activeElement);
  }

  /** Whether the table's own header row/heading is within the viewport (a rough, cheap check). */
  private headerInView(): boolean {
    const rect = this.getBoundingClientRect();
    return rect.top >= 0 && rect.top < (window.innerHeight || 0);
  }

  setDrawerOpen(open: boolean): void {
    this.drawerOpen = open;
    if (!open) this.tryFlushPending();
  }

  /** Called when the user scrolls or tabs away, in case waiting rows can now be shown directly. */
  notifyConditionsChanged(): void {
    this.tryFlushPending();
  }

  private tryFlushPending(): void {
    if (this.pending.length === 0) return;
    if (
      shouldPrependLive({
        headerInView: this.headerInView(),
        focusInsideTable: this.focusInside(),
        drawerOpen: this.drawerOpen,
      })
    ) {
      this.flushPending(false);
    }
  }

  /**
   * Inserts the waiting rows at the top. Inserted by themselves they get the highlight fade; through the
   * "Show" button they come in without it, the table header is scrolled into view and focus moves to the
   * newest row's Time button (§13.6).
   */
  private flushPending(fromShowButton: boolean): void {
    if (this.pending.length === 0) return;
    const arrived = unseenRows(this.pending, this.rows);
    this.pending = [];
    this.newBar.hidden = true;
    this.announce();
    if (arrived.length === 0) return;
    this.rows = [...arrived, ...this.rows];
    const fade = !fromShowButton && !prefersReducedMotion();
    if (fade) for (const row of arrived) this.freshIds.add(row.requestId);
    this.insertRows(arrived, 'top');
    this.renderPager();
    const newest = arrived[0]?.requestId;
    if (fromShowButton && newest !== undefined) {
      this.heading.scrollIntoView({ block: 'nearest' });
      this.focusRequest(newest);
    }
    if (fade) {
      // The rows are painted with the highlight first; then the class is dropped from the rows already on
      // the page (never a re-render, which would destroy a focused button) and the CSS transition fades it.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          for (const row of arrived) {
            this.freshIds.delete(row.requestId);
            this.rowElement(row.requestId)?.classList.remove('is-fresh');
          }
        }),
      );
    }
  }

  /** The row (`tr` or `li`) of a request, when it is rendered. */
  private rowElement(requestId: string): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(`.request-row[data-request-id="${CSS.escape(requestId)}"]`);
  }

  private timeButtonOf(requestId: string): HTMLButtonElement | null {
    return this.body.querySelector<HTMLButtonElement>(`.time-button[data-request-id="${CSS.escape(requestId)}"]`);
  }

  showLoading(narrow: boolean): void {
    this.narrow = narrow;
    this.rows = [];
    this.pending = [];
    this.newBar.hidden = true;
    this.pager.hidden = true;
    const cells = narrow ? 3 : 8;
    replaceChildren(
      this.body,
      [0, 1, 2, 3, 4, 5, 6, 7].map(() =>
        h(
          'div',
          { class: 'skeleton-row' },
          Array.from({ length: cells }, () => h('span', { class: 'skeleton skeleton-cell' })),
        ),
      ),
    );
    this.body.setAttribute('aria-busy', 'true');
    this.body.setAttribute('aria-label', 'Loading requests');
  }

  showEmpty(baseUrl: string): void {
    this.rows = [];
    this.pending = [];
    this.newBar.hidden = true;
    this.body.removeAttribute('aria-busy');
    this.body.removeAttribute('aria-label');
    replaceChildren(this.body, [
      h('p', { class: 'is-muted' }, [
        "No requests yet. Point your SDK's ",
        h('code', {}, ['base_url']),
        ' at ',
        h('code', {}, [baseUrl]),
        ' and send a request; it appears here as soon as it completes.',
      ]),
    ]);
    this.pager.hidden = true;
  }

  show(rows: readonly TableRow[], nextCursor: string | null, narrow: boolean): void {
    this.narrow = narrow;
    this.rows = unseenRows(rows);
    this.pending = [];
    this.nextCursor = nextCursor;
    this.newBar.hidden = true;
    this.freshIds.clear();
    this.tabbableId = this.rows[0]?.requestId;
    this.body.removeAttribute('aria-busy');
    this.body.removeAttribute('aria-label');
    this.render();
    this.renderPager();
  }

  setNarrow(narrow: boolean): void {
    if (narrow === this.narrow) return;
    this.narrow = narrow;
    this.render();
  }

  /** A batch of live entries, newest first, from the event stream (DESIGN.md §13.6). */
  receiveLive(rows: readonly TableRow[]): void {
    const fresh = unseenRows(rows, this.rows, this.pending);
    if (fresh.length === 0) return;
    if (
      this.pending.length === 0 &&
      shouldPrependLive({
        headerInView: this.headerInView(),
        focusInsideTable: this.focusInside(),
        drawerOpen: this.drawerOpen,
      })
    ) {
      this.pending = fresh;
      this.flushPending(false);
      return;
    }
    this.pending = [...fresh, ...this.pending];
    this.renderNewBar();
  }

  /**
   * Merges the first page read again after a reconnect (§13.8): the rows missed while live updates were
   * paused arrive as live rows do; the rows already shown, and every older page loaded so far, stay.
   */
  mergeLatest(rows: readonly TableRow[], nextCursor: string | null): void {
    if (this.rows.length === 0) {
      this.show(rows, nextCursor, this.narrow);
      return;
    }
    this.receiveLive(rows);
  }

  private renderNewBar(): void {
    this.newBar.hidden = false;
    this.newButton.textContent =
      this.pending.length === 1 ? '1 new request · Show' : `${this.pending.length} new requests · Show`;
    this.announce();
  }

  /** Copies the button's text to the live region at most once every 5 seconds, so a burst is announced once. */
  private announce(): void {
    if (this.announceTimer !== undefined) return;
    const update = (): void => {
      this.announceTimer = undefined;
      const text = this.pending.length === 0 ? '' : (this.newButton.textContent ?? '');
      if (this.liveRegion.textContent === text) return;
      this.liveRegion.textContent = text;
      if (text !== '') this.lastAnnouncedAt = Date.now();
    };
    const delay = announceDelay(this.lastAnnouncedAt, Date.now());
    if (delay === 0) update();
    else this.announceTimer = window.setTimeout(update, delay);
  }

  /**
   * Appends an older page at the bottom. Rows are keyed by requestId, so an entry already shown (live, or
   * from a page read twice) is not added again (§13.5). Focus stays where it is, usually the pager button.
   */
  appendOlder(rows: readonly TableRow[], nextCursor: string | null): void {
    const older = unseenRows(rows, this.rows, this.pending);
    this.rows = [...this.rows, ...older];
    this.nextCursor = nextCursor;
    this.insertRows(older, 'bottom');
    this.renderPager();
  }

  /**
   * Adds rows at the top or the bottom of the rows already on the page, leaving those untouched: their
   * focus, their fade and the reader's place are kept. Falls back to a full render when nothing is shown.
   */
  private insertRows(rows: readonly TableRow[], where: 'top' | 'bottom'): void {
    if (rows.length === 0) return;
    const container = this.body.querySelector<HTMLElement>(this.narrow ? 'ul.requests-list' : 'tbody');
    if (container === null) {
      this.render();
      return;
    }
    const nodes = rows.map((row) => (this.narrow ? this.listItemNode(row) : this.tableRowNode(row)));
    if (where === 'top') container.prepend(...nodes);
    else container.append(...nodes);
    if (this.tabbableId === undefined || !this.rows.some((row) => row.requestId === this.tabbableId)) {
      this.setTabbable(this.rows[0]?.requestId ?? '');
    }
  }

  setPagerBusy(busy: boolean): void {
    this.pagerBusy = busy;
    this.pagerButton.textContent = busy ? 'Loading…' : 'Load 50 older requests';
    if (busy) {
      this.pagerButton.setAttribute('aria-disabled', 'true');
      this.body.setAttribute('aria-busy', 'true');
      this.pagerError.hidden = true;
    } else {
      this.pagerButton.removeAttribute('aria-disabled');
      this.body.removeAttribute('aria-busy');
    }
  }

  setPagerFailed(): void {
    this.setPagerBusy(false);
    this.pagerError.hidden = false;
    this.pagerButton.textContent = 'Try again';
  }

  /** Moves focus to a row's Time button, e.g. after the drawer that opened it closes. */
  focusRequest(requestId: string): void {
    this.setTabbable(requestId);
    this.refreshRowClasses();
    this.timeButtonOf(requestId)?.focus();
  }

  /** Moves the roving tab stop (§13.7) in place, without a re-render, so focus and the fade are kept. */
  private setTabbable(requestId: string): void {
    this.tabbableId = requestId;
    for (const button of this.body.querySelectorAll<HTMLButtonElement>('.time-button')) {
      button.tabIndex = button.dataset.requestId === requestId ? 0 : -1;
    }
  }

  /** Moves the "last opened" bar (§13.7) to the right row, in place. */
  private refreshRowClasses(): void {
    for (const row of this.body.querySelectorAll<HTMLElement>('.request-row')) {
      row.classList.toggle('is-last-opened', row.dataset.requestId === this.lastOpenedId);
    }
  }

  /** Updates the pager in place, so the button keeps focus while pages load (§13.5). */
  private renderPager(): void {
    if (this.rows.length === 0) {
      this.pager.hidden = true;
      return;
    }
    this.pager.hidden = false;
    this.count.textContent = `Showing ${this.rows.length} of the newest requests`;
    const atEnd = this.nextCursor === null;
    const buttonHadFocus = document.activeElement === this.pagerButton;
    this.pagerButton.hidden = atEnd;
    this.pagerEnd.hidden = !atEnd;
    if (atEnd) this.pagerError.hidden = true;
    // The last page replaces the button with a sentence; focus moves to it rather than to the page body.
    if (atEnd && buttonHadFocus) this.pagerEnd.focus();
  }

  private timeButton(row: TableRow): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: 'time-button',
        'data-request-id': row.requestId,
        title: row.isoTimestamp,
        tabindex: row.requestId === this.tabbableId ? '0' : '-1',
        'aria-label': row.accessibleName,
      },
      [row.timeText],
    );
  }

  /** Rebuilds the rows. A focused Time button gets focus back: the same request's button after the rebuild. */
  private render(): void {
    if (this.rows.length === 0) return;
    const active = document.activeElement;
    const focusedId =
      active instanceof HTMLElement && this.body.contains(active) && active.classList.contains('time-button')
        ? active.dataset.requestId
        : undefined;
    if (this.tabbableId === undefined || !this.rows.some((row) => row.requestId === this.tabbableId)) {
      this.tabbableId = this.rows[0]?.requestId;
    }
    if (this.narrow) this.renderList();
    else this.renderTable();
    if (focusedId !== undefined) this.timeButtonOf(focusedId)?.focus();
    if (this.pending.length > 0) this.renderNewBar();
  }

  private tableRowNode(row: TableRow): HTMLTableRowElement {
    return h('tr', { class: rowClass(row, this.freshIds, this.lastOpenedId), 'data-request-id': row.requestId }, [
      h('td', {}, [this.timeButton(row)]),
      h('td', { class: 'is-mono' }, [row.requestedModel]),
      h('td', {}, routedCell(row.routedTo, row.substitution)),
      h('td', {}, [row.policy]),
      h('td', { class: `nowrap ${row.cost.unknown ? 'is-muted' : ''}` }, [row.cost.text]),
      h('td', { class: 'nowrap' }, savedCellNodes(row.saved)),
      h('td', { class: 'nowrap' }, [row.latencyText]),
      h('td', {}, [statusNode(row.status)]),
    ]);
  }

  private renderTable(): void {
    const rows = this.rows.map((row) => this.tableRowNode(row));
    const table = h('table', { class: 'requests-table' }, [
      h('caption', { class: 'visually-hidden' }, ['Recent requests, newest first']),
      h('thead', {}, [
        h('tr', {}, [
          h('th', { scope: 'col' }, ['Time']),
          h('th', { scope: 'col' }, ['Requested']),
          h('th', { scope: 'col' }, ['Routed to']),
          h('th', { scope: 'col' }, ['Policy']),
          h('th', { scope: 'col' }, ['Cost']),
          h('th', { scope: 'col' }, ['Saved']),
          h('th', { scope: 'col' }, ['Latency']),
          h('th', { scope: 'col' }, ['Status']),
        ]),
      ]),
      h('tbody', {}, rows),
    ]);
    replaceChildren(this.body, [
      h('div', { class: 'scroll-region', role: 'region', 'aria-label': 'Recent requests', tabindex: '0' }, [table]),
    ]);
  }

  private renderList(): void {
    replaceChildren(this.body, [
      h(
        'ul',
        { class: 'requests-list' },
        this.rows.map((row) => this.listItemNode(row)),
      ),
    ]);
  }

  private listItemNode(row: TableRow): HTMLLIElement {
    return h('li', { class: rowClass(row, this.freshIds, this.lastOpenedId), 'data-request-id': row.requestId }, [
      h(
        'button',
        {
          type: 'button',
          class: 'time-button row-item',
          'data-request-id': row.requestId,
          title: row.isoTimestamp,
          tabindex: row.requestId === this.tabbableId ? '0' : '-1',
          'aria-label': row.accessibleName,
        },
        [
          h('span', { class: 'row-line1' }, [h('b', {}, [row.timeText]), statusNode(row.status)]),
          h('span', { class: 'row-line2' }, [
            h('span', { class: 'is-mono' }, [row.requestedModel]),
            h('span', { 'aria-hidden': 'true' }, [' → ']),
            row.routedTo.notRouted
              ? h('span', { class: 'is-muted' }, ['Not routed'])
              : h('span', {}, [row.routedTo.provider ?? '']),
            pipsOf(row.routedTo) ?? '',
          ]),
          row.substitution === undefined
            ? ''
            : h('span', { class: 'row-line-sub' }, [
                h('span', { class: 'chip sub-chip' }, ['Substituted']),
                h('span', { class: 'is-mono is-muted' }, [`served ${row.substitution.servedModel}`]),
              ]),
          h('span', { class: 'row-line3' }, [
            h('span', {}, ['Cost ', h('span', { class: row.cost.unknown ? 'is-muted' : undefined }, [row.cost.text])]),
            h('span', {}, ['Saved ', ...savedCellNodes(row.saved)]),
            h('span', {}, [row.latencyText]),
          ]),
        ],
      ),
    ]);
  }
}

function rowClass(row: TableRow, freshIds: Set<string>, lastOpenedId: string | undefined): string {
  const classes: string[] = ['request-row'];
  if (freshIds.has(row.requestId)) classes.push('is-fresh');
  if (row.requestId === lastOpenedId) classes.push('is-last-opened');
  return classes.join(' ');
}
