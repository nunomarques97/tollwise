// `tollwise start`: load the configuration, protect the credentials, open the analytics database, listen,
// and stop cleanly on a signal.

import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { AnalyticsStoreError, type EventStore, openSqliteEventStore } from '../analytics/store.ts';
import { loadCatalog } from '../catalog/index.ts';
import { type Environment, loadConfig, readAccessKey } from '../config/load.ts';
import { isWildcardAddress } from '../config/network.ts';
import { type Config, defaultConfig, PROVIDER_IDS } from '../config/schema.ts';
import { createHealthMonitor } from '../health/monitor.ts';
import { createLogger, type Logger, type LogSink } from '../log/logger.ts';
import { registerSecretValues } from '../log/redact.ts';
import { buildRegistry } from '../providers/registry.ts';
import { onRequestOutcome } from '../proxy/outcome.ts';
import { baseUrl, createTollwiseServer, listen, stopServer } from './server.ts';

/** How long requests in flight may run after a stop signal before their connections are cut. */
export const DEFAULT_GRACE_MS = 10_000;

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** Where stop signals come from: `process` in production, any EventEmitter in tests. */
export interface SignalSource {
  on(event: StopSignal, listener: () => void): unknown;
  off(event: StopSignal, listener: () => void): unknown;
}

export interface StartOptions {
  /** Path given with `--config`. */
  readonly configPath?: string | undefined;
  /** Environment to read configuration and credentials from. Default: process.env. */
  readonly env?: Environment;
  /** Directory where ./tollwise.yaml is looked for. Default: process.cwd(). */
  readonly cwd?: string;
  /** Where log lines go. Default: process.stderr. */
  readonly logSink?: LogSink;
  /** Source of SIGINT/SIGTERM. Default: process. */
  readonly signals?: SignalSource;
  /** Grace period for requests in flight at stop. Default: DEFAULT_GRACE_MS. */
  readonly graceMs?: number;
}

export interface RunningTollwise {
  /** Base URL clients point their SDK at, e.g. http://127.0.0.1:8484. */
  readonly url: string;
  readonly address: AddressInfo;
  readonly logger: Logger;
  /** Stops the server; resolves when every connection has closed. Safe to call more than once. */
  stop(): Promise<void>;
  /** Resolves with the process exit code once the server has stopped (after a signal or stop()). */
  readonly stopped: Promise<number>;
}

/**
 * Thrown when the server cannot listen on the configured address, or the analytics database cannot be
 * opened. The message says what to do.
 */
export class StartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartError';
  }
}

/**
 * The credential values a running Tollwise holds: the value of every provider's `api_key_env` variable
 * (enabled or not) and TOLLWISE_ACCESS_KEY. Registered with the redaction registry so that no log line
 * can ever carry them, whatever their shape. Never log the returned values.
 */
export function credentialValues(config: Config, env: Environment): string[] {
  const values: string[] = [];
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    values.push(value);
    const trimmed = value.trim();
    if (trimmed !== value) values.push(trimmed);
  };
  for (const id of PROVIDER_IDS) {
    const name = config.providers[id].api_key_env;
    if (name !== null) add(env[name]);
  }
  add(readAccessKey(env));
  return values;
}

/**
 * The startup notice for a wildcard listening address (0.0.0.0, ::). Clients cannot use it as a host
 * name, and requests are only served when their Host names this server, so the names clients use must be
 * listed in server.allowed_hosts. Undefined for any other address.
 */
export function wildcardHostNotice(host: string, allowedHosts: readonly string[]): string | undefined {
  if (!isWildcardAddress(host)) return undefined;
  const listed = allowedHosts.length === 0 ? 'none are listed yet' : `listed now: ${allowedHosts.join(', ')}`;
  return (
    `Tollwise listens on every network interface (${host}), but only answers requests addressed to ` +
    `127.0.0.1, localhost, [::1] or a host in server.allowed_hosts (${listed}). ` +
    'List in server.allowed_hosts the host names or IP addresses other machines use to reach this one.'
  );
}

function listenFailure(error: unknown, host: string, port: number): StartError {
  const code = (error as { code?: unknown } | null)?.code;
  const where = baseUrl(host, port);
  switch (code) {
    case 'EADDRINUSE':
      return new StartError(
        `cannot listen on ${where}: the port is already in use. Fix: stop the other program, or set TOLLWISE_PORT (or server.port) to a free port.`,
      );
    case 'EACCES':
      return new StartError(
        `cannot listen on ${where}: permission denied. Fix: use a port above 1023 in TOLLWISE_PORT (or server.port).`,
      );
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return new StartError(
        `cannot listen on ${where}: the address is not available on this machine. Fix: set TOLLWISE_HOST (or server.host) to 127.0.0.1.`,
      );
    default:
      return new StartError(`cannot listen on ${where} (${typeof code === 'string' ? code : 'unknown error'}).`);
  }
}

/** Opens the analytics database, turning a failure into a StartError that says what to do. */
function openAnalytics(file: string, logger: Logger): EventStore {
  try {
    return openSqliteEventStore({ file, logger });
  } catch (error) {
    if (error instanceof AnalyticsStoreError) throw new StartError(error.message);
    throw error;
  }
}

/**
 * Starts Tollwise. Throws ConfigError when the configuration is invalid and StartError when the address
 * cannot be bound or the analytics database cannot be opened; otherwise resolves once the server is listening and the ready line is logged.
 */
export async function startTollwise(options: StartOptions = {}): Promise<RunningTollwise> {
  const env = options.env ?? process.env;
  // The keys under their default variable names are protected before the configuration is even read,
  // so nothing printed while loading it can carry them.
  registerSecretValues(credentialValues(defaultConfig(), env));
  const loaded = loadConfig({
    configPath: options.configPath,
    env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  const { config } = loaded;
  registerSecretValues(credentialValues(config, env));

  const logger = createLogger({
    level: config.logging.level,
    env,
    ...(options.logSink ? { sink: options.logSink } : {}),
  });
  const registry = buildRegistry(config, env);
  // Read and validated once, before listening: an invalid catalog stops the start with every problem listed.
  const catalog = loadCatalog();
  const healthMonitor = createHealthMonitor({ adapters: registry.enabled, env, logger });
  // Opened before listening, so a database that cannot be used stops the start with what to do about it.
  // Relative paths resolve against the directory Tollwise is started from, like the configuration file.
  const analyticsFile = config.analytics.enabled
    ? path.resolve(options.cwd ?? process.cwd(), config.analytics.path)
    : undefined;
  const analytics = analyticsFile === undefined ? undefined : openAnalytics(analyticsFile, logger);
  // Outcomes are emitted once a response has ended; the store only queues them and writes on a later
  // turn, and a failed write is contained there (see src/analytics/store.ts).
  const detachAnalytics = analytics === undefined ? () => {} : onRequestOutcome((outcome) => analytics.record(outcome));
  const closeAnalytics = async (): Promise<void> => {
    detachAnalytics();
    await analytics?.close();
  };
  // loadConfig() has already refused a non-loopback host without an access key, and a key that is too short.
  const server = createTollwiseServer({
    maxBodyBytes: config.server.max_body_size,
    logger,
    healthMonitor,
    accessKey: readAccessKey(env),
    allowedHosts: config.server.allowed_hosts,
    listenHost: config.server.host,
    proxy: { config, catalog, registry, env },
    ...(analytics !== undefined ? { analytics } : {}),
  });

  let address: AddressInfo;
  try {
    address = await listen(server, config.server.host, config.server.port);
  } catch (error) {
    await closeAnalytics();
    throw listenFailure(error, config.server.host, config.server.port);
  }
  const url = baseUrl(config.server.host, address.port);
  // Health checks only ever start once Tollwise itself is reachable.
  healthMonitor.start();

  const signals = options.signals ?? process;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let stopping: Promise<void> | undefined;
  let resolveStopped: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => {
    resolveStopped = resolve;
  });

  const detachSignals = (): void => {
    for (const signal of STOP_SIGNALS) signals.off(signal, handlers[signal]);
  };
  const stop = (reason: string): Promise<void> => {
    if (stopping !== undefined) {
      // A second signal while draining: cut the remaining connections now.
      server.closeAllConnections();
      return stopping;
    }
    logger.info('Tollwise is stopping', { reason });
    // Stopped first, and synchronously, so no new check schedules while connections drain.
    healthMonitor.stop();
    // The database closes once every connection has, so the outcomes of requests that finish while
    // draining are still written.
    stopping = stopServer(server, graceMs).then(async () => {
      detachSignals();
      await closeAnalytics();
      logger.info('Tollwise stopped');
      resolveStopped(0);
    });
    return stopping;
  };
  const handlers: Record<StopSignal, () => void> = {
    SIGINT: () => void stop('SIGINT'),
    SIGTERM: () => void stop('SIGTERM'),
  };
  for (const signal of STOP_SIGNALS) signals.on(signal, handlers[signal]);

  server.on('error', (error: Error) => {
    logger.error('server error', { error: error.name, code: (error as { code?: string }).code ?? 'unknown' });
  });

  logger.info(`Tollwise is ready on ${url}`, {
    url,
    access: loaded.accessKeySet ? 'key required' : 'no key',
    analytics: analyticsFile ?? 'off',
  });
  const notice = wildcardHostNotice(config.server.host, config.server.allowed_hosts);
  if (notice !== undefined) logger.warn(notice);
  return { url, address, logger, stop: () => stop('stop requested'), stopped };
}
