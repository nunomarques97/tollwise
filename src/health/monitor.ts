// Periodic, and passively fed, health and latency tracking per provider.
//
// This module owns state only: it exposes no HTTP route of its own and it never decides routing. It
// reuses the free health request of each adapter through checkHealth() (see src/providers/health.ts),
// which already turns "no key configured" into an auth error without any network call. That keeps the
// rule in one place: nothing is ever requested from a provider whose key is not configured.
//
// A provider not present in `adapters` (for example one the registry excluded for a missing key, or
// because it is disabled) is never scheduled and never appears in snapshot(). Callers pass
// ProviderRegistry.enabled.
//
// Logging goes through src/log only, and only on a state transition: the provider id, the previous and
// new state, and the normalised error kind (never a URL, a header, an exception message or a provider
// response body).
//
// Scheduling: each provider has at most one pending timer. start() and stop() bump a generation number,
// and a finished check reschedules its provider only while the generation it was started under is still
// current, so a check that was in flight across stop()/start() can never add a second schedule or fire
// after stop(). Timers are unref()'d, so a monitor that is never stopped does not keep the process alive.
//
// Abort on stop(): each check in flight also carries an AbortController, passed to the checker as
// options.signal (see src/providers/health.ts). stop() aborts every one of them immediately, so a check
// against a slow or hanging provider never makes shutdown wait for it. An aborted check's result -- up,
// down or thrown -- is dropped rather than applied: it changes no state, records no latency sample and
// never logs a transition.

import type { Environment } from '../config/load.ts';
import type { ProviderId } from '../config/schema.ts';
import { getLogger, type Logger } from '../log/logger.ts';
import { checkHealth, DEFAULT_HEALTH_TIMEOUT_MS, type HealthOptions, type HealthResult } from '../providers/health.ts';
import type { ProviderAdapter, ProviderErrorKind } from '../providers/types.ts';

/** A provider has not been checked yet ('unknown'), answered its last check ('up'), or failed it ('down'). */
export type ProviderHealthState = 'unknown' | 'up' | 'down';

/** Default delay between the end of one check and the start of the next, for the same provider. */
export const DEFAULT_CHECK_INTERVAL_MS = 60_000;
/** Default jitter, as a fraction of intervalMs, added on top of it when jitterMs is not given. */
export const DEFAULT_JITTER_RATIO = 0.1;
/** Default number of latency samples kept per provider; the oldest is dropped once the window is full. */
export const DEFAULT_WINDOW_SIZE = 100;

export interface ProviderHealthSnapshot {
  readonly id: ProviderId;
  readonly state: ProviderHealthState;
  /** Normalised kind of the most recent failure (see ProviderErrorKind); null while up or unknown. */
  readonly lastErrorKind: ProviderErrorKind | null;
  /** Epoch milliseconds of the most recent check; null before the first one. */
  readonly lastCheckedAt: number | null;
  /** 50th percentile latency of the current sample window, in milliseconds; null with no samples yet. */
  readonly p50: number | null;
  /** 95th percentile latency of the current sample window, in milliseconds; null with no samples yet. */
  readonly p95: number | null;
  readonly sampleCount: number;
}

export interface HealthMonitorSnapshot {
  readonly providers: readonly ProviderHealthSnapshot[];
}

/** The shape of checkHealth() (src/providers/health.ts), kept here only so tests can inject a stand-in. */
export type HealthChecker = (
  adapter: ProviderAdapter,
  env: Environment,
  options?: HealthOptions,
) => Promise<HealthResult>;

export interface HealthMonitorOptions {
  /** Adapters to monitor; typically ProviderRegistry.enabled. A provider not listed here is never checked. */
  readonly adapters: readonly ProviderAdapter[];
  readonly env: Environment;
  /** Base delay between checks of the same provider. Default DEFAULT_CHECK_INTERVAL_MS (60000). */
  readonly intervalMs?: number;
  /** Extra random delay added to intervalMs, uniform in [0, jitterMs). Default 10% of intervalMs. */
  readonly jitterMs?: number;
  /** Timeout for one health request. Default DEFAULT_HEALTH_TIMEOUT_MS (src/providers/health.ts, 5000ms). */
  readonly timeoutMs?: number;
  /** Latency samples kept per provider. Default DEFAULT_WINDOW_SIZE (100). */
  readonly windowSize?: number;
  readonly logger?: Logger;
  /** Clock, for tests. Default Date.now. */
  readonly now?: () => number;
  /** Random source in [0, 1), for tests. Default Math.random. */
  readonly random?: () => number;
  /** Replaces checkHealth(), for tests. Default: checkHealth from src/providers/health.ts. */
  readonly checkProviderHealth?: HealthChecker;
}

export interface HealthMonitor {
  /**
   * Runs an immediate check for every monitored provider, then reschedules each one on its own
   * interval. Calling start() again while already running is a no-op; call stop() first. A check still
   * in flight from before a stop() is joined rather than duplicated.
   */
  start(): void;
  /**
   * Cancels every pending check and aborts every check currently in flight, through the AbortSignal
   * passed to the checker, so a slow or hanging provider never makes shutdown wait for it. An aborted
   * check neither changes state nor records a latency sample -- it is dropped, not counted as a
   * failure. Nothing is scheduled again until the next start().
   */
  stop(): void;
  /**
   * Runs one check for `id` right away, unless one is already in flight for it, in which case it waits
   * for that one instead (checks never overlap for the same provider). Resolves once the check has
   * settled, or immediately when `id` is not monitored. Never rejects.
   */
  checkNow(id: ProviderId): Promise<void>;
  /**
   * Feeds one latency sample observed outside a health check (the proxy's real traffic). Never changes
   * state. A sample that is not a finite, non-negative number is ignored.
   */
  recordLatency(id: ProviderId, ms: number): void;
  /** Current state, latency percentiles and sample count for every monitored provider. */
  snapshot(): HealthMonitorSnapshot;
}

interface ProviderRuntime {
  readonly adapter: ProviderAdapter;
  state: ProviderHealthState;
  lastErrorKind: ProviderErrorKind | null;
  lastCheckedAt: number | null;
  samples: number[];
  /** The check in flight for this provider, if any; a new request for a check joins it. */
  inFlight: Promise<void> | null;
  /** Aborts the check in flight, if any; stop() calls this so shutdown never waits for it. */
  abortController: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Nearest-rank percentile (no interpolation): the smallest sample such that at least `p`% of the
 * window is at or below it. `sorted` must already be ascending and non-empty.
 */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error('percentile() called with an empty sample window');
  return value;
}

function createRuntime(adapter: ProviderAdapter): ProviderRuntime {
  return {
    adapter,
    state: 'unknown',
    lastErrorKind: null,
    lastCheckedAt: null,
    samples: [],
    inFlight: null,
    abortController: null,
    timer: null,
  };
}

/** Builds the set of providers to track, one runtime per adapter id (first one wins on a duplicate id). */
function buildRuntimes(adapters: readonly ProviderAdapter[]): Map<ProviderId, ProviderRuntime> {
  const runtimes = new Map<ProviderId, ProviderRuntime>();
  for (const adapter of adapters) {
    if (!runtimes.has(adapter.id)) runtimes.set(adapter.id, createRuntime(adapter));
  }
  return runtimes;
}

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
  const env = options.env;
  const intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? Math.round(intervalMs * DEFAULT_JITTER_RATIO);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const checkProviderHealth: HealthChecker = options.checkProviderHealth ?? checkHealth;
  const logger = (options.logger ?? getLogger()).child({ component: 'health-monitor' });

  const runtimes = buildRuntimes(options.adapters);
  let running = false;
  /** Bumped by every start() and stop(); a check reschedules only under the generation it started in. */
  let generation = 0;

  function pushSample(runtime: ProviderRuntime, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    runtime.samples.push(ms);
    if (runtime.samples.length > windowSize) runtime.samples.shift();
  }

  function logTransition(
    id: ProviderId,
    from: ProviderHealthState,
    to: ProviderHealthState,
    errorKind: ProviderErrorKind | null,
  ): void {
    if (to === 'down') logger.warn('provider health transitioned to down', { provider: id, from, to, errorKind });
    else logger.info(`provider health transitioned to ${to}`, { provider: id, from, to });
  }

  function applyResult(runtime: ProviderRuntime, result: HealthResult, elapsedMs: number): void {
    if (result.ok) {
      runtime.state = 'up';
      runtime.lastErrorKind = null;
      pushSample(runtime, elapsedMs);
    } else {
      runtime.state = 'down';
      runtime.lastErrorKind = result.error.kind;
      // A timeout or a connection failure has no real round-trip time to record; only a genuine HTTP
      // answer (even an error one) carries a latency worth sampling.
      if (result.error.status !== null) pushSample(runtime, elapsedMs);
    }
  }

  async function performCheck(runtime: ProviderRuntime): Promise<void> {
    const previousState = runtime.state;
    const controller = new AbortController();
    runtime.abortController = controller;
    try {
      const started = now();
      const result = await checkProviderHealth(runtime.adapter, env, { timeoutMs, signal: controller.signal });
      // stop() aborted this check: it never counts as a result, up or down, and never touches state or
      // the latency window -- it is dropped, exactly as if it had never been started.
      if (controller.signal.aborted) return;
      applyResult(runtime, result, now() - started);
    } catch {
      if (controller.signal.aborted) return;
      // The checker itself failed (for example an adapter that throws while building the request). The
      // provider cannot be verified, so it is down with an 'unknown' kind. The exception text is
      // deliberately never logged: it could carry a URL or other request detail.
      runtime.state = 'down';
      runtime.lastErrorKind = 'unknown';
    } finally {
      if (runtime.abortController === controller) runtime.abortController = null;
    }
    runtime.lastCheckedAt = now();
    if (previousState !== runtime.state)
      logTransition(runtime.adapter.id, previousState, runtime.state, runtime.lastErrorKind);
  }

  /** Starts a check, or returns the one already in flight for this provider. Never rejects. */
  function runCheck(runtime: ProviderRuntime): Promise<void> {
    if (runtime.inFlight !== null) return runtime.inFlight;
    const check = performCheck(runtime).finally(() => {
      runtime.inFlight = null;
    });
    runtime.inFlight = check;
    return check;
  }

  function clearTimer(runtime: ProviderRuntime): void {
    if (runtime.timer !== null) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }

  function isCurrent(gen: number): boolean {
    return running && gen === generation;
  }

  /** Runs (or joins) a check, then schedules the next one if generation `gen` is still current. */
  function checkThenSchedule(runtime: ProviderRuntime, gen: number): void {
    void runCheck(runtime).then(() => scheduleNext(runtime, gen));
  }

  function scheduleNext(runtime: ProviderRuntime, gen: number): void {
    if (!isCurrent(gen)) return;
    clearTimer(runtime);
    const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
    const timer = setTimeout(() => {
      if (runtime.timer === timer) runtime.timer = null;
      if (!isCurrent(gen)) return;
      checkThenSchedule(runtime, gen);
    }, intervalMs + jitter);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
    runtime.timer = timer;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      generation += 1;
      const gen = generation;
      for (const runtime of runtimes.values()) checkThenSchedule(runtime, gen);
    },

    stop(): void {
      running = false;
      generation += 1;
      for (const runtime of runtimes.values()) {
        clearTimer(runtime);
        runtime.abortController?.abort();
      }
    },

    async checkNow(id: ProviderId): Promise<void> {
      const runtime = runtimes.get(id);
      if (runtime === undefined) return;
      await runCheck(runtime);
    },

    recordLatency(id: ProviderId, ms: number): void {
      const runtime = runtimes.get(id);
      if (runtime === undefined) return;
      pushSample(runtime, ms);
    },

    snapshot(): HealthMonitorSnapshot {
      const providers: ProviderHealthSnapshot[] = [];
      for (const runtime of runtimes.values()) {
        const sorted = [...runtime.samples].sort((a, b) => a - b);
        providers.push(
          Object.freeze({
            id: runtime.adapter.id,
            state: runtime.state,
            lastErrorKind: runtime.lastErrorKind,
            lastCheckedAt: runtime.lastCheckedAt,
            p50: sorted.length > 0 ? percentile(sorted, 50) : null,
            p95: sorted.length > 0 ? percentile(sorted, 95) : null,
            sampleCount: sorted.length,
          }),
        );
      }
      return Object.freeze({ providers: Object.freeze(providers) });
    },
  };
}
