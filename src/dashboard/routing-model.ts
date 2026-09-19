// What the Routing view shows for one request: the table row and the drawer's routing trace (DESIGN.md
// §13). Every wording and fallback rule lives here, as pure data built only from stored fields (never
// guessed), so it is tested under Node without a browser; the elements in ./elements only render it.

import type {
  AttemptOutcome,
  AttemptRecord,
  OutcomeCandidate,
  OutcomePrice,
  OutcomeStatus,
  RecentEntry,
  RequestNeeds,
  WireFormat,
} from './api.ts';
import { type FormattedUsd, formatCount, formatMs, formatUsd, plural } from './format.ts';

/** A run of text; `strong` emphasises a run, `mono` renders it in the monospace font (a model id). */
export interface SentenceRun {
  readonly text: string;
  readonly strong?: true;
  readonly mono?: true;
}

export type StatusShape = 'ring' | 'square' | 'diamond';
export type StatusTone = 'muted' | 'danger' | 'warning';

export interface StatusInfo {
  readonly shape: StatusShape;
  readonly text: string;
  readonly tone: StatusTone;
}

/** Status shape, text and colour (DESIGN.md §13.3); colour is never the only signal. */
export const STATUS_INFO: Readonly<Record<OutcomeStatus, StatusInfo>> = {
  complete: { shape: 'ring', text: 'Complete', tone: 'muted' },
  provider_error: { shape: 'square', text: 'Provider error', tone: 'danger' },
  translation_failed: { shape: 'square', text: 'Translation failed', tone: 'danger' },
  refused: { shape: 'square', text: 'Refused', tone: 'danger' },
  interrupted: { shape: 'diamond', text: 'Interrupted', tone: 'warning' },
  client_aborted: { shape: 'diamond', text: 'Client closed', tone: 'warning' },
};

const OUTCOME_TEXT: Readonly<Record<AttemptOutcome, string>> = {
  ok: 'Served',
  server: 'Server error',
  rate_limit: 'Rate limited',
  overloaded: 'Overloaded',
  timeout: 'Timed out',
  connection: 'Connection failed',
  auth: 'Key refused',
  bad_request: 'Bad request',
  unknown: 'Failed',
  client_aborted: 'Client closed',
};

/** "Served · HTTP 200", "Server error · HTTP 500", "Timed out" (no HTTP part when there was no answer). */
export function attemptResultText(attempt: Pick<AttemptRecord, 'outcome' | 'status'>): string {
  const base = OUTCOME_TEXT[attempt.outcome];
  return attempt.status === null ? base : `${base} · HTTP ${attempt.status}`;
}

/** The lower-case form used inline in the drawer's sentence: "server error", "rate limited". */
export function attemptOutcomeWord(outcome: AttemptOutcome): string {
  return OUTCOME_TEXT[outcome].toLowerCase();
}

export const WIRE_FORMAT_TEXT: Readonly<Record<WireFormat, string>> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
};

const NEEDS_ORDER: readonly (keyof RequestNeeds)[] = ['tools', 'json_mode', 'vision', 'streaming'];
const NEEDS_LABEL: Readonly<Record<keyof RequestNeeds, string>> = {
  tools: 'Tools',
  json_mode: 'JSON mode',
  vision: 'Images',
  streaming: 'Streaming',
};

/** The drawer's needs chips, in the fixed order Tools, JSON mode, Images, Streaming. */
export function needsChips(needs: RequestNeeds): readonly string[] {
  const chips = NEEDS_ORDER.filter((key) => needs[key]).map((key) => NEEDS_LABEL[key]);
  return chips.length === 0 ? ['No special capabilities'] : chips;
}

const CAPABILITY_TEXT: Readonly<Record<string, string>> = {
  vision: 'Does not accept images; this request has one',
  tools: 'Does not support tool calls; this request uses them',
  json_mode: 'Has no JSON mode; this request asks for it',
  streaming: 'Cannot stream; this request streams',
};

const REASON_TEXT: Readonly<Record<string, string>> = {
  context_too_small: 'Context window too small for this request',
  max_output_too_small: 'Cannot produce the requested output length',
  provider_down: 'Provider was down at the time',
  provider_not_configured: 'Provider not configured (no key set)',
  provider_not_requested: 'The request named another provider',
};

/** The words for an exclusion reason code (DESIGN.md §13.4 item 3); the code itself is shown too, unchanged. */
export function exclusionReasonText(reason: string): string {
  if (reason.startsWith('missing_capability:')) {
    return CAPABILITY_TEXT[reason.slice('missing_capability:'.length)] ?? reason;
  }
  if (reason.startsWith('untranslatable:')) {
    return `Speaks the other API format, which cannot carry ${reason.slice('untranslatable:'.length)}`;
  }
  return REASON_TEXT[reason] ?? reason;
}

/** A catalog price in USD per 1M tokens, formatted with as few decimals as it needs (at least 2). */
export function formatCatalogPrice(value: number): string {
  if (value === 0) return '$0.00';
  let text = value.toFixed(5);
  while (text.endsWith('0')) text = text.slice(0, -1);
  if (text.endsWith('.')) text = `${text}00`;
  const decimals = text.split('.')[1]?.length ?? 0;
  return decimals < 2 ? `$${value.toFixed(2)}` : `$${text}`;
}

function priceLineText(input: number, output: number): string {
  return `${formatCatalogPrice(input)} in · ${formatCatalogPrice(output)} out`;
}

// ---------------------------------------------------------------- table row

export interface RoutedToView {
  readonly notRouted: boolean;
  readonly provider: string | undefined;
  readonly afterFailures: string | undefined;
  readonly model: string | undefined;
  readonly pips: readonly { readonly ok: boolean }[];
}

/** The "Routed to" cell (DESIGN.md §13.3): the attempt pips, the provider and any fallback note. */
export function routedToView(entry: RecentEntry): RoutedToView {
  if (entry.route.usedProvider === null) {
    return { notRouted: true, provider: undefined, afterFailures: undefined, model: undefined, pips: [] };
  }
  const failures = entry.trace.length - 1;
  return {
    notRouted: false,
    provider: entry.route.usedProvider,
    afterFailures: failures > 0 ? `after ${plural(failures, 'failure', 'failures')}` : undefined,
    model: entry.route.usedModel ?? undefined,
    pips: entry.trace.map((attempt) => ({ ok: attempt.outcome === 'ok' })),
  };
}

/**
 * The "Substituted" marker of a row (DESIGN.md §13.3): shown only when another model served the request.
 * `label` is its full text, read by assistive technology and shown on hover.
 */
export interface SubstitutionMark {
  readonly requestedModel: string;
  readonly servedModel: string;
  readonly label: string;
}

export function substitutionMark(entry: RecentEntry): SubstitutionMark | undefined {
  if (entry.substituted !== true || entry.substitution === null) return undefined;
  const { requested_model: requestedModel, served_model: servedModel } = entry.substitution;
  return { requestedModel, servedModel, label: `Substituted: requested ${requestedModel}, served ${servedModel}` };
}

export interface SavedCell {
  readonly amount: FormattedUsd;
  readonly positive: boolean;
  readonly originText: string | undefined;
}

/** The "Saved" cell: positive savings are the only case coloured (DESIGN.md §13.3), with the origin line. */
export function savedCellView(entry: RecentEntry): SavedCell {
  const amount = formatUsd(entry.savings_usd ?? 'unknown');
  const numeric = entry.savings_usd !== null && entry.savings_usd !== 'unknown' ? Number(entry.savings_usd) : undefined;
  return {
    amount,
    positive: numeric !== undefined && numeric > 0,
    originText: entry.route.decision === 'fail' ? undefined : (entry.origin ?? undefined),
  };
}

export interface TableRow {
  readonly requestId: string;
  readonly timeText: string;
  readonly isoTimestamp: string;
  readonly accessibleName: string;
  readonly requestedModel: string;
  readonly routedTo: RoutedToView;
  readonly substitution: SubstitutionMark | undefined;
  readonly policy: string;
  readonly cost: FormattedUsd;
  readonly saved: SavedCell;
  readonly latencyText: string;
  readonly status: StatusInfo;
}

/** The whole "Recent requests" row (DESIGN.md §13.3). `timeText` is the viewer's local HH:MM:SS. */
export function tableRow(entry: RecentEntry, timeText: string): TableRow {
  const routedTo = routedToView(entry);
  const destination = routedTo.notRouted ? 'Not routed' : (routedTo.provider ?? '');
  const substitution = substitutionMark(entry);
  const name = `Open request at ${timeText}, ${entry.route.requestedModel} to ${destination}`;
  return {
    requestId: entry.requestId,
    timeText,
    isoTimestamp: entry.timestamp,
    accessibleName: substitution === undefined ? name : `${name}. ${substitution.label}`,
    requestedModel: entry.route.requestedModel,
    routedTo,
    substitution,
    policy: entry.route.policy,
    cost: formatUsd(entry.cost_usd ?? 'unknown'),
    saved: savedCellView(entry),
    latencyText: formatMs(entry.latency_ms),
    status: STATUS_INFO[entry.status],
  };
}

/**
 * A live row is inserted directly, with the highlight fade, only when the table's header is in view,
 * focus is not inside the table and the drawer is closed (DESIGN.md §13.6); otherwise it waits behind
 * the "N new requests" button so nothing the user is reading moves.
 */
export function shouldPrependLive(conditions: {
  readonly headerInView: boolean;
  readonly focusInsideTable: boolean;
  readonly drawerOpen: boolean;
}): boolean {
  return conditions.headerInView && !conditions.focusInsideTable && !conditions.drawerOpen;
}

/**
 * The rows of `incoming` whose `requestId` is not in any of `known`, in their own order and each once:
 * rows are keyed by requestId, so a request that arrives both live and in a page is shown once (§13.5).
 */
export function unseenRows<T extends { readonly requestId: string }>(
  incoming: readonly T[],
  ...known: ReadonlyArray<readonly { readonly requestId: string }[]>
): T[] {
  const seen = new Set<string>();
  for (const list of known) for (const row of list) seen.add(row.requestId);
  const result: T[] = [];
  for (const row of incoming) {
    if (seen.has(row.requestId)) continue;
    seen.add(row.requestId);
    result.push(row);
  }
  return result;
}

/**
 * Runs one asynchronous job at a time: `run` returns false, without calling `job`, while a previous job
 * is still in flight (a second activation of "Load 50 older requests" must not fetch the same page twice).
 */
export class SingleFlight {
  private busy = false;

  get inFlight(): boolean {
    return this.busy;
  }

  async run(job: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await job();
    } finally {
      this.busy = false;
    }
    return true;
  }
}

/** The minimum gap between two announcements of the "N new requests" live region (DESIGN.md §13.6). */
export const ANNOUNCE_GAP_MS = 5_000;

/** How long to wait before the live region may be updated again: 0 when it may be updated now. */
export function announceDelay(lastAnnouncedAt: number | undefined, now: number): number {
  if (lastAnnouncedAt === undefined) return 0;
  return Math.max(0, lastAnnouncedAt + ANNOUNCE_GAP_MS - now);
}

/** `url` when it is an absolute http(s) URL, the only kind the drawer links to; undefined otherwise. */
export function webUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined;
}

// ---------------------------------------------------------------- drawer

/** The drawer's one-sentence account of the routing decision (DESIGN.md §13.4), from stored fields only. */
export function sentenceRuns(entry: RecentEntry): readonly SentenceRun[] {
  const { route } = entry;
  if (route.decision === 'fail') {
    return [
      { text: 'Refused. No configured provider can serve ' },
      { text: route.requestedModel, mono: true },
      { text: ' with the capabilities this request uses, and routing is set to fail rather than pass it through.' },
    ];
  }
  if (route.decision === 'passthrough') {
    const allExcluded = entry.selection !== null && entry.selection.considered > 0;
    const tail = allExcluded
      ? 'every catalog entry for it was excluded (see Excluded), so the request went to the model it named.'
      : 'the catalog has no entry for this model, so there was nothing to route between.';
    return [
      { text: 'Passed through to ' },
      { text: route.requestedModel, mono: true },
      { text: ` on ${route.usedProvider ?? ''}: ${tail}` },
    ];
  }
  const failures = entry.trace.filter((attempt) => attempt.outcome !== 'ok');
  const runs: SentenceRun[] = [
    { text: 'Routed by the ' },
    { text: route.policy, strong: true },
    { text: ` policy to ${route.usedProvider ?? ''}` },
  ];
  if (failures.length === 0) {
    runs.push({ text: '.' });
  } else {
    const parts = failures.map(
      (attempt) =>
        `${attempt.provider} failed (${attemptOutcomeWord(attempt.outcome)}${attempt.status === null ? '' : `, HTTP ${attempt.status}`})`,
    );
    runs.push({ text: `, after ${parts.join(', ')}.` });
  }
  return runs;
}

export interface StripItem {
  readonly kind: 'requested' | 'served' | 'failed' | 'none';
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
}

/** The route strip: the requested model, then every attempt in order (DESIGN.md §13.4). */
export function routeStrip(entry: RecentEntry): readonly StripItem[] {
  const items: StripItem[] = [{ kind: 'requested', label: 'Requested', value: entry.route.requestedModel, mono: true }];
  if (entry.trace.length === 0) {
    items.push({ kind: 'none', label: 'No provider', value: 'Refused', mono: false });
    return items;
  }
  entry.trace.forEach((attempt, index) => {
    items.push({
      kind: attempt.outcome === 'ok' ? 'served' : 'failed',
      label: `${index + 1}. ${attempt.provider}`,
      value: attemptResultText(attempt),
      mono: false,
    });
  });
  return items;
}

export interface CandidateRow {
  readonly rank: number;
  readonly provider: string;
  readonly model: string;
  readonly priceText: string | undefined;
  readonly resultText: string | undefined;
  readonly served: boolean;
}

/** The Candidates section's rows, in the policy's ranking order, cross-referenced with what was tried. */
export function candidateRows(entry: RecentEntry): readonly CandidateRow[] {
  if (entry.selection === null) return [];
  const tried = new Map<string, AttemptRecord>();
  for (const attempt of entry.trace) tried.set(`${attempt.provider}|${attempt.model}`, attempt);
  return entry.selection.candidates.map((candidate: OutcomeCandidate, index) => {
    const attempt = tried.get(`${candidate.provider}|${candidate.model}`);
    return {
      rank: index + 1,
      provider: candidate.provider,
      model: candidate.model,
      priceText:
        candidate.input === null || candidate.output === null
          ? undefined
          : priceLineText(candidate.input, candidate.output),
      resultText: attempt === undefined ? undefined : attemptResultText(attempt),
      served: attempt?.outcome === 'ok',
    };
  });
}

export interface ExcludedRow {
  readonly provider: string;
  readonly model: string;
  readonly reasonText: string;
  readonly reasonCode: string;
}

/** The Excluded section's rows (DESIGN.md §13.4 item 3). */
export function excludedRows(entry: RecentEntry): readonly ExcludedRow[] {
  if (entry.selection === null) return [];
  return entry.selection.excluded.map((exclusion) => ({
    provider: exclusion.provider,
    model: exclusion.model,
    reasonText: exclusionReasonText(exclusion.reason),
    reasonCode: exclusion.reason,
  }));
}

/** The drawer's "Model substitution" section (DESIGN.md §13.4 item 1). */
export type SubstitutionSection =
  | {
      readonly kind: 'substituted';
      readonly requestedModel: string;
      readonly servedModel: string;
      readonly group: string;
    }
  /** Not substituted; `note` says why in words. */
  | { readonly kind: 'none'; readonly note: string }
  /** A row stored before substitutions were recorded. */
  | { readonly kind: 'not-recorded'; readonly note: string };

export function substitutionSection(entry: RecentEntry): SubstitutionSection {
  if (entry.substituted === null) return { kind: 'not-recorded', note: 'Not recorded for this request.' };
  if (entry.substituted && entry.substitution !== null) {
    return {
      kind: 'substituted',
      requestedModel: entry.substitution.requested_model,
      servedModel: entry.substitution.served_model,
      group: entry.substitution.group,
    };
  }
  if (entry.route.decision === 'fail') {
    return { kind: 'none', note: 'No provider was called, so no model was substituted.' };
  }
  return { kind: 'none', note: 'Same model as requested.' };
}

export interface AttemptRow {
  readonly rank: number;
  readonly provider: string;
  readonly model: string;
  readonly resultText: string;
  readonly failed: boolean;
  readonly durationText: string;
}

/** The Attempts section's rows, and the "Total N ms, first byte after M ms." note. */
export function attemptRows(entry: RecentEntry): readonly AttemptRow[] {
  return entry.trace.map((attempt, index) => ({
    rank: index + 1,
    provider: attempt.provider,
    model: attempt.model,
    resultText: attemptResultText(attempt),
    failed: attempt.outcome !== 'ok',
    durationText: formatMs(attempt.duration_ms),
  }));
}

export interface PriceLine {
  readonly text: string;
  readonly verifiedOn: string;
  readonly sourceUrl: string;
  /** The link target: the source URL when it is http(s); undefined shows the URL as plain text. */
  readonly sourceHref: string | undefined;
  /** Accessible name of the source link: "Price source for <model>, opens in a new tab". */
  readonly linkLabel: string;
}

function priceLine(price: OutcomePrice | null, model: string | null): PriceLine | undefined {
  return price === null
    ? undefined
    : {
        text: priceLineText(price.input, price.output),
        verifiedOn: price.verified_on,
        sourceUrl: price.source_url,
        sourceHref: webUrl(price.source_url),
        linkLabel: `Price source for ${model ?? 'this model'}, opens in a new tab`,
      };
}

export interface UsageLine {
  readonly tokensText: string;
  readonly originText: string;
  readonly originKnown: boolean;
}

export interface CostSection {
  readonly refused: boolean;
  readonly cost: FormattedUsd;
  readonly baseline: FormattedUsd;
  readonly saved: SavedCell;
  readonly usage: UsageLine | undefined;
  readonly usedPrice: PriceLine | undefined;
  readonly requestedPrice: PriceLine | undefined;
}

/** The "Cost and price source" section (DESIGN.md §13.4 item 1). */
export function costSection(entry: RecentEntry): CostSection {
  const usage: UsageLine | undefined =
    entry.usage === null
      ? undefined
      : {
          tokensText: `${formatCount(entry.usage.input)} in · ${formatCount(entry.usage.output)} out tokens, `,
          originText:
            entry.origin === 'reported'
              ? 'reported by the provider'
              : entry.origin === 'estimated'
                ? 'estimated by Tollwise (the provider reported no usage)'
                : 'Origin not recorded',
          originKnown: entry.origin !== null,
        };
  return {
    refused: entry.route.decision === 'fail',
    cost: formatUsd(entry.cost_usd ?? 'unknown'),
    baseline: formatUsd(entry.baseline_usd ?? 'unknown'),
    saved: savedCellView(entry),
    usage,
    usedPrice: entry.price === null ? undefined : priceLine(entry.price.used, entry.route.usedModel),
    requestedPrice: entry.price === null ? undefined : priceLine(entry.price.requested, entry.route.requestedModel),
  };
}
