// Entry point of the dashboard page, loaded as an ES module from /dashboard/main.js. Registers the custom
// elements and runs the shell: it reads the data for whichever view is selected (Overview, Routing,
// Savings or Providers) for the selected range, keeps it current from the live event stream (fetch
// streaming of /api/events, so the access key can travel in a header), and asks for the access key when
// the API answers 401. Only the visible view fetches (DESIGN.md §12.8). While Routing or Providers is
// the visible view it is kept current from the `request` and `health` events (§13.6, §14.1); switching
// back to one of them reads its data again, so it never shows what was missed while it was hidden.

import { forgetAccessKey, type KeyStorage, readAccessKey, storeAccessKey } from './access.ts';
import {
  type ApiResult,
  type BreakdownResponse,
  fetchBreakdown,
  fetchHealth,
  fetchLastRequestTime,
  fetchRequests,
  fetchSummary,
  fetchTimeseries,
  parseHealth,
  parseRecentEvent,
  type RecentEntry,
  readEventStream,
  requestTime,
  type Summary,
  type TimeseriesBucketSize,
  type TimeseriesResponse,
} from './api.ts';
import { buildBreakdown } from './charts/breakdown-model.ts';
import { bucketForRange, bucketWord, buildSavingsChartView } from './charts/timeseries-model.ts';
import { h, replaceChildren } from './dom.ts';
import { AccessForm } from './elements/access-form.ts';
import { BreakdownCard } from './elements/breakdown-card.ts';
import { KpiCards } from './elements/kpi-cards.ts';
import { type LiveState, LiveStatus } from './elements/live-status.ts';
import { ProvidersCard } from './elements/providers-card.ts';
import { RangeSelector } from './elements/range-selector.ts';
import { RequestDrawer } from './elements/request-drawer.ts';
import { RequestsTable } from './elements/requests-table.ts';
import { SavingsBlock } from './elements/savings-block.ts';
import { SavingsChart } from './elements/savings-chart.ts';
import { ThemeToggle } from './elements/theme-toggle.ts';
import { formatClock } from './format.ts';
import { describeOverview } from './overview-model.ts';
import { type RangeId, rangeFromHash, rangeOption, savedHeading } from './ranges.ts';
import { SingleFlight, tableRow } from './routing-model.ts';
import { hashFor, type ViewId, viewFromHash } from './views.ts';

/** Delay before the event stream (or an unreachable Tollwise) is tried again. */
const RETRY_MS = 5_000;
/** A burst of live events refreshes the current view at most this often. */
const LIVE_REFRESH_MS = 1_000;
const NARROW_QUERY = '(max-width: 720px)';
/** How many entries GET /api/requests returns per page (DESIGN.md §13.5). */
const REQUESTS_PAGE_SIZE = 50;

/** Marks the page as scripted, so a check can tell the module loaded under the page's CSP. */
export function markScriptLoaded(root: HTMLElement): void {
  root.dataset.script = 'loaded';
}

function define(name: string, element: CustomElementConstructor): void {
  if (customElements.get(name) === undefined) customElements.define(name, element);
}

function sessionStore(): KeyStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`The dashboard page has no ${selector} element.`);
  return element;
}

/** "Savings over the last 24 hours": the Savings view's own h1 (DESIGN.md §12.1), never the overview's. */
function savingsChartHeading(range: RangeId): string {
  return `Savings over the last ${rangeOption(range).span}`;
}

/** The left side of the range bar for the views that have no time range (DESIGN.md §13.1, §14.1). */
const SCOPE_TEXT: Readonly<Record<'routing' | 'providers', string>> = {
  routing: 'Every recorded request, newest first',
  providers: 'Latest health checks and routed requests',
};

type Mode = 'loading' | 'ready' | 'locked' | 'error';

class Dashboard {
  private readonly fetchFn = window.fetch.bind(window);
  private readonly storage = sessionStore();
  private readonly nav = required<HTMLElement>('#views');
  private readonly live = required<LiveStatus>('tw-live-status');
  private readonly overviewView = required<HTMLElement>('#overview');
  private readonly routingView = required<HTMLElement>('#routing');
  private readonly savingsView = required<HTMLElement>('#savings');
  private readonly providersView = required<HTMLElement>('#providers');
  private readonly range = required<RangeSelector>('tw-range-selector');
  private readonly scopeText = required<HTMLElement>('#scope-text');
  private readonly asOf = required<HTMLElement>('#as-of');
  private readonly banners = required<HTMLElement>('#banners');
  private readonly savingsBlock = required<SavingsBlock>('tw-savings-block');
  private readonly cards = required<KpiCards>('tw-kpi-cards');
  private readonly requestsTable = required<RequestsTable>('tw-requests-table');
  private readonly requestDrawer = required<RequestDrawer>('tw-request-drawer');
  private readonly savingsChart = required<SavingsChart>('tw-savings-chart');
  private readonly byProvider = required<BreakdownCard>('tw-breakdown-card[data-by="provider"]');
  private readonly byModel = required<BreakdownCard>('tw-breakdown-card[data-by="model"]');
  private readonly providersCard = required<ProvidersCard>('tw-providers-card');
  private readonly form = required<AccessForm>('tw-access-form');
  private readonly narrowQuery = window.matchMedia(NARROW_QUERY);
  private readonly baseUrl = `${window.location.origin}/v1`;

  private key = readAccessKey(this.storage);
  private mode: Mode = 'loading';
  private currentView: ViewId = viewFromHash(window.location.hash);
  private readonly loadedViews = new Set<ViewId>();
  private currentBucket: TimeseriesBucketSize | undefined;
  /** When the data on screen was last read successfully, for any view. */
  private lastFetchAt: Date | undefined;
  /** Whether the current view's own data is empty (DESIGN.md §8, §13.8, §14.5). */
  private currentEmpty = false;
  /** The newest request Tollwise recorded: undefined until known, null when there is none. */
  private lastRequest: Date | null | undefined;
  private loadSequence = 0;
  private requestsNextCursor: string | null = null;
  /** One "Load 50 older requests" fetch at a time, so a double activation never reads a page twice. */
  private readonly olderPages = new SingleFlight();
  /** Every request entry the page has seen, by id, so the drawer can show one without refetching it. */
  private readonly requestEntries = new Map<string, RecentEntry>();

  private stream: AbortController | undefined;
  private streamOpen = false;
  private streamDropped = false;
  private retryTimer: number | undefined;
  private liveTimer: number | undefined;

  start(): void {
    this.range.value = rangeFromHash(window.location.hash);
    this.updateTabState();
    this.range.addEventListener('range-change', (event) => {
      const range = (event as CustomEvent<RangeId>).detail;
      window.history.replaceState(null, '', hashFor(this.currentView, range));
      void this.load('range');
    });
    window.addEventListener('hashchange', () => {
      const nextRange = rangeFromHash(window.location.hash);
      const nextView = viewFromHash(window.location.hash);
      const viewChanged = nextView !== this.currentView;
      const rangeChanged = nextRange !== this.range.value;
      if (!viewChanged && !rangeChanged) return;
      this.currentView = nextView;
      this.range.value = nextRange;
      this.updateTabState();
      void this.load(rangeChanged ? 'range' : 'initial');
    });
    this.nav.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement).closest('a[data-view]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      const next = anchor.dataset.view;
      if (next !== 'overview' && next !== 'routing' && next !== 'savings' && next !== 'providers') return;
      this.switchView(next);
    });
    this.narrowQuery.addEventListener('change', () => {
      if (this.mode !== 'ready') return;
      if (this.currentView === 'savings') {
        const bucket = bucketForRange(this.range.value, this.narrowQuery.matches);
        if (bucket !== this.currentBucket) void this.load('range');
      } else if (this.currentView === 'routing') {
        this.requestsTable.setNarrow(this.narrowQuery.matches);
      }
    });
    this.form.addEventListener('access-key', (event) => {
      this.key = (event as CustomEvent<string>).detail;
      storeAccessKey(this.storage, this.key);
      void this.load('unlock');
    });
    this.requestsTable.addEventListener('open-request', (event) =>
      this.openRequest(event as CustomEvent<{ requestId: string; opener: HTMLElement }>),
    );
    this.requestsTable.addEventListener('load-older', () => void this.loadOlderRequests());
    this.nav.hidden = this.nav.querySelectorAll('a').length < 2;
    this.setLive('connecting');
    void this.load('initial');
  }

  private switchView(next: ViewId): void {
    if (next === this.currentView) return;
    this.currentView = next;
    window.history.replaceState(null, '', hashFor(next, this.range.value));
    this.updateTabState();
    if (this.mode === 'locked' || this.mode === 'error') return;
    void this.load(this.loadedViews.has(next) ? 'range' : 'initial');
  }

  private updateTabState(): void {
    for (const anchor of this.nav.querySelectorAll<HTMLAnchorElement>('a[data-view]')) {
      if (anchor.dataset.view === this.currentView) anchor.setAttribute('aria-current', 'page');
      else anchor.removeAttribute('aria-current');
    }
    const hasRange = this.currentView === 'overview' || this.currentView === 'savings';
    this.range.hidden = !hasRange;
    this.scopeText.hidden = hasRange;
    if (this.currentView === 'routing' || this.currentView === 'providers')
      this.scopeText.textContent = SCOPE_TEXT[this.currentView];
    if (this.mode !== 'locked' && this.mode !== 'error') this.showActiveView();
  }

  private showActiveView(): void {
    this.overviewView.hidden = this.currentView !== 'overview';
    this.routingView.hidden = this.currentView !== 'routing';
    this.savingsView.hidden = this.currentView !== 'savings';
    this.providersView.hidden = this.currentView !== 'providers';
  }

  /** Reads the data for the current view and range; `reason` decides how the wait looks. */
  private async load(reason: 'initial' | 'range' | 'live' | 'unlock' | 'retry'): Promise<void> {
    const sequence = ++this.loadSequence;
    const range = this.range.value;
    const firstRead = !this.loadedViews.has(this.currentView) && this.mode !== 'error' && this.mode !== 'locked';
    if (firstRead && reason !== 'live') this.showLoading();
    if (reason === 'range') this.setViewBusy(true);

    if (this.currentView === 'overview') {
      const result = await fetchSummary(this.fetchFn, range, this.key);
      if (sequence !== this.loadSequence) return;
      const summary = this.applyCommonResult(result);
      if (summary === undefined) return;
      this.loadedViews.add('overview');
      this.renderOverview(summary, reason === 'live');
      if (this.lastRequest === undefined) void this.loadLastRequest();
      this.openStream();
      return;
    }

    if (this.currentView === 'routing') {
      // Live updates arrive incrementally (§13.6); a full refetch would lose scroll position and focus.
      if (reason === 'live') return;
      const result = await fetchRequests(this.fetchFn, this.key, { limit: REQUESTS_PAGE_SIZE });
      if (sequence !== this.loadSequence) return;
      const page = this.applyGenericResult(result);
      if (page === undefined) return;
      const merge = reason === 'retry' && this.loadedViews.has('routing') && !this.currentEmpty;
      this.loadedViews.add('routing');
      for (const entry of page.entries) this.requestEntries.set(entry.requestId, entry);
      const rows = page.entries.map((entry) => this.toTableRow(entry));
      if (merge) {
        // Back after a pause: merge the first page by requestId (§13.8); older pages already loaded stay,
        // and so does the cursor that continues after them.
        this.requestsTable.mergeLatest(rows, page.nextCursor);
      } else {
        this.requestsNextCursor = page.nextCursor;
        this.currentEmpty = page.entries.length === 0;
        if (this.currentEmpty) this.requestsTable.showEmpty(this.baseUrl);
        else this.requestsTable.show(rows, page.nextCursor, this.narrowQuery.matches);
      }
      this.renderBanners();
      this.renderAsOf();
      if (this.lastRequest === undefined) void this.loadLastRequest();
      this.openStream();
      return;
    }

    if (this.currentView === 'providers') {
      if (reason === 'live') return;
      const result = await fetchHealth(this.fetchFn, this.key);
      if (sequence !== this.loadSequence) return;
      const health = this.applyGenericResult(result);
      if (health === undefined) return;
      this.loadedViews.add('providers');
      this.currentEmpty = health.providers.size === 0;
      if (this.currentEmpty) this.providersCard.showEmpty();
      else this.providersCard.show(health);
      this.renderBanners();
      this.renderAsOf();
      if (this.lastRequest === undefined) void this.loadLastRequest();
      this.openStream();
      return;
    }

    const narrow = this.narrowQuery.matches;
    const bucket = bucketForRange(range, narrow);
    const [summaryResult, timeseriesResult, providerResult, modelResult] = await Promise.all([
      fetchSummary(this.fetchFn, range, this.key),
      fetchTimeseries(this.fetchFn, range, bucket, this.key),
      fetchBreakdown(this.fetchFn, range, 'provider', this.key),
      fetchBreakdown(this.fetchFn, range, 'model', this.key),
    ]);
    if (sequence !== this.loadSequence) return;
    const summary = this.applyCommonResult(summaryResult);
    if (summary === undefined) return;
    this.loadedViews.add('savings');
    this.currentBucket = bucket;
    this.renderSavings(summary, range, narrow, timeseriesResult, providerResult, modelResult);
    if (this.lastRequest === undefined) void this.loadLastRequest();
    this.openStream();
  }

  private toTableRow(entry: RecentEntry) {
    return tableRow(entry, formatClock(new Date(entry.timestamp)));
  }

  /**
   * The outcome every view shares (401, a server error, unreachable): locks, shows the error banner or
   * schedules a retry, and otherwise marks the page unlocked and ready. Returns the value on success,
   * undefined when the caller should stop (already handled).
   */
  private applyGenericResult<T>(result: ApiResult<T>): T | undefined {
    switch (result.kind) {
      case 'unauthorized':
        this.lock(this.key !== undefined);
        return undefined;
      case 'error':
        this.showError(result);
        return undefined;
      case 'offline':
        this.showUnreachable();
        return undefined;
      case 'ok':
        this.lastFetchAt = new Date();
        if (this.streamOpen) this.streamDropped = false;
        this.unlock();
        this.mode = 'ready';
        return result.value;
    }
  }

  /** As applyGenericResult, and also updates the summary state the Overview and Savings views share. */
  private applyCommonResult(result: ApiResult<Summary>): Summary | undefined {
    const value = this.applyGenericResult(result);
    if (value === undefined) return undefined;
    this.currentEmpty = value.requests === 0;
    return value;
  }

  private async loadLastRequest(): Promise<void> {
    const result: ApiResult<Date | null> = await fetchLastRequestTime(this.fetchFn, this.key);
    if (result.kind !== 'ok' || this.lastRequest !== undefined) return;
    this.lastRequest = result.value;
    this.renderAsOf();
  }

  private async loadOlderRequests(): Promise<void> {
    await this.olderPages.run(async () => {
      const cursor = this.requestsNextCursor;
      if (cursor === null) return;
      this.requestsTable.setPagerBusy(true);
      const result = await fetchRequests(this.fetchFn, this.key, { limit: REQUESTS_PAGE_SIZE, before: cursor });
      if (result.kind !== 'ok') {
        this.requestsTable.setPagerFailed();
        return;
      }
      for (const entry of result.value.entries) this.requestEntries.set(entry.requestId, entry);
      this.requestsNextCursor = result.value.nextCursor;
      this.requestsTable.setPagerBusy(false);
      this.requestsTable.appendOlder(
        result.value.entries.map((entry) => this.toTableRow(entry)),
        result.value.nextCursor,
      );
    });
  }

  private openRequest(event: CustomEvent<{ requestId: string; opener: HTMLElement }>): void {
    const entry = this.requestEntries.get(event.detail.requestId);
    if (entry === undefined) return;
    this.requestsTable.setDrawerOpen(true);
    this.requestDrawer.open(entry, event.detail.opener, () => this.requestsTable.setDrawerOpen(false));
  }

  private showLoading(): void {
    this.mode = 'loading';
    this.showActiveView();
    if (this.currentView === 'overview') {
      this.savingsBlock.hidden = false;
      this.cards.hidden = false;
      this.savingsBlock.showLoading();
      this.cards.showLoading();
    } else if (this.currentView === 'routing') {
      this.requestsTable.showLoading(this.narrowQuery.matches);
    } else if (this.currentView === 'providers') {
      this.providersCard.showLoading();
    } else {
      const bucket = bucketForRange(this.range.value, this.narrowQuery.matches);
      this.savingsChart.showLoading(bucketWord(bucket));
      this.byProvider.showLoading('Spend by provider');
      this.byModel.showLoading('Spend by model');
    }
    this.asOf.textContent = 'Loading…';
  }

  private setViewBusy(busy: boolean): void {
    if (this.currentView === 'overview') {
      this.savingsBlock.setBusy(busy);
      this.cards.setBusy(busy);
    } else if (this.currentView === 'routing') {
      this.requestsTable.classList.toggle('is-busy', busy);
    } else if (this.currentView === 'providers') {
      this.providersCard.classList.toggle('is-busy', busy);
    } else {
      this.savingsChart.setBusy(busy);
      this.byProvider.classList.toggle('is-busy', busy);
      this.byModel.classList.toggle('is-busy', busy);
    }
  }

  private renderOverview(summary: Summary, animate: boolean): void {
    const view = describeOverview(summary, this.baseUrl);
    this.savingsBlock.hidden = false;
    this.cards.hidden = false;
    this.savingsBlock.show(savedHeading(this.range.value), view.savings, animate);
    this.cards.show(view.cards);
    this.renderBanners();
    this.renderAsOf();
    if (animate) this.live.pulse();
  }

  private renderSavings(
    summary: Summary,
    range: RangeId,
    narrow: boolean,
    timeseriesResult: ApiResult<TimeseriesResponse>,
    providerResult: ApiResult<BreakdownResponse>,
    modelResult: ApiResult<BreakdownResponse>,
  ): void {
    const heading = savingsChartHeading(range);
    if (summary.requests === 0) {
      this.savingsChart.showEmpty(heading, this.baseUrl);
      this.byProvider.showEmpty('Spend by provider');
      this.byModel.showEmpty('Spend by model');
    } else {
      if (timeseriesResult.kind === 'ok') {
        const view = buildSavingsChartView(timeseriesResult.value, summary, range, narrow);
        this.savingsChart.show(heading, view, summary);
      } else {
        this.savingsChart.showFailed(heading);
      }
      if (providerResult.kind === 'ok') {
        this.byProvider.show('Spend by provider', buildBreakdown(providerResult.value, 'provider'), {
          mono: false,
          keyLabel: 'Provider',
        });
      } else {
        this.byProvider.showFailed('Spend by provider');
      }
      if (modelResult.kind === 'ok') {
        this.byModel.show('Spend by model', buildBreakdown(modelResult.value, 'model'), {
          mono: true,
          keyLabel: 'Model',
        });
      } else {
        this.byModel.showFailed('Spend by model');
      }
    }
    this.renderBanners();
    this.renderAsOf();
  }

  private renderAsOf(): void {
    if (this.mode === 'loading') return;
    if (this.mode === 'error' || this.lastFetchAt === undefined) {
      this.asOf.textContent = '';
    } else if (this.streamDropped) {
      this.asOf.textContent = `As of ${formatClock(this.lastFetchAt)}`;
    } else if (this.currentEmpty || this.lastRequest === null) {
      this.asOf.textContent = 'Waiting for the first request';
    } else if (this.lastRequest !== undefined) {
      this.asOf.textContent = `Last request ${formatClock(this.lastRequest)}`;
    } else {
      this.asOf.textContent = `As of ${formatClock(this.lastFetchAt)}`;
    }
  }

  private renderBanners(): void {
    if (this.streamDropped && this.lastFetchAt !== undefined) {
      this.setBanner(
        'warning',
        'Live updates paused.',
        `The connection to Tollwise was lost. Retrying every 5 seconds; the numbers below are from ${formatClock(this.lastFetchAt)}.`,
      );
    } else {
      this.setBanner(undefined);
    }
  }

  /** Shows one banner, or none. A banner that appears after the page loaded is announced (role alert). */
  private setBanner(kind: 'warning' | 'error' | undefined, lead = '', text = ''): void {
    const current = this.banners.firstElementChild as HTMLElement | null;
    if (kind === undefined) {
      this.banners.replaceChildren();
      return;
    }
    if (current?.dataset.kind === kind && current.textContent === `${lead} ${text}`) return;
    replaceChildren(this.banners, [
      h('div', { class: `banner is-${kind}`, role: 'alert', 'data-kind': kind }, [
        h('strong', {}, [lead]),
        ' ',
        h('span', {}, [text]),
      ]),
    ]);
  }

  /** The metrics API answered with an error that retrying will not fix (e.g. analytics is off). */
  private showError(result: { readonly status: number; readonly message: string | undefined }): void {
    this.mode = 'error';
    this.lastFetchAt = undefined;
    this.loadedViews.clear();
    this.closeStream();
    this.unlock();
    this.overviewView.hidden = true;
    this.routingView.hidden = true;
    this.savingsView.hidden = true;
    this.providersView.hidden = true;
    this.asOf.textContent = '';
    this.setLive('offline');
    if (this.currentView === 'providers') {
      this.setBanner('error', 'Provider health unavailable.', 'Retrying every 5 seconds.');
      this.scheduleRetry(() => void this.load('retry'));
      return;
    }
    const leadIn = this.currentView === 'routing' ? 'Requests unavailable.' : 'Metrics unavailable.';
    this.setBanner(
      'error',
      leadIn,
      result.message ?? `Tollwise answered HTTP ${result.status}. Check the terminal where Tollwise runs.`,
    );
  }

  /** Tollwise did not answer: keep what is on screen and try again every 5 seconds. */
  private showUnreachable(): void {
    this.unlock();
    this.streamDropped = true;
    this.setLive('paused');
    if (this.lastFetchAt === undefined) {
      this.setBanner('warning', 'Tollwise is not answering.', 'Retrying every 5 seconds.');
    } else {
      this.renderBanners();
      this.renderAsOf();
    }
    this.scheduleRetry(() => void this.load('retry'));
  }

  /** Shows the access-key form instead of the view; `refused` when the key sent was not accepted. */
  private lock(refused: boolean): void {
    this.mode = 'locked';
    this.closeStream();
    this.clearRetry();
    this.lastFetchAt = undefined;
    this.lastRequest = undefined;
    this.loadedViews.clear();
    if (refused) {
      forgetAccessKey(this.storage);
      this.key = undefined;
    }
    this.overviewView.hidden = true;
    this.routingView.hidden = true;
    this.savingsView.hidden = true;
    this.providersView.hidden = true;
    this.nav.hidden = true;
    this.live.hidden = true;
    this.setBanner(undefined);
    this.form.open(refused);
  }

  private unlock(): void {
    const wasLocked = this.mode === 'locked';
    if (!wasLocked && this.form.hidden) return;
    this.form.close();
    this.showActiveView();
    this.live.hidden = false;
    this.nav.hidden = this.nav.querySelectorAll('a').length < 2;
    if (wasLocked) required<HTMLElement>('#content').focus();
  }

  private setLive(state: LiveState): void {
    this.live.set(state);
  }

  // ------------------------------------------------------------ live event stream

  private openStream(): void {
    if (this.stream !== undefined || this.retryTimer !== undefined) return;
    const controller = new AbortController();
    this.stream = controller;
    if (!this.streamDropped) this.setLive('connecting');
    void readEventStream(this.fetchFn, this.key, controller.signal, {
      onOpen: () => {
        this.streamOpen = true;
        this.setLive('live');
        if (this.streamDropped) {
          // Back after a drop: what happened meanwhile was missed, so read the summary again.
          this.streamDropped = false;
          void this.load('retry');
        }
      },
      onEvent: (event) => {
        if (event.event === 'request') {
          let raw: unknown;
          try {
            raw = JSON.parse(event.data);
          } catch {
            return;
          }
          const time = requestTime(raw);
          if (time !== undefined) this.lastRequest = time;
          this.scheduleLiveRefresh();
          if (this.currentView === 'routing' && this.loadedViews.has('routing')) {
            const entry = parseRecentEvent(event.data);
            if (entry !== undefined) {
              this.requestEntries.set(entry.requestId, entry);
              this.currentEmpty = false;
              this.requestsTable.receiveLive([this.toTableRow(entry)]);
              this.renderAsOf();
            }
          }
          return;
        }
        if (event.event === 'health' && this.currentView === 'providers' && this.loadedViews.has('providers')) {
          let body: unknown;
          try {
            body = JSON.parse(event.data);
          } catch {
            return;
          }
          const health = parseHealth(body);
          if (health !== undefined) {
            this.currentEmpty = health.providers.size === 0;
            this.providersCard.show(health);
          }
        }
      },
    }).then((end) => {
      if (this.stream !== controller) return;
      this.stream = undefined;
      this.streamOpen = false;
      if (end.kind === 'aborted') return;
      if (end.kind === 'unauthorized') {
        this.lock(this.key !== undefined);
        return;
      }
      this.streamDropped = true;
      this.setLive('paused');
      this.renderBanners();
      this.renderAsOf();
      this.scheduleRetry(() => this.openStream());
    });
  }

  private closeStream(): void {
    this.stream?.abort();
    this.stream = undefined;
    this.streamOpen = false;
    this.streamDropped = false;
    if (this.liveTimer !== undefined) window.clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
  }

  /** Refreshes the current view shortly after a request event; a burst of events makes one refresh. */
  private scheduleLiveRefresh(): void {
    if (this.currentView !== 'overview' && this.currentView !== 'savings') return;
    if (this.liveTimer !== undefined) return;
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = undefined;
      if (this.mode === 'ready' && this.streamOpen) void this.load('live');
    }, LIVE_REFRESH_MS);
  }

  private scheduleRetry(retry: () => void): void {
    this.clearRetry();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      retry();
    }, RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

define('tw-theme-toggle', ThemeToggle);
define('tw-live-status', LiveStatus);
define('tw-range-selector', RangeSelector);
define('tw-savings-block', SavingsBlock);
define('tw-kpi-cards', KpiCards);
define('tw-access-form', AccessForm);
define('tw-savings-chart', SavingsChart);
define('tw-breakdown-card', BreakdownCard);
define('tw-requests-table', RequestsTable);
define('tw-request-drawer', RequestDrawer);
define('tw-providers-card', ProvidersCard);

markScriptLoaded(document.documentElement);
new Dashboard().start();
