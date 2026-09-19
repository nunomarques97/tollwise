// The forwarding flow shared by every chat endpoint: /v1/chat/completions and /v1/messages (./chat.ts). An
// endpoint describes its API format in a ProxyProtocol (./openai.ts, ./anthropic.ts: error shape, required
// headers, usage report); everything else happens here, the same way for both.
//
// Flow, for one request:
// 1. Check the headers the API format requires (e.g. anthropic-version), then read the body under
//    server.max_body_size (a larger one is answered 413 by the server).
// 2. Parse it as JSON and inspect it: the capabilities it uses (tools, JSON mode, vision), its size and
//    the model it asks for. A body that is not JSON, not an object or has no model is answered 400.
// 3. Read the per-request overrides, x-tollwise-policy and x-tollwise-provider. A value that is not a
//    policy or a provider id is answered 400.
// 4. Select where the request goes (src/routing/select.ts). A provider that speaks the other API format
//    is a candidate when the request can be translated to that format without losing anything (see
//    untranslatable() in src/translate); otherwise it is excluded with the reason untranslatable:<code>.
//    A request no provider can serve is answered 422, naming what is missing, or passed through unchanged
//    to the requested model, per routing.on_no_candidate.
// 5. For a provider of the endpoint's format, rewrite only the model field of the body (every other byte
//    is sent as received), plus the fields the protocol asks for (see ProxyProtocol.plan). For a provider
//    of the other format, send the request translated to that format (./cross-format.ts).
// 6. Fall back while nothing has reached the client. When an attempt fails before the provider's response
//    head arrived (no connection, a timeout from routing.timeouts, HTTP 429, a 5xx, or an overloaded
//    status such as 529), the request goes to the next candidate, in the order routing ranked them, for
//    at most routing.retries extra attempts; each attempt has its own routing.timeouts. A provider that
//    rejects the request itself (400, 401, 402, 403, 404, 422 and every other status that is not retried)
//    is answered at once, with its status, in the endpoint's error shape: another provider would judge the
//    request the same way. Once a provider's 2xx response head has arrived the response is committed:
//    a body that fails after that, streamed or not, is cut for the client and never retried elsewhere.
//    When every attempt fails, the answer is 502, code all_providers_failed, listing each provider tried
//    with its error kind and HTTP status (never a provider's message).
// 7. Return the provider's status and body unchanged, as it arrives (or, from a provider of the other
//    format, translated back to the endpoint's format; see below), with these headers added:
//      x-tollwise-request-id  a new id for this request (also sent with every error)
//      x-tollwise-provider    the provider that served the request (the last one tried, on a failure)
//      x-tollwise-model       the model id sent to it (percent-encoded if it is not printable ASCII)
//      x-tollwise-policy      the routing policy applied
//      x-tollwise-routed      true when routing chose the target, false for a passthrough
//      x-tollwise-attempts    how many providers were called for this request, this one included
//      x-tollwise-translated  true when the provider speaks the other format and the request and its
//                             answer were translated, false otherwise
//      x-tollwise-requested-model     the model id the client asked for (encoded like x-tollwise-model)
//      x-tollwise-substituted         true when that provider serves another model than the one asked
//                                     for, allowed by an equivalence group; false otherwise
//      x-tollwise-equivalence-group   only when substituted: the name of that group (percent-encoded if
//                                     it is not printable ASCII)
//    A request refused after routing (step 4) carries x-tollwise-request-id, -policy, -routed (false),
//    -requested-model and -substituted (false).
//    Errors, Tollwise's own and a provider's, are answered in the endpoint's error shape; a provider error
//    that is not retried keeps the provider's HTTP status.
//    A served non-streamed answer also carries its cost (x-tollwise-cost-usd, x-tollwise-savings-usd,
//    x-tollwise-cost-origin, x-tollwise-price-verified-on; see ./outcome.ts), so it is held back until it
//    has been read in full, up to MAX_USAGE_BODY_BYTES; a larger one is forwarded as it arrives, without
//    them. A streamed answer never carries them: its head leaves before its usage is known.
//
// Every request that reaches step 4 also ends with one RequestOutcome event (./outcome.ts).
//
// Routing trace: every attempt is recorded as { provider, model, outcome, status, duration_ms,
// substitution }, where outcome is "ok", "client_aborted" or the provider error kind (see
// ProviderErrorKind), status the HTTP status (null without an HTTP answer), duration_ms the time until
// the response head or the failure, and substitution null when the attempt sent the requested model (on
// any provider), else { requested_model, served_model, group }. The trace carries no URL, header or body,
// and its model ids are masked like a log line. It is handed
// to ProxySettings.onRequestResult and logged (info) when the request needed more than one attempt or did
// not complete. Each attempt with a round trip (an HTTP answer, or a timeout) feeds its duration to the
// health monitor's latency window; a connection failure has none.
//
// A streamed response (`"stream": true` and an event-stream answer) is relayed event by event as it
// arrives, never re-serialised, and the headers above leave with the response head, before the first
// event. The client going away aborts the provider call. A provider body that stops early is cut short
// for the client too: nothing is made up.
//
// A translated answer is never passed on in part. A non-streamed one is read whole and translated before
// anything is sent; one that cannot be translated faithfully is answered 502, code
// response_not_translatable, naming only the translation problem codes. A streamed one is translated event
// by event as it arrives; a problem mid-stream ends the client's stream with one error event in its format.
// Usage is read from the provider's answer in the provider's own format, streamed or not.
//
// Every request sent to a provider ends with one ProxyRequestResult (ProxySettings.onRequestResult),
// carrying the routing trace and the usage the provider reported, or null when it reported none.
//
// Nothing here logs a header, a body or a key: a log line carries at most the request id, the decision,
// the policy, provider ids, error kinds, statuses, durations and the (masked) model ids of the trace.

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { ModelEntry } from '../catalog/schema.ts';
import type { Config, ProviderId, RoutingPolicy } from '../config/schema.ts';
import { PROVIDER_IDS, ROUTING_POLICIES } from '../config/schema.ts';
import { redactText } from '../log/redact.ts';
import { selectBaselineEntry } from '../pricing/cost.ts';
import type { ProviderAdapter, ProviderError, ProviderErrorKind, WireFormat } from '../providers/types.ts';
import { type Inspection, InspectionError, inspect } from '../routing/inspect.ts';
import { nativeProvider, type Selection, type SelectOverrides, select } from '../routing/select.ts';
import { readBody } from '../server/body.ts';
import type { ErrorType, ErrorWriter } from '../server/respond.ts';
import type { RouteContext } from '../server/router.ts';
import { TranslationError, type UntranslatableCode, untranslatable } from '../translate/index.ts';
import {
  clientWantsStreamUsage,
  EVENT_STREAM_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  StreamTranslator,
  TRANSLATED_DROPPED_HEADERS,
  TranslatedBodyCollector,
  translateRequest,
  translateResponseBody,
} from './cross-format.ts';
import {
  buildRequestOutcome,
  costResponseHeaders,
  emitRequestOutcome,
  maskSubstitution,
  type OutcomeDecision,
  outcomePrice,
  outcomeSelection,
  resolveUsageAndCost,
} from './outcome.ts';
import { type BodyScanner, relayBody, type SseEvent, SseScanner, type SseVerdict } from './sse.ts';
import { callUpstream, type UpstreamResult } from './upstream.ts';

export const POLICY_HEADER = 'x-tollwise-policy';
export const PROVIDER_HEADER = 'x-tollwise-provider';

/** The response headers every proxied answer carries (names are lower case). */
export const TOLLWISE_HEADERS = {
  requestId: 'x-tollwise-request-id',
  provider: 'x-tollwise-provider',
  model: 'x-tollwise-model',
  policy: 'x-tollwise-policy',
  routed: 'x-tollwise-routed',
  attempts: 'x-tollwise-attempts',
  translated: 'x-tollwise-translated',
  requestedModel: 'x-tollwise-requested-model',
  substituted: 'x-tollwise-substituted',
  /** Only on a substituted answer. */
  equivalenceGroup: 'x-tollwise-equivalence-group',
} as const;

/**
 * Provider error kinds that move a request on to the next candidate: the provider could not take the
 * request right now (unreachable, too slow, rate limited, failing or overloaded), so another may well.
 */
export const RETRYABLE_ERROR_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'connection',
  'timeout',
  'rate_limit',
  'server',
  'overloaded',
]);

/** Response headers from a provider that start with this prefix are dropped: only Tollwise sets them. */
const TOLLWISE_HEADER_PREFIX = 'x-tollwise-';

export const PROXY_NOT_CONFIGURED_MESSAGE =
  'Tollwise has no provider configuration loaded, so it cannot route requests.';

const INVALID_JSON_MESSAGE = 'The request body is not valid JSON.';

/** A request-level problem answered before any provider is called. */
export interface Refusal {
  readonly status: number;
  readonly type: ErrorType;
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------- the protocol an endpoint speaks

/** Watches the events of one streamed response go by. */
export interface StreamWatch {
  /** Hold each event until it ends, so onEvent may drop it; otherwise every byte is forwarded at once. */
  readonly hold: boolean;
  onEvent(event: SseEvent): SseVerdict;
  /** The usage the stream reported so far; null when none. */
  usage(): ReportedUsage | null;
}

/** What changes in one outbound request besides the model id. */
export interface OutboundPlan {
  /** Top-level body fields to set, name to the JSON text of the new value. */
  readonly edits: Readonly<Record<string, string>>;
  /** Builds the watcher for a streamed response. */
  watchStream(): StreamWatch;
}

/** What one endpoint's API format adds to the shared flow. */
export interface ProxyProtocol {
  /** The format requests arrive in; providers speaking the other one are reached through translation. */
  readonly format: WireFormat;
  /** Human name of the format, used in error messages (e.g. "OpenAI Chat Completions"). */
  readonly apiName: string;
  /** First word of this endpoint's log lines (e.g. "chat"). */
  readonly logLabel: string;
  /** Writes an error in this format's shape. */
  readonly sendError: ErrorWriter;
  /** Header checks run before the body is read; a refusal is answered at once. */
  checkHeaders(headers: IncomingHttpHeaders): Refusal | undefined;
  /** The extra body edits and the stream watcher for one request. */
  plan(body: Record<string, unknown>, stream: boolean): OutboundPlan;
  /** Reads the usage report of a complete (non-streamed) response body. */
  readBodyUsage(body: unknown): ReportedUsage | null;
}

/** The protocol of each API format: the endpoint's own, and the one a translated request is sent in. */
export type ProxyProtocols = Readonly<Record<WireFormat, ProxyProtocol>>;

// ---------------------------------------------------------------- overrides

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.join(', ') : value).trim();
}

/**
 * Reads the per-request routing overrides from the request headers. Values are compared after trimming,
 * in any letter case. A refusal never repeats the value the client sent, only the accepted ones.
 */
export function readOverrides(
  headers: IncomingHttpHeaders,
  routing: Pick<Config['routing'], 'pinned'>,
): { readonly overrides: SelectOverrides } | { readonly refusal: Refusal } {
  let policy: RoutingPolicy | undefined;
  let provider: ProviderId | undefined;

  const policyText = headerText(headers[POLICY_HEADER])?.toLowerCase();
  if (policyText !== undefined) {
    policy = ROUTING_POLICIES.find((candidate) => candidate === policyText);
    if (policy === undefined) {
      return {
        refusal: {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_routing_policy',
          message: `The ${POLICY_HEADER} header must be one of: ${ROUTING_POLICIES.join(', ')}.`,
        },
      };
    }
    if (policy === 'pinned' && routing.pinned === undefined) {
      return {
        refusal: {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_routing_policy',
          message: `The ${POLICY_HEADER} header asks for the pinned policy, but routing.pinned is not set in the configuration.`,
        },
      };
    }
  }

  const providerText = headerText(headers[PROVIDER_HEADER])?.toLowerCase();
  if (providerText !== undefined) {
    provider = PROVIDER_IDS.find((candidate) => candidate === providerText);
    if (provider === undefined) {
      return {
        refusal: {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_provider',
          message: `The ${PROVIDER_HEADER} header must be one of: ${PROVIDER_IDS.join(', ')}.`,
        },
      };
    }
  }

  return { overrides: { policy, provider } };
}

// ---------------------------------------------------------------- body rewrite

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function skipWhitespace(text: string, index: number): number {
  let at = index;
  while (isJsonWhitespace(text[at])) at += 1;
  return at;
}

/** Index just past the JSON string starting at `index` (which holds its opening quote). */
function endOfString(text: string, index: number): number {
  let at = index + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') at += 2;
    else if (char === '"') return at + 1;
    else at += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

/** Index just past the JSON value starting at `index`. */
function endOfValue(text: string, index: number): number {
  const first = text[index];
  if (first === '"') return endOfString(text, index);
  if (first === '{' || first === '[') {
    let depth = 0;
    let at = index;
    while (at < text.length) {
      const char = text[at];
      if (char === '"') {
        at = endOfString(text, at);
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
      at += 1;
    }
    throw new SyntaxError('unterminated JSON value');
  }
  let at = index;
  while (at < text.length && !isJsonWhitespace(text[at]) && text[at] !== ',' && text[at] !== '}') at += 1;
  return at;
}

/**
 * Sets top-level fields of a JSON object text, leaving every other character exactly as it was (field
 * order, spacing, number formatting, escapes). `values` maps a field name to the JSON text of its new
 * value. Every top-level occurrence of a field is replaced (key names are compared after unescaping); a
 * field that does not occur is appended after the last one. `text` must be valid JSON whose top level is
 * an object; throws SyntaxError otherwise.
 */
export function setTopLevelFields(text: string, values: Readonly<Record<string, string>>): string {
  const spans: [number, number, string][] = [];
  const seen = new Set<string>();
  let at = skipWhitespace(text, 0);
  if (text[at] !== '{') throw new SyntaxError('the JSON text is not an object');
  let lastValueEnd = at + 1;
  let fields = 0;
  at = skipWhitespace(text, at + 1);
  while (text[at] === '"') {
    const keyEnd = endOfString(text, at);
    const key: unknown = JSON.parse(text.slice(at, keyEnd));
    at = skipWhitespace(text, keyEnd);
    if (text[at] !== ':') throw new SyntaxError('expected ":" after an object key');
    at = skipWhitespace(text, at + 1);
    const valueEnd = endOfValue(text, at);
    if (typeof key === 'string' && Object.hasOwn(values, key)) {
      spans.push([at, valueEnd, values[key] as string]);
      seen.add(key);
    }
    fields += 1;
    lastValueEnd = valueEnd;
    at = skipWhitespace(text, valueEnd);
    if (text[at] !== ',') break;
    at = skipWhitespace(text, at + 1);
  }
  if (text[at] !== '}') throw new SyntaxError('malformed JSON object');

  let appended = '';
  for (const [name, value] of Object.entries(values)) {
    if (seen.has(name)) continue;
    appended += `${fields > 0 ? ',' : ''}${JSON.stringify(name)}:${value}`;
    fields += 1;
  }
  if (appended !== '') spans.push([lastValueEnd, lastValueEnd, appended]);

  let result = '';
  let copied = 0;
  for (const [start, end, replacement] of spans) {
    result += text.slice(copied, start) + replacement;
    copied = end;
  }
  return result + text.slice(copied);
}

/**
 * Replaces the value of every top-level "model" field of a JSON object text with `model`, leaving every
 * other character exactly as it was. `text` must be valid JSON whose top level is an object.
 */
export function replaceModelField(text: string, model: string): string {
  return setTopLevelFields(text, { model: JSON.stringify(model) });
}

// ---------------------------------------------------------------- usage

/** Token counts a provider reported for one request. */
export interface ReportedUsage {
  /** Input (prompt) tokens, cached ones included. */
  readonly input: number;
  /** The part of `input` served from the provider's prompt cache; null when the provider did not say. */
  readonly cachedInput: number | null;
  /** Output (completion) tokens. */
  readonly output: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A token count: a non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Largest non-streamed response body held back and read for its usage report, in bytes. A larger one
 * is forwarded as it arrives, without cost headers (see BufferedJsonBody).
 */
export const MAX_USAGE_BODY_BYTES = 1024 * 1024;

/**
 * Holds a non-streamed JSON body until it has been read in full, instead of forwarding it as it
 * arrives: its cost (see resolveUsageAndCost()) is only known once the whole body -- and so the
 * usage it reports -- has been read, and that must be set as a response header before any byte
 * leaves. Memory is bounded: once the body grows past MAX_USAGE_BODY_BYTES, `release` is called
 * (it sends the response head, without cost headers), the bytes held so far are forwarded, and
 * every later byte is forwarded as it arrives. Such a body's usage is not read (usage() is null).
 */
class BufferedJsonBody implements BodyScanner {
  private held: Buffer[] = [];
  private size = 0;
  private released = false;
  private readonly readUsage: (body: unknown) => ReportedUsage | null;
  private readonly release: () => void;

  constructor(readUsage: (body: unknown) => ReportedUsage | null, release: () => void) {
    this.readUsage = readUsage;
    this.release = release;
  }

  /** True once the body outgrew MAX_USAGE_BODY_BYTES and started being forwarded as it arrives. */
  get overflowed(): boolean {
    return this.released;
  }

  scan(chunk: Buffer, out: Buffer[]): void {
    if (this.released) {
      out.push(chunk);
      return;
    }
    this.held.push(chunk);
    this.size += chunk.length;
    if (this.size > MAX_USAGE_BODY_BYTES) {
      this.released = true;
      this.release();
      out.push(...this.held);
      this.held = [];
    }
  }

  end(): void {}

  /** Every byte held back, concatenated. Call only once the source has ended without overflowing. */
  body(): Buffer {
    return Buffer.concat(this.held, this.size);
  }

  usage(): ReportedUsage | null {
    if (this.released) return null;
    try {
      return this.readUsage(JSON.parse(Buffer.concat(this.held, this.size).toString('utf8')));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- responses

/**
 * A header-safe form of a value Tollwise does not control (a model id from the client, a group name from
 * the configuration): as is when printable ASCII, percent-encoded otherwise, so a CR, LF or other control
 * character can never start a header line of its own.
 */
export function headerSafeValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : encodeURIComponent(value);
}

/** A header-safe form of a model id; see headerSafeValue(). */
export function modelHeaderValue(model: string): string {
  return headerSafeValue(model);
}

/** The error type for a provider failure. */
function providerErrorType(error: ProviderError): ErrorType {
  switch (error.kind) {
    case 'bad_request':
      return 'invalid_request_error';
    case 'auth':
      return error.status === 403 ? 'permission_error' : 'authentication_error';
    case 'rate_limit':
      return 'rate_limit_error';
    default:
      return 'server_error';
  }
}

/** The status a provider failure is answered with: the provider's own, else 504 (timeout) or 502. */
export function providerErrorStatus(error: ProviderError): number {
  if (error.status !== null && error.status >= 400 && error.status <= 599) return error.status;
  return error.kind === 'timeout' ? 504 : 502;
}

function providerErrorMessage(provider: ProviderId, error: ProviderError): string {
  if (error.kind === 'timeout' && error.status === null) {
    return `The ${provider} provider did not answer in time (routing.timeouts).`;
  }
  if (error.kind === 'connection' && error.status === null) {
    return `Tollwise could not reach the ${provider} provider.`;
  }
  const detail = error.message === undefined ? '' : `: ${error.message}`;
  if (error.status === null) return `The call to the ${provider} provider failed${detail}`;
  return `The ${provider} provider answered with HTTP ${error.status}${detail}`;
}

// ---------------------------------------------------------------- the flow

/**
 * What happened to one request that was sent to a provider, handed to ProxySettings.onRequestResult once
 * the response is over. Metadata only: never a header, a body or a key.
 */
export interface ProxyRequestResult {
  readonly requestId: string;
  readonly provider: ProviderId;
  /** The model id sent to the provider. */
  readonly model: string;
  /** True when the client asked for a stream. */
  readonly stream: boolean;
  /** True when the provider speaks the other API format, so the request and its answer were translated. */
  readonly translated: boolean;
  /** The HTTP status sent to the client; null when the client went away before any response. */
  readonly status: number | null;
  /**
   * complete: the whole response was relayed. provider_error: the provider failed before answering, and an
   * error was sent. interrupted: the provider's body stopped early, and the response was cut.
   * client_aborted: the client went away, and the provider call was aborted. translation_failed: the
   * provider answered, but its answer could not be translated to the client's format; an error was sent
   * (for a stream, as the last event).
   */
  readonly outcome: 'complete' | 'provider_error' | 'interrupted' | 'client_aborted' | 'translation_failed';
  /** The usage the provider reported; null when it reported none (or the response ended before it did). */
  readonly usage: ReportedUsage | null;
  /** The routing trace: every provider called for this request, in order; the last one is `provider`. */
  readonly attempts: readonly AttemptRecord[];
}

/** How one attempt ended: served, the client went away, or the provider failed with this error kind. */
export type AttemptOutcome = 'ok' | 'client_aborted' | ProviderErrorKind;

/** One provider call of a request, in the routing trace. Metadata only: no URL, header or body. */
export type AttemptRecord = {
  readonly provider: ProviderId;
  /** The model id sent, masked like a log line. */
  readonly model: string;
  readonly outcome: AttemptOutcome;
  /** The HTTP status the provider answered with; null when there was no HTTP answer. */
  readonly status: number | null;
  /** Milliseconds from the start of the call until the response head or the failure. */
  readonly duration_ms: number;
  /** Null when the attempt sent the requested model (on any provider); see ModelSubstitution. */
  readonly substitution: ModelSubstitution | null;
};

/**
 * Another model sent in place of the one requested, which only an equivalence group turned on in the
 * configuration allows. Both model ids are masked like a log line; `group` is the group's name, from
 * the configuration (a preset's name for a preset).
 */
export type ModelSubstitution = {
  /** The model id the client asked for. */
  readonly requested_model: string;
  /** The model id sent to the provider. */
  readonly served_model: string;
  readonly group: string;
};

interface Target {
  readonly adapter: ProviderAdapter;
  readonly model: string;
  readonly routed: boolean;
  /** The provider speaks the other API format: the request and its answer are translated. */
  readonly translated: boolean;
  /** The catalog entry this target bills on; null when the provider/model pair is not in the catalog. */
  readonly entry: ModelEntry | null;
  /** Null when the target serves the requested model; else the substitution, model ids not yet masked. */
  readonly substitution: ModelSubstitution | null;
}

/**
 * The providers and models to try for a selection, in order, or the refusal when none can be called.
 * A routed selection keeps every candidate whose provider is configured and either speaks the endpoint's
 * format or can take the request translated (select() already excluded the others; checked again here
 * because this is where the request is sent). A passthrough has exactly one target.
 */
function resolveTargets(
  selection: Selection,
  context: RouteContext,
  protocol: ProxyProtocol,
  protocols: ProxyProtocols,
  lossFor: (format: WireFormat) => readonly UntranslatableCode[],
): { readonly targets: readonly Target[] } | { readonly refusal: Refusal } {
  const registry = context.proxy?.registry;
  if (selection.decision === 'fail') {
    return {
      refusal: {
        status: 422,
        type: 'invalid_request_error',
        code: selection.cause === 'not_in_catalog' ? 'model_not_in_catalog' : 'no_capable_provider',
        message: `Tollwise cannot route this request: ${selection.message}.`,
      },
    };
  }
  const routed = selection.decision === 'routed';
  const targets: Target[] = [];
  for (const candidate of selection.candidates) {
    const adapter = registry?.get(candidate.provider);
    if (adapter === undefined) continue;
    const translated = adapter.wireFormat !== protocol.format;
    if (!translated || lossFor(adapter.wireFormat).length === 0) {
      const substitution =
        candidate.substitution === null
          ? null
          : {
              requested_model: selection.trace.requested.model,
              served_model: candidate.model,
              group: candidate.substitution.group,
            };
      targets.push({ adapter, model: candidate.model, routed, translated, entry: candidate.entry, substitution });
    }
  }
  if (targets.length > 0) return { targets };

  const [first] = selection.candidates;
  const adapter = first === undefined ? undefined : registry?.get(first.provider);
  if (first === undefined || adapter === undefined) {
    const provider = first?.provider ?? 'the passthrough provider';
    return {
      refusal: {
        status: 422,
        type: 'invalid_request_error',
        code: 'provider_not_configured',
        message:
          `Tollwise cannot route this request: no catalog entry can serve it, and the request would pass through ` +
          `to ${provider}, which is not configured (disabled or its key is not set).`,
      },
    };
  }
  return {
    refusal: {
      status: 422,
      type: 'invalid_request_error',
      code: 'format_not_supported',
      message:
        `Tollwise cannot route this request: no catalog entry can serve it, and the request would pass through ` +
        `to ${adapter.id}, which speaks the ${protocols[adapter.wireFormat].apiName} format; the request uses ` +
        `features that cannot be translated to it: ${lossFor(adapter.wireFormat).join(', ')}.`,
    },
  };
}

/** Lists the failed attempts for the all-attempts-failed message: provider, error kind and HTTP status only. */
function describeFailures(attempts: readonly AttemptRecord[]): string {
  return attempts
    .map(
      (attempt) =>
        `${attempt.provider} model ${attempt.model} (${attempt.outcome}${attempt.status === null ? '' : `, HTTP ${attempt.status}`})`,
    )
    .join(', ');
}

/**
 * Routes one chat request of `protocol`'s format to the providers chosen for it and relays the answer.
 * `protocols` holds the protocol of each format: a request sent to a provider of the other format is
 * written, and its answer read, with that format's protocol.
 */
export async function forwardRequest(
  context: RouteContext,
  protocol: ProxyProtocol,
  protocols: ProxyProtocols,
): Promise<void> {
  const { req, res, proxy, logger } = context;
  const requestStarted = performance.now();
  const requestId = randomUUID();
  const label = protocol.logLabel;
  const refuse = (refusal: Refusal, headers: Record<string, string> = {}): void => {
    protocol.sendError(res, refusal.status, refusal.type, refusal.code, refusal.message, {
      headers: { [TOLLWISE_HEADERS.requestId]: requestId, ...headers },
    });
  };

  if (proxy === undefined) {
    refuse({ status: 503, type: 'server_error', code: 'proxy_not_configured', message: PROXY_NOT_CONFIGURED_MESSAGE });
    return;
  }
  const headerRefusal = protocol.checkHeaders(req.headers);
  if (headerRefusal !== undefined) {
    refuse(headerRefusal);
    return;
  }

  const raw = await readBody(req, context.maxBodyBytes);
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    refuse({ status: 400, type: 'invalid_request_error', code: 'invalid_json', message: INVALID_JSON_MESSAGE });
    return;
  }

  let inspection: Inspection;
  try {
    inspection = inspect(protocol.format, body);
  } catch (error) {
    if (!(error instanceof InspectionError)) throw error;
    refuse({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
      message: `Invalid request: ${error.message}.`,
    });
    return;
  }
  const read = readOverrides(req.headers, proxy.config.routing);
  if ('refusal' in read) {
    refuse(read.refusal);
    return;
  }

  // What a translation to each other format would lose, worked out once per format. An Anthropic request
  // that enables a beta feature (anthropic-beta) is never translated: the feature would be dropped.
  const anthropicBeta = protocol.format === 'anthropic' ? headerText(req.headers['anthropic-beta']) : undefined;
  const losses = new Map<WireFormat, readonly UntranslatableCode[]>();
  const lossFor = (format: WireFormat): readonly UntranslatableCode[] => {
    let codes = losses.get(format);
    if (codes === undefined) {
      codes = untranslatable(body, format, { anthropicBeta });
      losses.set(format, codes);
    }
    return codes;
  };
  const selection = select({
    inspection,
    catalog: proxy.catalog,
    registry: proxy.registry,
    health: context.healthMonitor?.snapshot() ?? { providers: [] },
    routing: proxy.config.routing,
    overrides: read.overrides,
    untranslatable: lossFor,
  });
  const policy = selection.trace.policy;
  // Independent of which target ends up serving the request: the catalog price of the model the
  // client actually asked for, and where that price is from -- see selectBaselineEntry().
  const baselineEntry = selectBaselineEntry(proxy.catalog, inspection.requestedModel, protocol.format);
  const requestedProvider = baselineEntry?.provider ?? nativeProvider(protocol.format);
  // What routing chose from, and the requested model's catalog price, copied now: a stored outcome
  // keeps the catalog as it was when this request was routed.
  const routedFrom = outcomeSelection(selection);
  const requestedPrice = outcomePrice(baselineEntry);
  const resolved = resolveTargets(selection, context, protocol, protocols, lossFor);
  if ('refusal' in resolved) {
    logger.debug(`${label} request not routed`, { requestId, decision: selection.decision, policy });
    refuse(resolved.refusal, {
      [TOLLWISE_HEADERS.policy]: policy,
      [TOLLWISE_HEADERS.routed]: 'false',
      [TOLLWISE_HEADERS.requestedModel]: modelHeaderValue(inspection.requestedModel),
      [TOLLWISE_HEADERS.substituted]: 'false',
    });
    // No provider was called: nothing was used, attempted or billed.
    emitRequestOutcome(
      buildRequestOutcome({
        timestamp: new Date().toISOString(),
        requestId,
        format: protocol.format,
        requestedModel: inspection.requestedModel,
        requestedProvider,
        usedModel: null,
        usedProvider: null,
        needs: inspection.needs,
        policy,
        decision: 'fail',
        attempts: 0,
        trace: [],
        usage: null,
        cost: null,
        latencyMs: Math.round(performance.now() - requestStarted),
        firstByteMs: null,
        status: 'refused',
        selection: routedFrom,
        price: { used: null, requested: requestedPrice },
        substitution: null,
      }),
    );
    return;
  }
  // The first target, plus up to routing.retries more, in the order routing ranked them.
  const targets = resolved.targets.slice(0, 1 + proxy.config.routing.retries);
  // resolveTargets() above turned a 'fail' selection into a refusal, so a request that gets here was
  // either routed or passed through.
  const decision: OutcomeDecision = selection.decision === 'routed' ? 'routed' : 'passthrough';
  logger.debug(`${label} request routed`, {
    requestId,
    decision: selection.decision,
    provider: targets[0]?.adapter.id,
    policy,
    candidates: targets.length,
    translated: targets[0]?.translated,
  });

  const attempts: AttemptRecord[] = [];
  const report = (target: Target, result: Outcome): void => {
    if (attempts.length > 1 || result.outcome !== 'complete') {
      logger.info(`${label} request attempts`, { requestId, outcome: result.outcome, attempts: [...attempts] });
    }
    const { usage, cost } = resolveUsageAndCost({
      reported: result.usage,
      complete: result.outcome === 'complete',
      estimatedInputTokens: inspection.estimatedInput.tokens,
      maxOutput: inspection.maxOutput,
      usedEntry: target.entry,
      baselineEntry,
    });
    const outcome = buildRequestOutcome({
      timestamp: new Date().toISOString(),
      requestId,
      format: protocol.format,
      requestedModel: inspection.requestedModel,
      requestedProvider,
      usedModel: target.model,
      usedProvider: target.adapter.id,
      needs: inspection.needs,
      policy,
      decision,
      attempts: attempts.length,
      trace: [...attempts],
      usage,
      cost,
      latencyMs: Math.round(performance.now() - requestStarted),
      firstByteMs: result.firstByteMs,
      status: result.outcome,
      selection: routedFrom,
      price: { used: outcomePrice(target.entry), requested: requestedPrice },
      substitution: target.substitution,
    });
    emitRequestOutcome(outcome);
    if (proxy.onRequestResult === undefined) return;
    try {
      proxy.onRequestResult({
        requestId,
        provider: target.adapter.id,
        model: target.model,
        stream: inspection.stream,
        translated: target.translated,
        attempts: [...attempts],
        status: result.status,
        outcome: result.outcome,
        usage: result.usage,
      });
    } catch {
      logger.warn('request result listener failed', { requestId });
    }
  };
  const headersFor = (target: Target): Record<string, string> => ({
    [TOLLWISE_HEADERS.requestId]: requestId,
    [TOLLWISE_HEADERS.provider]: target.adapter.id,
    [TOLLWISE_HEADERS.model]: modelHeaderValue(target.model),
    [TOLLWISE_HEADERS.policy]: policy,
    [TOLLWISE_HEADERS.routed]: String(target.routed),
    [TOLLWISE_HEADERS.attempts]: String(attempts.length),
    [TOLLWISE_HEADERS.translated]: String(target.translated),
    [TOLLWISE_HEADERS.requestedModel]: modelHeaderValue(inspection.requestedModel),
    [TOLLWISE_HEADERS.substituted]: String(target.substitution !== null),
    ...(target.substitution === null
      ? {}
      : { [TOLLWISE_HEADERS.equivalenceGroup]: headerSafeValue(target.substitution.group) }),
  });

  // Only the model field changes, plus the fields the protocol asks for; when none does, the body goes
  // out byte for byte as it came in. A request to a provider of the other format is translated as a
  // whole (never in part), then written and read with that format's protocol.
  const plan = protocol.plan(body as Record<string, unknown>, inspection.stream);
  const outboundFor = (target: Target): Outbound => {
    if (target.translated) {
      const translated = translateRequest(body, protocol.format, target.adapter, target.model, anthropicBeta);
      const providerPlan = protocols[target.adapter.wireFormat].plan(translated.body, inspection.stream);
      const json = JSON.stringify(translated.body);
      return {
        body: Object.keys(providerPlan.edits).length === 0 ? json : setTopLevelFields(json, providerPlan.edits),
        jsonMode: translated.jsonMode,
        plan: providerPlan,
      };
    }
    const edits: Record<string, string> = { ...plan.edits };
    if (target.model !== inspection.requestedModel) edits.model = JSON.stringify(target.model);
    return { body: Object.keys(edits).length === 0 ? raw : setTopLevelFields(text, edits), jsonMode: false, plan };
  };

  // The client going away aborts the provider call in flight, so the provider stops generating, and
  // no further candidate is tried.
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  for (const [index, target] of targets.entries()) {
    const provider = target.adapter.id;
    if (abort.signal.aborted) {
      res.destroy();
      report(target, { status: null, outcome: 'client_aborted', usage: null, firstByteMs: null });
      return;
    }
    const outbound = outboundFor(target);
    const started = performance.now();
    const result = await callUpstream({
      adapter: target.adapter,
      env: proxy.env,
      path: target.adapter.chatPath,
      body: outbound.body,
      clientHeaders: req.headers,
      timeouts: proxy.config.routing.timeouts,
      signal: abort.signal,
      logger,
    });
    const durationMs = Math.round(performance.now() - started);

    if (result.type === 'aborted') {
      attempts.push(attemptRecord(target, 'client_aborted', null, durationMs));
      res.destroy();
      report(target, { status: null, outcome: 'client_aborted', usage: null, firstByteMs: null });
      return;
    }

    if (result.type === 'error') {
      const error = result.error;
      attempts.push(attemptRecord(target, error.kind, error.status, durationMs));
      // A connection failure has no round trip worth sampling (it would make a dead provider look fast);
      // an HTTP answer has one, and a timeout is a real (lower bound of the) wait.
      if (error.status !== null || error.kind === 'timeout') context.healthMonitor?.recordLatency(provider, durationMs);
      if (RETRYABLE_ERROR_KINDS.has(error.kind)) {
        const next = targets[index + 1];
        if (next !== undefined) {
          logger.info(`${label} request falling back`, {
            requestId,
            provider,
            errorKind: error.kind,
            next: next.adapter.id,
          });
        }
        continue;
      }
      // The provider rejected the request itself or the credentials: retrying elsewhere would hide a problem
      // the caller has to fix, so the answer is returned now, in the client's format, with the provider's status.
      const status = providerErrorStatus(error);
      protocol.sendError(
        res,
        status,
        providerErrorType(error),
        `provider_${error.kind}`,
        providerErrorMessage(provider, error),
        { headers: headersFor(target) },
      );
      report(target, { status, outcome: 'provider_error', usage: null, firstByteMs: null });
      return;
    }

    attempts.push(attemptRecord(target, 'ok', result.status, durationMs));
    context.healthMonitor?.recordLatency(provider, durationMs);
    const reportOutcome = (outcome: Outcome): void => report(target, outcome);
    const costContext: RelayCostContext = {
      usedEntry: target.entry,
      baselineEntry,
      estimatedInputTokens: inspection.estimatedInput.tokens,
      maxOutput: inspection.maxOutput,
      requestStarted,
    };
    if (target.translated) {
      await relayTranslated(context, {
        protocol,
        providerProtocol: protocols[target.adapter.wireFormat],
        outbound,
        wantsStream: inspection.stream,
        includeUsage: clientWantsStreamUsage(body),
        result,
        tollwiseHeaders: headersFor(target),
        signal: abort.signal,
        cost: costContext,
        report: reportOutcome,
      });
    } else {
      await relayResponse(
        context,
        protocol,
        outbound.plan,
        inspection.stream,
        result,
        headersFor(target),
        abort.signal,
        costContext,
        reportOutcome,
      );
    }
    return;
  }

  // Every attempt failed before any byte reached the client.
  const last = targets[targets.length - 1] as Target;
  const tried = attempts.length === 1 ? '1 provider' : `${attempts.length} providers`;
  protocol.sendError(
    res,
    502,
    'server_error',
    'all_providers_failed',
    `Tollwise tried ${tried} and every attempt failed: ${describeFailures(attempts)}.`,
    { headers: headersFor(last) },
  );
  report(last, { status: 502, outcome: 'provider_error', usage: null, firstByteMs: null });
}

/** What one attempt sends: the body, and how its answer is read. */
interface Outbound {
  readonly body: string | Buffer;
  /** JSON mode carried by a forced tool call (a translated OpenAI request): read it back as content. */
  readonly jsonMode: boolean;
  /** The plan of the format the request is sent in; its stream watcher reads the provider's usage. */
  readonly plan: OutboundPlan;
}

/** How a response that reached a provider ended, as reported to ProxySettings.onRequestResult. */
type Outcome = Omit<ProxyRequestResult, 'requestId' | 'provider' | 'model' | 'stream' | 'translated' | 'attempts'> & {
  /**
   * For a stream: milliseconds from the request arriving to the provider's response head arriving (when
   * the response head is sent to the client). Null when it never got that far, or was not a stream.
   */
  readonly firstByteMs: number | null;
};

/** What relaying a response needs to price it: the entries computeCost() prices against, and when the request started. */
interface RelayCostContext {
  readonly usedEntry: ModelEntry | null;
  readonly baselineEntry: ModelEntry | undefined;
  readonly estimatedInputTokens: number;
  readonly maxOutput: number | null;
  readonly requestStarted: number;
}

/** One entry of the routing trace. The model id is masked like a log line, in case it carries a key. */
function attemptRecord(
  target: Target,
  outcome: AttemptOutcome,
  status: number | null,
  durationMs: number,
): AttemptRecord {
  return {
    provider: target.adapter.id,
    model: redactText(target.model),
    outcome,
    status,
    duration_ms: durationMs,
    substitution: maskSubstitution(target.substitution),
  };
}

/**
 * Relays a provider's 2xx response to the client: status, headers and body. A streamed answer's
 * head (including the x-tollwise-* headers) leaves before its body, since usage is not known until
 * the stream ends; its cost is never a header, only a number on the reported outcome. A non-streamed
 * answer is held back (BufferedJsonBody) until it has been read in full, so its cost, once known, can
 * be set as a header (x-tollwise-cost-*, "unknown" when no price is known) before anything leaves;
 * one larger than MAX_USAGE_BODY_BYTES is forwarded as it arrives, without cost headers.
 */
async function relayResponse(
  context: RouteContext,
  protocol: ProxyProtocol,
  plan: OutboundPlan,
  wantsStream: boolean,
  result: Extract<UpstreamResult, { type: 'response' }>,
  tollwiseHeaders: Readonly<Record<string, string>>,
  signal: AbortSignal,
  cost: RelayCostContext,
  report: (outcome: Outcome) => void,
): Promise<void> {
  const { res } = context;
  const streamed = wantsStream && isEventStream(result.headers['content-type']);
  const watch = streamed ? plan.watchStream() : null;

  const writeHead = (extraHeaders: Readonly<Record<string, string>> = {}): void => {
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) {
      if (name.startsWith(TOLLWISE_HEADER_PREFIX)) continue;
      // A dropped event changes the length; an event stream is sent chunked anyway.
      if (watch?.hold === true && name === 'content-length') continue;
      res.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(tollwiseHeaders)) res.setHeader(name, value);
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  };

  const collector = new BufferedJsonBody(
    (json) => protocol.readBodyUsage(json),
    () => writeHead(),
  );
  const scanner: BodyScanner =
    watch === null ? collector : new SseScanner({ hold: watch.hold, onEvent: (event) => watch.onEvent(event) });
  const firstByteMs = streamed ? Math.round(performance.now() - cost.requestStarted) : null;

  if (streamed) {
    // The status line and headers leave now, before the first byte of the body arrives.
    writeHead();
    res.flushHeaders();
  }

  try {
    await relayBody(result.body, res, scanner, signal);
  } catch {
    // The provider's body failed or the client went away mid-body: the completion below says which.
  }
  const completion = await result.completion;
  const usage = watch === null ? collector.usage() : watch.usage();

  // True once any part of the response has been handed to the client.
  const started = streamed || collector.overflowed;
  if (completion.type === 'complete') {
    if (started) {
      res.end();
    } else {
      const resolved = resolveUsageAndCost({
        reported: usage,
        complete: true,
        estimatedInputTokens: cost.estimatedInputTokens,
        maxOutput: cost.maxOutput,
        usedEntry: cost.usedEntry,
        baselineEntry: cost.baselineEntry,
      });
      writeHead(costResponseHeaders(resolved));
      res.end(collector.body());
    }
    report({ status: result.status, outcome: 'complete', usage, firstByteMs });
    return;
  }
  if (completion.type === 'aborted') {
    // A non-streamed answer never had a byte sent (it was still being buffered): just close the
    // connection. A streamed one may already have delivered part of its body; same result either way.
    res.destroy();
    report({ status: result.status, outcome: 'client_aborted', usage, firstByteMs });
    return;
  }
  // callUpstream has logged the cause. An answer already started can only be cut: never retried on
  // another provider and never with a made-up end, so the client sees it is incomplete. A
  // non-streamed one still held back never had a byte sent, so the connection is simply closed.
  if (started) cutResponse(res);
  else res.destroy();
  report({ status: result.status, outcome: 'interrupted', usage, firstByteMs });
}

interface TranslatedRelay {
  /** The endpoint's protocol: the format the client reads. */
  readonly protocol: ProxyProtocol;
  /** The protocol of the format the provider answers in. */
  readonly providerProtocol: ProxyProtocol;
  readonly outbound: Outbound;
  readonly wantsStream: boolean;
  /** The OpenAI client asked for the usage chunk at the end of its stream. */
  readonly includeUsage: boolean;
  readonly result: Extract<UpstreamResult, { type: 'response' }>;
  readonly tollwiseHeaders: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly cost: RelayCostContext;
  readonly report: (outcome: Outcome) => void;
}

/** Sets the status and headers of a translated answer: the provider's, but for those describing its bytes. */
function setTranslatedHead(
  res: ServerResponse,
  relay: TranslatedRelay,
  contentType: string,
  contentLength: number | null,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.statusCode = relay.result.status;
  for (const [name, value] of Object.entries(relay.result.headers)) {
    if (name.startsWith(TOLLWISE_HEADER_PREFIX) || TRANSLATED_DROPPED_HEADERS.has(name)) continue;
    res.setHeader(name, value);
  }
  res.setHeader('content-type', contentType);
  if (contentLength !== null) res.setHeader('content-length', String(contentLength));
  for (const [name, value] of Object.entries(relay.tollwiseHeaders)) res.setHeader(name, value);
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
}

/**
 * Relays a 2xx answer from a provider of the other format, translated to the endpoint's format. A stream
 * is translated event by event as it arrives; a JSON body is read whole, translated, then sent, or
 * answered 502 response_not_translatable when it cannot be translated faithfully.
 */
async function relayTranslated(context: RouteContext, relay: TranslatedRelay): Promise<void> {
  const { res } = context;
  const { result, protocol, outbound } = relay;
  const created = Math.floor(Date.now() / 1000);

  if (relay.wantsStream && isEventStream(result.headers['content-type'])) {
    const watch = outbound.plan.watchStream();
    const translator = new StreamTranslator(protocol.format, {
      created,
      jsonMode: outbound.jsonMode,
      includeUsage: relay.includeUsage,
      usageWatch: watch,
    });
    setTranslatedHead(res, relay, EVENT_STREAM_CONTENT_TYPE, null);
    res.flushHeaders();
    const firstByteMs = Math.round(performance.now() - relay.cost.requestStarted);
    try {
      await relayBody(result.body, res, translator, relay.signal);
    } catch {
      // The provider's body failed or the client went away mid-body: the completion below says which.
    }
    const completion = await result.completion;
    if (completion.type === 'complete') {
      const closing: Buffer[] = [];
      translator.finish(closing);
      for (const piece of closing) res.write(piece);
      res.end();
      const outcome = translator.error === null ? 'complete' : 'translation_failed';
      relay.report({ status: result.status, outcome, usage: watch.usage(), firstByteMs });
    } else if (completion.type === 'aborted') {
      res.destroy();
      relay.report({ status: result.status, outcome: 'client_aborted', usage: watch.usage(), firstByteMs });
    } else {
      // Cut like an untranslated stream: nothing is made up, not even a clean end.
      cutResponse(res);
      relay.report({ status: result.status, outcome: 'interrupted', usage: watch.usage(), firstByteMs });
    }
    return;
  }

  const collector = new TranslatedBodyCollector();
  try {
    await relayBody(result.body, res, collector, relay.signal);
  } catch {
    // As above: the completion says what happened.
  }
  const completion = await result.completion;
  if (completion.type === 'aborted') {
    res.destroy();
    relay.report({ status: result.status, outcome: 'client_aborted', usage: null, firstByteMs: null });
    return;
  }
  if (completion.type === 'error') {
    cutResponse(res);
    relay.report({ status: result.status, outcome: 'interrupted', usage: null, firstByteMs: null });
    return;
  }

  const text = collector.text();
  let usage: ReportedUsage | null = null;
  let answer: string;
  try {
    if (text === null) {
      throw new TranslationError('response', relay.providerProtocol.format, protocol.format, ['malformed_response']);
    }
    try {
      usage = relay.providerProtocol.readBodyUsage(JSON.parse(text));
    } catch {
      usage = null;
    }
    answer = translateResponseBody(text, protocol.format, { created, jsonMode: outbound.jsonMode });
  } catch (error) {
    if (!(error instanceof TranslationError)) throw error;
    protocol.sendError(
      res,
      502,
      'server_error',
      'response_not_translatable',
      `The ${relay.providerProtocol.apiName} answer could not be translated to the ${protocol.apiName} ` +
        `format: ${error.codes.join(', ')}.`,
      { headers: { ...relay.tollwiseHeaders } },
    );
    relay.report({ status: 502, outcome: 'translation_failed', usage, firstByteMs: null });
    return;
  }
  const resolved = resolveUsageAndCost({
    reported: usage,
    complete: true,
    estimatedInputTokens: relay.cost.estimatedInputTokens,
    maxOutput: relay.cost.maxOutput,
    usedEntry: relay.cost.usedEntry,
    baselineEntry: relay.cost.baselineEntry,
  });
  const payload = Buffer.from(answer, 'utf8');
  setTranslatedHead(res, relay, JSON_CONTENT_TYPE, payload.length, costResponseHeaders(resolved));
  res.end(payload);
  relay.report({ status: result.status, outcome: 'complete', usage, firstByteMs: null });
}

/** True for a text/event-stream content type. */
function isEventStream(value: string | string[] | undefined): boolean {
  const text = Array.isArray(value) ? value[0] : value;
  return text !== undefined && /^\s*text\/event-stream\s*(;|$)/i.test(text);
}

/** How long a cut response may take to flush what was already written before its connection is destroyed. */
const CUT_FLUSH_MS = 1000;

/**
 * Ends a started response without finishing it: the bytes already written are flushed, then the
 * connection is closed without the final chunk, so the client sees the body end early.
 */
function cutResponse(res: ServerResponse): void {
  const socket = res.socket;
  if (socket === null || socket.destroyed) {
    res.destroy();
    return;
  }
  socket.end();
  const timer = setTimeout(() => socket.destroy(), CUT_FLUSH_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}
