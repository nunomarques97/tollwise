// The dashboard shell: registers the custom elements and runs the page against a data source
// (./data-source.ts). It reads the data for whichever view is selected (Overview, Routing, Savings or
// Providers) for the selected range. With the live source it keeps that data current from the event
// stream (fetch streaming of /api/events, so the access key can travel in a header) and asks for the
// access key when the API answers 401. Only the visible view fetches (DESIGN.md §12.8). While Routing or
// Providers is the visible view it is kept current from the `request` and `health` events (§13.6, §14.1);
// switching back to one of them reads its data again, so it never shows what was missed while it was
// hidden. With a snapshot source (the static demo) every read is answered from the snapshot and nothing
// is streamed, retried or shown as live (§15).
import { forgetAccessKey, readAccessKey, storeAccessKey } from './access.js';
import { fetchBreakdown, fetchHealth, fetchLastRequestTime, fetchRequests, fetchSummary, fetchTimeseries, parseHealth, parseRecentEvent, readEventStream, requestTime, } from './api.js';
import { buildBreakdown } from './charts/breakdown-model.js';
import { bucketForRange, bucketWord, buildSavingsChartView } from './charts/timeseries-model.js';
import { h, replaceChildren } from './dom.js';
import { AccessForm } from './elements/access-form.js';
import { BreakdownCard } from './elements/breakdown-card.js';
import { KpiCards } from './elements/kpi-cards.js';
import { LiveStatus } from './elements/live-status.js';
import { ProvidersCard } from './elements/providers-card.js';
import { RangeSelector } from './elements/range-selector.js';
import { RequestDrawer } from './elements/request-drawer.js';
import { RequestsTable } from './elements/requests-table.js';
import { SavingsBlock } from './elements/savings-block.js';
import { SavingsChart } from './elements/savings-chart.js';
import { ThemeToggle } from './elements/theme-toggle.js';
import { formatClock } from './format.js';
import { describeOverview } from './overview-model.js';
import { DEFAULT_RANGE, rangeFromHash, rangeOption, savedHeading } from './ranges.js';
import { SingleFlight, tableRow } from './routing-model.js';
import { hashFor, viewFromHash } from './views.js';
/** Delay before the event stream (or an unreachable Tollwise) is tried again. */
const RETRY_MS = 5_000;
/** A burst of live events refreshes the current view at most this often. */
const LIVE_REFRESH_MS = 1_000;
const NARROW_QUERY = '(max-width: 720px)';
/** How many entries GET /api/requests returns per page (DESIGN.md §13.5). */
const REQUESTS_PAGE_SIZE = 50;
function define(name, element) {
    if (customElements.get(name) === undefined)
        customElements.define(name, element);
}
function sessionStore() {
    try {
        return window.sessionStorage;
    }
    catch {
        return undefined;
    }
}
function required(selector) {
    const element = document.querySelector(selector);
    if (element === null)
        throw new Error(`The dashboard page has no ${selector} element.`);
    return element;
}
/** "Savings over the last 24 hours": the Savings view's own h1 (DESIGN.md §12.1), never the overview's. */
function savingsChartHeading(range) {
    return `Savings over the last ${rangeOption(range).span}`;
}
/** The left side of the range bar for the views that have no time range (DESIGN.md §13.1, §14.1). */
const SCOPE_TEXT = {
    routing: 'Every recorded request, newest first',
    providers: 'Latest health checks and routed requests',
};
class Dashboard {
    source;
    fetchFn;
    /** The range the page opens on when the URL fragment names none. */
    defaultRange;
    storage = sessionStore();
    nav = required('#views');
    live = required('tw-live-status');
    overviewView = required('#overview');
    routingView = required('#routing');
    savingsView = required('#savings');
    providersView = required('#providers');
    range = required('tw-range-selector');
    scopeText = required('#scope-text');
    asOf = required('#as-of');
    banners = required('#banners');
    savingsBlock = required('tw-savings-block');
    cards = required('tw-kpi-cards');
    requestsTable = required('tw-requests-table');
    requestDrawer = required('tw-request-drawer');
    savingsChart = required('tw-savings-chart');
    byProvider = required('tw-breakdown-card[data-by="provider"]');
    byModel = required('tw-breakdown-card[data-by="model"]');
    providersCard = required('tw-providers-card');
    form = required('tw-access-form');
    narrowQuery = window.matchMedia(NARROW_QUERY);
    baseUrl = `${window.location.origin}/v1`;
    key = readAccessKey(this.storage);
    mode = 'loading';
    currentView = viewFromHash(window.location.hash);
    loadedViews = new Set();
    currentBucket;
    /** When the data on screen was last read successfully, for any view. */
    lastFetchAt;
    /** Whether the current view's own data is empty (DESIGN.md §8, §13.8, §14.5). */
    currentEmpty = false;
    /** The newest request Tollwise recorded: undefined until known, null when there is none. */
    lastRequest;
    loadSequence = 0;
    requestsNextCursor = null;
    /** One "Load 50 older requests" fetch at a time, so a double activation never reads a page twice. */
    olderPages = new SingleFlight();
    /** Every request entry the page has seen, by id, so the drawer can show one without refetching it. */
    requestEntries = new Map();
    stream;
    streamOpen = false;
    streamDropped = false;
    retryTimer;
    liveTimer;
    constructor(source) {
        this.source = source;
        this.fetchFn = source.read;
        this.defaultRange = source.kind === 'snapshot' ? source.defaultRange : DEFAULT_RANGE;
    }
    start() {
        this.range.value = rangeFromHash(window.location.hash, this.defaultRange);
        this.updateTabState();
        this.range.addEventListener('range-change', (event) => {
            const range = event.detail;
            window.history.replaceState(null, '', hashFor(this.currentView, range));
            void this.load('range');
        });
        window.addEventListener('hashchange', () => {
            const nextRange = rangeFromHash(window.location.hash, this.defaultRange);
            const nextView = viewFromHash(window.location.hash);
            const viewChanged = nextView !== this.currentView;
            const rangeChanged = nextRange !== this.range.value;
            if (!viewChanged && !rangeChanged)
                return;
            this.currentView = nextView;
            this.range.value = nextRange;
            this.updateTabState();
            void this.load(rangeChanged ? 'range' : 'initial');
        });
        this.nav.addEventListener('click', (event) => {
            const anchor = event.target.closest('a[data-view]');
            if (!(anchor instanceof HTMLAnchorElement))
                return;
            event.preventDefault();
            const next = anchor.dataset.view;
            if (next !== 'overview' && next !== 'routing' && next !== 'savings' && next !== 'providers')
                return;
            this.switchView(next);
        });
        this.narrowQuery.addEventListener('change', () => {
            if (this.mode !== 'ready')
                return;
            if (this.currentView === 'savings') {
                const bucket = bucketForRange(this.range.value, this.narrowQuery.matches);
                if (bucket !== this.currentBucket)
                    void this.load('range');
            }
            else if (this.currentView === 'routing') {
                this.requestsTable.setNarrow(this.narrowQuery.matches);
            }
        });
        this.form.addEventListener('access-key', (event) => {
            this.key = event.detail;
            storeAccessKey(this.storage, this.key);
            void this.load('unlock');
        });
        this.requestsTable.addEventListener('open-request', (event) => this.openRequest(event));
        this.requestsTable.addEventListener('load-older', () => void this.loadOlderRequests());
        this.nav.hidden = this.nav.querySelectorAll('a').length < 2;
        this.setLive('connecting');
        void this.load('initial');
    }
    switchView(next) {
        if (next === this.currentView)
            return;
        this.currentView = next;
        window.history.replaceState(null, '', hashFor(next, this.range.value));
        this.updateTabState();
        if (this.mode === 'locked' || this.mode === 'error')
            return;
        void this.load(this.loadedViews.has(next) ? 'range' : 'initial');
    }
    updateTabState() {
        for (const anchor of this.nav.querySelectorAll('a[data-view]')) {
            if (anchor.dataset.view === this.currentView)
                anchor.setAttribute('aria-current', 'page');
            else
                anchor.removeAttribute('aria-current');
        }
        const hasRange = this.currentView === 'overview' || this.currentView === 'savings';
        this.range.hidden = !hasRange;
        this.scopeText.hidden = hasRange;
        if (this.currentView === 'routing' || this.currentView === 'providers')
            this.scopeText.textContent = SCOPE_TEXT[this.currentView];
        if (this.mode !== 'locked' && this.mode !== 'error')
            this.showActiveView();
    }
    showActiveView() {
        this.overviewView.hidden = this.currentView !== 'overview';
        this.routingView.hidden = this.currentView !== 'routing';
        this.savingsView.hidden = this.currentView !== 'savings';
        this.providersView.hidden = this.currentView !== 'providers';
    }
    /** Reads the data for the current view and range; `reason` decides how the wait looks. */
    async load(reason) {
        const sequence = ++this.loadSequence;
        const range = this.range.value;
        const firstRead = !this.loadedViews.has(this.currentView) && this.mode !== 'error' && this.mode !== 'locked';
        if (firstRead && reason !== 'live')
            this.showLoading();
        if (reason === 'range')
            this.setViewBusy(true);
        if (this.currentView === 'overview') {
            const result = await fetchSummary(this.fetchFn, range, this.key);
            if (sequence !== this.loadSequence)
                return;
            const summary = this.applyCommonResult(result);
            if (summary === undefined)
                return;
            this.loadedViews.add('overview');
            this.renderOverview(summary, reason === 'live');
            if (this.lastRequest === undefined)
                void this.loadLastRequest();
            this.openStream();
            return;
        }
        if (this.currentView === 'routing') {
            // Live updates arrive incrementally (§13.6); a full refetch would lose scroll position and focus.
            if (reason === 'live')
                return;
            const result = await fetchRequests(this.fetchFn, this.key, { limit: REQUESTS_PAGE_SIZE });
            if (sequence !== this.loadSequence)
                return;
            const page = this.applyGenericResult(result);
            if (page === undefined)
                return;
            const merge = reason === 'retry' && this.loadedViews.has('routing') && !this.currentEmpty;
            this.loadedViews.add('routing');
            for (const entry of page.entries)
                this.requestEntries.set(entry.requestId, entry);
            const rows = page.entries.map((entry) => this.toTableRow(entry));
            if (merge) {
                // Back after a pause: merge the first page by requestId (§13.8); older pages already loaded stay,
                // and so does the cursor that continues after them.
                this.requestsTable.mergeLatest(rows, page.nextCursor);
            }
            else {
                this.requestsNextCursor = page.nextCursor;
                this.currentEmpty = page.entries.length === 0;
                if (this.currentEmpty)
                    this.requestsTable.showEmpty(this.baseUrl);
                else
                    this.requestsTable.show(rows, page.nextCursor, this.narrowQuery.matches);
            }
            this.renderBanners();
            this.renderAsOf();
            if (this.lastRequest === undefined)
                void this.loadLastRequest();
            this.openStream();
            return;
        }
        if (this.currentView === 'providers') {
            if (reason === 'live')
                return;
            const result = await fetchHealth(this.fetchFn, this.key);
            if (sequence !== this.loadSequence)
                return;
            const health = this.applyGenericResult(result);
            if (health === undefined)
                return;
            this.loadedViews.add('providers');
            this.currentEmpty = health.providers.size === 0;
            if (this.currentEmpty)
                this.providersCard.showEmpty();
            else
                this.providersCard.show(health);
            this.renderBanners();
            this.renderAsOf();
            if (this.lastRequest === undefined)
                void this.loadLastRequest();
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
        if (sequence !== this.loadSequence)
            return;
        const summary = this.applyCommonResult(summaryResult);
        if (summary === undefined)
            return;
        this.loadedViews.add('savings');
        this.currentBucket = bucket;
        this.renderSavings(summary, range, narrow, timeseriesResult, providerResult, modelResult);
        if (this.lastRequest === undefined)
            void this.loadLastRequest();
        this.openStream();
    }
    toTableRow(entry) {
        return tableRow(entry, formatClock(new Date(entry.timestamp)));
    }
    /**
     * The outcome every view shares (401, a server error, unreachable): locks, shows the error banner or
     * schedules a retry, and otherwise marks the page unlocked and ready. Returns the value on success,
     * undefined when the caller should stop (already handled).
     */
    applyGenericResult(result) {
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
                if (this.streamOpen)
                    this.streamDropped = false;
                this.unlock();
                this.mode = 'ready';
                return result.value;
        }
    }
    /** As applyGenericResult, and also updates the summary state the Overview and Savings views share. */
    applyCommonResult(result) {
        const value = this.applyGenericResult(result);
        if (value === undefined)
            return undefined;
        this.currentEmpty = value.requests === 0;
        return value;
    }
    async loadLastRequest() {
        const result = await fetchLastRequestTime(this.fetchFn, this.key);
        if (result.kind !== 'ok' || this.lastRequest !== undefined)
            return;
        this.lastRequest = result.value;
        this.renderAsOf();
    }
    async loadOlderRequests() {
        await this.olderPages.run(async () => {
            const cursor = this.requestsNextCursor;
            if (cursor === null)
                return;
            this.requestsTable.setPagerBusy(true);
            const result = await fetchRequests(this.fetchFn, this.key, { limit: REQUESTS_PAGE_SIZE, before: cursor });
            if (result.kind !== 'ok') {
                this.requestsTable.setPagerFailed();
                return;
            }
            for (const entry of result.value.entries)
                this.requestEntries.set(entry.requestId, entry);
            this.requestsNextCursor = result.value.nextCursor;
            this.requestsTable.setPagerBusy(false);
            this.requestsTable.appendOlder(result.value.entries.map((entry) => this.toTableRow(entry)), result.value.nextCursor);
        });
    }
    openRequest(event) {
        const entry = this.requestEntries.get(event.detail.requestId);
        if (entry === undefined)
            return;
        this.requestsTable.setDrawerOpen(true);
        this.requestDrawer.open(entry, event.detail.opener, () => this.requestsTable.setDrawerOpen(false));
    }
    showLoading() {
        this.mode = 'loading';
        this.showActiveView();
        if (this.currentView === 'overview') {
            this.savingsBlock.hidden = false;
            this.cards.hidden = false;
            this.savingsBlock.showLoading();
            this.cards.showLoading();
        }
        else if (this.currentView === 'routing') {
            this.requestsTable.showLoading(this.narrowQuery.matches);
        }
        else if (this.currentView === 'providers') {
            this.providersCard.showLoading();
        }
        else {
            const bucket = bucketForRange(this.range.value, this.narrowQuery.matches);
            this.savingsChart.showLoading(bucketWord(bucket));
            this.byProvider.showLoading('Spend by provider');
            this.byModel.showLoading('Spend by model');
        }
        this.asOf.textContent = 'Loading…';
    }
    setViewBusy(busy) {
        if (this.currentView === 'overview') {
            this.savingsBlock.setBusy(busy);
            this.cards.setBusy(busy);
        }
        else if (this.currentView === 'routing') {
            this.requestsTable.classList.toggle('is-busy', busy);
        }
        else if (this.currentView === 'providers') {
            this.providersCard.classList.toggle('is-busy', busy);
        }
        else {
            this.savingsChart.setBusy(busy);
            this.byProvider.classList.toggle('is-busy', busy);
            this.byModel.classList.toggle('is-busy', busy);
        }
    }
    renderOverview(summary, animate) {
        const view = describeOverview(summary, this.baseUrl);
        this.savingsBlock.hidden = false;
        this.cards.hidden = false;
        this.savingsBlock.show(savedHeading(this.range.value), view.savings, animate);
        this.cards.show(view.cards);
        this.renderBanners();
        this.renderAsOf();
        if (animate)
            this.live.pulse();
    }
    renderSavings(summary, range, narrow, timeseriesResult, providerResult, modelResult) {
        const heading = savingsChartHeading(range);
        if (summary.requests === 0) {
            this.savingsChart.showEmpty(heading, this.baseUrl);
            this.byProvider.showEmpty('Spend by provider');
            this.byModel.showEmpty('Spend by model');
        }
        else {
            if (timeseriesResult.kind === 'ok') {
                const view = buildSavingsChartView(timeseriesResult.value, summary, range, narrow);
                this.savingsChart.show(heading, view, summary);
            }
            else {
                this.savingsChart.showFailed(heading);
            }
            if (providerResult.kind === 'ok') {
                this.byProvider.show('Spend by provider', buildBreakdown(providerResult.value, 'provider'), {
                    mono: false,
                    keyLabel: 'Provider',
                });
            }
            else {
                this.byProvider.showFailed('Spend by provider');
            }
            if (modelResult.kind === 'ok') {
                this.byModel.show('Spend by model', buildBreakdown(modelResult.value, 'model'), {
                    mono: true,
                    keyLabel: 'Model',
                });
            }
            else {
                this.byModel.showFailed('Spend by model');
            }
        }
        this.renderBanners();
        this.renderAsOf();
    }
    renderAsOf() {
        if (this.mode === 'loading')
            return;
        if (this.source.kind === 'snapshot') {
            this.asOf.textContent = this.mode === 'error' ? '' : this.source.asOf;
            return;
        }
        if (this.mode === 'error' || this.lastFetchAt === undefined) {
            this.asOf.textContent = '';
        }
        else if (this.streamDropped) {
            this.asOf.textContent = `As of ${formatClock(this.lastFetchAt)}`;
        }
        else if (this.currentEmpty || this.lastRequest === null) {
            this.asOf.textContent = 'Waiting for the first request';
        }
        else if (this.lastRequest !== undefined) {
            this.asOf.textContent = `Last request ${formatClock(this.lastRequest)}`;
        }
        else {
            this.asOf.textContent = `As of ${formatClock(this.lastFetchAt)}`;
        }
    }
    renderBanners() {
        if (this.streamDropped && this.lastFetchAt !== undefined) {
            this.setBanner('warning', 'Live updates paused.', `The connection to Tollwise was lost. Retrying every 5 seconds; the numbers below are from ${formatClock(this.lastFetchAt)}.`);
        }
        else {
            this.setBanner(undefined);
        }
    }
    /** Shows one banner, or none. A banner that appears after the page loaded is announced (role alert). */
    setBanner(kind, lead = '', text = '') {
        const current = this.banners.firstElementChild;
        if (kind === undefined) {
            this.banners.replaceChildren();
            return;
        }
        if (current?.dataset.kind === kind && current.textContent === `${lead} ${text}`)
            return;
        replaceChildren(this.banners, [
            h('div', { class: `banner is-${kind}`, role: 'alert', 'data-kind': kind }, [
                h('strong', {}, [lead]),
                ' ',
                h('span', {}, [text]),
            ]),
        ]);
    }
    /** The metrics API answered with an error that retrying will not fix (e.g. analytics is off). */
    showError(result) {
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
        if (this.currentView === 'providers' && this.source.kind === 'live') {
            this.setBanner('error', 'Provider health unavailable.', 'Retrying every 5 seconds.');
            this.scheduleRetry(() => void this.load('retry'));
            return;
        }
        const leadIn = this.currentView === 'routing'
            ? 'Requests unavailable.'
            : this.currentView === 'providers'
                ? 'Provider health unavailable.'
                : 'Metrics unavailable.';
        this.setBanner('error', leadIn, result.message ?? `Tollwise answered HTTP ${result.status}. Check the terminal where Tollwise runs.`);
    }
    /** Tollwise did not answer: keep what is on screen and try again every 5 seconds. */
    showUnreachable() {
        if (this.source.kind === 'snapshot') {
            // Nothing to retry: the snapshot answered with something the dashboard cannot read.
            this.showError({ status: 0, message: 'The static demo snapshot has no readable data for this view.' });
            return;
        }
        this.unlock();
        this.streamDropped = true;
        this.setLive('paused');
        if (this.lastFetchAt === undefined) {
            this.setBanner('warning', 'Tollwise is not answering.', 'Retrying every 5 seconds.');
        }
        else {
            this.renderBanners();
            this.renderAsOf();
        }
        this.scheduleRetry(() => void this.load('retry'));
    }
    /** Shows the access-key form instead of the view; `refused` when the key sent was not accepted. */
    lock(refused) {
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
    unlock() {
        const wasLocked = this.mode === 'locked';
        if (!wasLocked && this.form.hidden)
            return;
        this.form.close();
        this.showActiveView();
        this.live.hidden = false;
        this.nav.hidden = this.nav.querySelectorAll('a').length < 2;
        if (wasLocked)
            required('#content').focus();
    }
    /** A snapshot is never live, connecting or paused: the indicator always says "Static demo". */
    setLive(state) {
        this.live.set(this.source.kind === 'snapshot' ? 'demo' : state);
    }
    // ------------------------------------------------------------ live event stream
    openStream() {
        if (this.source.kind === 'snapshot')
            return;
        if (this.stream !== undefined || this.retryTimer !== undefined)
            return;
        const controller = new AbortController();
        this.stream = controller;
        if (!this.streamDropped)
            this.setLive('connecting');
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
                    let raw;
                    try {
                        raw = JSON.parse(event.data);
                    }
                    catch {
                        return;
                    }
                    const time = requestTime(raw);
                    if (time !== undefined)
                        this.lastRequest = time;
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
                    let body;
                    try {
                        body = JSON.parse(event.data);
                    }
                    catch {
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
            if (this.stream !== controller)
                return;
            this.stream = undefined;
            this.streamOpen = false;
            if (end.kind === 'aborted')
                return;
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
    closeStream() {
        this.stream?.abort();
        this.stream = undefined;
        this.streamOpen = false;
        this.streamDropped = false;
        if (this.liveTimer !== undefined)
            window.clearTimeout(this.liveTimer);
        this.liveTimer = undefined;
    }
    /** Refreshes the current view shortly after a request event; a burst of events makes one refresh. */
    scheduleLiveRefresh() {
        if (this.currentView !== 'overview' && this.currentView !== 'savings')
            return;
        if (this.liveTimer !== undefined)
            return;
        this.liveTimer = window.setTimeout(() => {
            this.liveTimer = undefined;
            if (this.mode === 'ready' && this.streamOpen)
                void this.load('live');
        }, LIVE_REFRESH_MS);
    }
    scheduleRetry(retry) {
        if (this.source.kind === 'snapshot')
            return;
        this.clearRetry();
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = undefined;
            retry();
        }, RETRY_MS);
    }
    clearRetry() {
        if (this.retryTimer !== undefined)
            window.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
    }
}
/** Registers the dashboard's custom elements and starts the page on `source`. */
export function startDashboard(source) {
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
    new Dashboard(source).start();
}
