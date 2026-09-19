// GET /v1/models and GET /v1/models/{id}: the models Tollwise can serve, in OpenAI or Anthropic shape.
//
// A servable model is one canonical_model (src/catalog/schema.ts groups the same underlying model
// across providers under this id) backed by at least one catalog entry whose provider is configured
// and enabled in the provider registry (src/providers/registry.ts): the id a client puts in a chat
// request's "model" field to have Tollwise route it. The list is deduplicated by canonical_model id
// and sorted ascending.
//
// Shape: Anthropic (`{ data: [...], has_more, first_id, last_id }`, one entry
// `{ type: "model", id, display_name, created_at }`) when the request carries an anthropic-version
// header, the same signal the mock provider fixture uses (test/fixtures/mock-provider.ts); OpenAI
// shape (`{ object: "list", data: [...] }`, one entry `{ id, object: "model", created, owned_by }`)
// otherwise.
//
// This never calls a provider: every field comes from the catalog and the registry already loaded in
// memory, and nothing here reads env or logs a header or a body.

import type { Catalog } from '../catalog/schema.ts';
import type { ProviderId } from '../config/schema.ts';
import { sendError, sendJson } from '../server/respond.ts';
import type { ProxySettings, RouteContext } from '../server/router.ts';

const ANTHROPIC_VERSION_HEADER = 'anthropic-version';
const MODELS_PATH = '/v1/models';

const PROXY_NOT_CONFIGURED_MESSAGE =
  'Tollwise has no provider configuration loaded, so it cannot list servable models.';

/** One model Tollwise can serve: a canonical_model backed by at least one enabled provider. */
export interface ServableModel {
  readonly id: string;
  /** Unix seconds, from the verified_on date of the first catalog entry (catalog order) backing this model. */
  readonly createdAt: number;
}

/** Unix seconds at UTC midnight of an ISO calendar date (YYYY-MM-DD), e.g. a catalog entry's verified_on. */
function dateToUnixSeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/**
 * Every model Tollwise can serve: one entry per canonical_model with at least one catalog entry whose
 * provider is in `enabledProviders`, sorted by id. When several catalog entries share a canonical_model,
 * the first one in catalog order among the enabled ones supplies createdAt.
 */
export function listServableModels(
  catalog: Catalog,
  enabledProviders: ReadonlySet<ProviderId>,
): readonly ServableModel[] {
  const byId = new Map<string, ServableModel>();
  for (const entry of catalog.models) {
    if (!enabledProviders.has(entry.provider)) continue;
    if (byId.has(entry.canonical_model)) continue;
    byId.set(entry.canonical_model, { id: entry.canonical_model, createdAt: dateToUnixSeconds(entry.verified_on) });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The servable model with this id, or undefined when Tollwise cannot serve it. */
export function findServableModel(
  catalog: Catalog,
  enabledProviders: ReadonlySet<ProviderId>,
  id: string,
): ServableModel | undefined {
  return listServableModels(catalog, enabledProviders).find((model) => model.id === id);
}

// ---------------------------------------------------------------- OpenAI shape

export interface OpenAiModel {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
}

export interface OpenAiModelList {
  readonly object: 'list';
  readonly data: readonly OpenAiModel[];
}

/**
 * owned_by is always "tollwise": a servable model is a canonical_model, which can be backed by more
 * than one provider, so no single provider name would be accurate.
 */
const OWNED_BY = 'tollwise';

export function toOpenAiModel(model: ServableModel): OpenAiModel {
  return { id: model.id, object: 'model', created: model.createdAt, owned_by: OWNED_BY };
}

export function toOpenAiModelList(models: readonly ServableModel[]): OpenAiModelList {
  return { object: 'list', data: models.map(toOpenAiModel) };
}

// ---------------------------------------------------------------- Anthropic shape

export interface AnthropicModel {
  readonly type: 'model';
  readonly id: string;
  readonly display_name: string;
  readonly created_at: string;
}

export interface AnthropicModelList {
  readonly data: readonly AnthropicModel[];
  readonly has_more: false;
  readonly first_id: string | null;
  readonly last_id: string | null;
}

export function toAnthropicModel(model: ServableModel): AnthropicModel {
  return {
    type: 'model',
    id: model.id,
    // The catalog carries no separate marketing name; the canonical id is the only name Tollwise has.
    display_name: model.id,
    created_at: new Date(model.createdAt * 1000).toISOString(),
  };
}

export function toAnthropicModelList(models: readonly ServableModel[]): AnthropicModelList {
  return {
    data: models.map(toAnthropicModel),
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  };
}

/** True when the request should be answered in the Anthropic models shape, i.e. it carries anthropic-version. */
export function wantsAnthropicShape(headers: RouteContext['req']['headers']): boolean {
  return headers[ANTHROPIC_VERSION_HEADER] !== undefined;
}

function anthropicErrorBody(type: string, message: string): unknown {
  return { type: 'error', error: { type, message } };
}

function notFoundMessage(id: string): string {
  return `The model "${id}" does not exist or is not configured on this Tollwise instance.`;
}

// ---------------------------------------------------------------- the handler

/** Decodes the id after `/v1/models/`; an id that fails to percent-decode is kept as sent (matches nothing). */
function decodeModelId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function handleListModels(res: RouteContext['res'], proxy: ProxySettings, anthropicShape: boolean): void {
  const enabled = new Set(proxy.registry.enabled.map((adapter) => adapter.id));
  const models = listServableModels(proxy.catalog, enabled);
  sendJson(res, 200, anthropicShape ? toAnthropicModelList(models) : toOpenAiModelList(models));
}

function handleGetModel(res: RouteContext['res'], proxy: ProxySettings, id: string, anthropicShape: boolean): void {
  const enabled = new Set(proxy.registry.enabled.map((adapter) => adapter.id));
  const model = findServableModel(proxy.catalog, enabled, id);
  if (model === undefined) {
    if (anthropicShape) {
      sendJson(res, 404, anthropicErrorBody('not_found_error', notFoundMessage(id)));
    } else {
      sendError(res, 404, 'invalid_request_error', 'model_not_found', notFoundMessage(id));
    }
    return;
  }
  sendJson(res, 200, anthropicShape ? toAnthropicModel(model) : toOpenAiModel(model));
}

/** Handles GET /v1/models and GET /v1/models/{id}. Never calls a provider. */
export function handleModels(context: RouteContext): void {
  const { res, req, proxy } = context;
  const anthropicShape = wantsAnthropicShape(req.headers);

  if (proxy === undefined) {
    if (anthropicShape) {
      sendJson(res, 503, anthropicErrorBody('api_error', PROXY_NOT_CONFIGURED_MESSAGE));
    } else {
      sendError(res, 503, 'server_error', 'proxy_not_configured', PROXY_NOT_CONFIGURED_MESSAGE);
    }
    return;
  }

  const suffix = context.path.slice(MODELS_PATH.length);
  if (suffix === '' || suffix === '/') {
    handleListModels(res, proxy, anthropicShape);
    return;
  }
  const id = decodeModelId(suffix.slice(1));
  handleGetModel(res, proxy, id, anthropicShape);
}
