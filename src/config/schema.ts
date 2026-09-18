// The Tollwise configuration schema. One zod schema is both the runtime validator of `tollwise.yaml`
// and the TypeScript type used everywhere downstream (`Config`).
//
// Every field has a default, so an empty file (or no file at all) is a valid configuration.
// Credentials are never part of the configuration: a provider names the environment variable that
// holds its key (`api_key_env`), and the local access key only ever comes from TOLLWISE_ACCESS_KEY.

import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';
import { LOG_LEVELS } from '../log/logger.ts';
import { findPreset, PRESET_NAMES, presetGroups, presetMemberIds } from '../routing/presets.ts';
import { hasControlChars, isLoopbackHost, isWildcardAddress } from './network.ts';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8484;
/** 20 MiB: enough for requests carrying several base64-encoded images. */
export const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
export const MIN_MAX_BODY_BYTES = 1024;
export const MAX_MAX_BODY_BYTES = 512 * 1024 * 1024;

export const PROVIDER_IDS = ['anthropic', 'openai', 'deepseek', 'openrouter', 'ollama'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDefaults {
  readonly base_url: string;
  /** Name of the environment variable holding the key; null for providers that need no key. */
  readonly api_key_env: string | null;
}

export const PROVIDER_DEFAULTS: Readonly<Record<ProviderId, ProviderDefaults>> = {
  anthropic: { base_url: 'https://api.anthropic.com', api_key_env: 'ANTHROPIC_API_KEY' },
  openai: { base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY' },
  deepseek: { base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY' },
  ollama: { base_url: 'http://127.0.0.1:11434', api_key_env: null },
};

export const ROUTING_POLICIES = ['cheapest', 'fastest', 'balanced', 'pinned'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

export const NO_CANDIDATE_MODES = ['passthrough', 'fail'] as const;
export type NoCandidateMode = (typeof NO_CANDIDATE_MODES)[number];

/** A valid environment variable name (POSIX portable form). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Size strings accepted for `server.max_body_size`, e.g. `20mb`, `512 KiB`, `1gb`. */
const SIZE_TEXT = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?\s*$/i;
const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/** Parses `20mb` / `512 KiB` / `1048576` into bytes (1 KB = 1024 bytes); undefined when unparseable. */
export function parseSize(text: string): number | undefined {
  const match = SIZE_TEXT.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = SIZE_UNITS[(match[2] ?? 'b').toLowerCase()] ?? 1;
  return Math.floor(amount * unit);
}

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !hasControlChars(value), {
    error: 'contains control characters',
    params: { hint: 'write only the address, e.g. 127.0.0.1 or localhost' },
  })
  .refine((value) => !/[\s/]/.test(value) && !value.includes('://'), {
    error: 'must be a bare host name or IP address',
    params: { hint: 'write only the address, e.g. 127.0.0.1 or localhost, without scheme, port or path' },
  });

const portSchema = z.int().min(1).max(65535);

/** A DNS host name: dot-separated labels of letters, digits and hyphens. */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * One entry of `server.allowed_hosts`: a bare host name or IP address a client uses to reach Tollwise
 * (IPv6 with or without brackets). Stored lower-case and without brackets.
 */
const allowedHostSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/^\[(.*)\]$/, '$1').toLowerCase())
  .refine((value) => isIPv4(value) || isIPv6(value) || (HOST_NAME.test(value) && !/^[\d.]+$/.test(value)), {
    error: 'must be a bare host name or IP address',
    params: {
      hint: 'write only the name clients use, e.g. my-machine.local or 192.168.1.20, without scheme, port or path',
    },
  })
  .refine((value) => !isWildcardAddress(value), {
    error: 'is a wildcard address that no client can use',
    params: { hint: 'list the names or addresses clients type in their base URL, e.g. 192.168.1.20' },
  });

const sizeSchema = z.union([z.int().nonnegative(), z.string()]).transform((value, ctx) => {
  const bytes = typeof value === 'number' ? value : parseSize(value);
  if (bytes === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" is not a size`,
      params: { hint: 'use a number of bytes or a size such as 20mb, 512kb or 1gb' },
    });
    return z.NEVER;
  }
  if (bytes < MIN_MAX_BODY_BYTES || bytes > MAX_MAX_BODY_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `${bytes} bytes is outside the allowed range`,
      params: { hint: 'use a size between 1kb and 512mb' },
    });
    return z.NEVER;
  }
  return bytes;
});

export const ServerSchema = z.strictObject({
  host: hostSchema.default(DEFAULT_HOST),
  port: portSchema.default(DEFAULT_PORT),
  max_body_size: sizeSchema.default(DEFAULT_MAX_BODY_BYTES),
  allowed_hosts: z.array(allowedHostSchema).default([]),
});

const baseUrlSchema = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" is not a valid URL`,
      params: { hint: 'use a full URL such as https://api.example.com/v1' },
    });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({
      code: 'custom',
      message: `unsupported URL scheme "${url.protocol}"`,
      params: { hint: 'use an http:// or https:// URL' },
    });
  }
  if (url.username !== '' || url.password !== '') {
    ctx.addIssue({
      code: 'custom',
      message: 'the URL contains credentials (user:password@)',
      params: {
        hint: 'remove them from the URL; put the key in an environment variable and name it in api_key_env',
      },
    });
  }
});

/** Environment variables that hold Tollwise's own credentials and must never be sent to a provider. */
const RESERVED_KEY_ENVS: ReadonlySet<string> = new Set(['TOLLWISE_ACCESS_KEY']);

const apiKeyEnvSchema = z
  .string()
  .regex(ENV_NAME, { error: 'must be the NAME of an environment variable, not a value' })
  .refine((value) => !RESERVED_KEY_ENVS.has(value), {
    error: 'TOLLWISE_ACCESS_KEY protects Tollwise itself and must not be sent to a provider',
    params: { hint: "name the variable that holds this provider's own key, e.g. OPENAI_API_KEY" },
  });

/**
 * True when a key sent to `baseUrl` would cross the network unencrypted: plain http:// to a host
 * that is not this machine. Unparseable URLs return false (the URL check reports those).
 */
export function isCleartextRemoteUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

function providerSchema(id: ProviderId) {
  const defaults = PROVIDER_DEFAULTS[id];
  return z
    .strictObject({
      enabled: z.boolean().default(true),
      base_url: baseUrlSchema.default(defaults.base_url),
      api_key_env: apiKeyEnvSchema.nullable().default(defaults.api_key_env),
    })
    .superRefine((value, ctx) => {
      // A provider that sends a key must never send it in cleartext to another machine.
      if (value.api_key_env !== null && isCleartextRemoteUrl(value.base_url)) {
        ctx.addIssue({
          code: 'custom',
          path: ['base_url'],
          message: `plain http:// to a remote host would send the ${value.api_key_env} key unencrypted`,
          params: {
            hint: 'use https://, or a loopback address (127.0.0.1, localhost) for a local server; for a keyless server on your network set api_key_env: null',
          },
        });
      }
    })
    .prefault({});
}

export const ProvidersSchema = z.strictObject({
  anthropic: providerSchema('anthropic'),
  openai: providerSchema('openai'),
  deepseek: providerSchema('deepseek'),
  openrouter: providerSchema('openrouter'),
  ollama: providerSchema('ollama'),
});

export const PinnedTargetSchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1),
});

export const EquivalenceGroupSchema = z.strictObject({
  name: z.string().trim().min(1),
  models: z.array(z.string().trim().min(1)).min(2),
});

export const TimeoutsSchema = z
  .strictObject({
    connect_ms: z.int().min(100).max(120_000).default(5_000),
    first_byte_ms: z.int().min(100).max(3_600_000).default(120_000),
    total_ms: z.int().min(100).max(3_600_000).default(600_000),
  })
  .superRefine((value, ctx) => {
    if (value.first_byte_ms > value.total_ms) {
      ctx.addIssue({
        code: 'custom',
        path: ['first_byte_ms'],
        message: `first_byte_ms (${value.first_byte_ms}) is larger than total_ms (${value.total_ms})`,
        params: { hint: 'make first_byte_ms smaller than or equal to total_ms' },
      });
    }
  });

export const RoutingSchema = z
  .strictObject({
    policy: z.enum(ROUTING_POLICIES).default('cheapest'),
    on_no_candidate: z.enum(NO_CANDIDATE_MODES).default('passthrough'),
    pinned: PinnedTargetSchema.optional(),
    equivalence_groups: z.array(EquivalenceGroupSchema).default([]),
    equivalence_presets: z.array(z.string().trim().min(1)).default([]),
    retries: z.int().min(0).max(5).default(1),
    timeouts: TimeoutsSchema.prefault({}),
  })
  .superRefine((value, ctx) => {
    if (value.policy === 'pinned' && value.pinned === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['policy'],
        message: 'policy is "pinned" but no pinned target is set',
        params: { hint: 'add routing.pinned with a provider and a model, or choose another policy' },
      });
    }
    const groupOfModel = new Map<string, string>();
    const names = new Set<string>();
    value.equivalence_groups.forEach((group, index) => {
      if (names.has(group.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['equivalence_groups', index, 'name'],
          message: `duplicate group name "${group.name}"`,
          params: { hint: 'give every equivalence group a unique name' },
        });
      }
      names.add(group.name);
      group.models.forEach((model, modelIndex) => {
        const owner = groupOfModel.get(model);
        if (owner !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['equivalence_groups', index, 'models', modelIndex],
            message: `model "${model}" is already in group "${owner}"`,
            params: { hint: 'a model may belong to one equivalence group only; merge the groups or remove it' },
          });
        } else {
          groupOfModel.set(model, group.name);
        }
      });
    });
    // A preset expands into a group named like it, so it follows the same rules as a written group:
    // a unique name, and no model shared with another group (written or preset).
    const presets = new Set<string>();
    value.equivalence_presets.forEach((name, index) => {
      const path = ['equivalence_presets', index];
      if (!PRESET_NAMES.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `unknown equivalence preset "${name}"`,
          params: { hint: `use one of: ${PRESET_NAMES.join(', ')}` },
        });
        return;
      }
      if (presets.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `preset "${name}" is listed twice`,
          params: { hint: 'list each preset once' },
        });
        return;
      }
      presets.add(name);
      if (names.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `preset "${name}" has the same name as a group in equivalence_groups`,
          params: { hint: 'rename that group, or remove it and keep the preset' },
        });
      }
      // A written group may name a member by its canonical id or by one provider's own id for it;
      // either way the model would be in two groups, so both are checked.
      const preset = findPreset(name);
      for (const [id, model] of preset === undefined ? [] : presetMemberIds(preset)) {
        const owner = groupOfModel.get(id);
        if (owner !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              id === model
                ? `preset "${name}" includes model "${model}", which is already in group "${owner}"`
                : `preset "${name}" includes model "${model}", which group "${owner}" already lists by its provider id "${id}"`,
            params: {
              hint: 'a model may belong to one equivalence group only; remove it from that group, or turn off one of the presets',
            },
          });
        } else {
          groupOfModel.set(id, name);
        }
      }
    });
  })
  // Presets become ordinary groups after the written ones, so routing reads a single list and treats
  // a preset exactly like a group written by hand. `equivalence_presets` keeps the names turned on.
  .transform((value) => ({
    ...value,
    equivalence_groups: [...value.equivalence_groups, ...presetGroups(value.equivalence_presets)],
  }));

/** Where the analytics database is kept, relative to the directory Tollwise is started from. */
export const DEFAULT_ANALYTICS_PATH = 'data/analytics.db';

export const AnalyticsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  // Tollwise stores request metadata only; keeping prompts and responses is not built. The field is
  // accepted so the documented default stays valid, and true is refused rather than silently ignored.
  store_prompts: z
    .boolean()
    .default(false)
    .refine((value) => !value, {
      error: 'prompt storage is not available in this release; Tollwise stores request metadata only',
      params: { hint: 'set store_prompts to false or remove the field' },
    }),
  path: z.string().trim().min(1).default(DEFAULT_ANALYTICS_PATH),
});

export const LoggingSchema = z.strictObject({
  level: z.enum(LOG_LEVELS).default('info'),
});

export const ConfigSchema = z.strictObject({
  server: ServerSchema.prefault({}),
  providers: ProvidersSchema.prefault({}),
  routing: RoutingSchema.prefault({}),
  analytics: AnalyticsSchema.prefault({}),
  logging: LoggingSchema.prefault({}),
});

/** The validated, fully defaulted configuration. */
export type Config = z.output<typeof ConfigSchema>;
/** What a configuration file may contain (every field optional). */
export type ConfigInput = z.input<typeof ConfigSchema>;
export type ProviderConfig = Config['providers'][ProviderId];

/** The configuration used when there is no file and no environment override. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
