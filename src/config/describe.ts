// Renders the effective configuration for `tollwise config check`.
// Credentials are never printed: each provider key and the access key are shown only as set / missing.
// Equivalence presets are shown expanded, with the models each one adds, apart from the groups
// written by hand (the effective configuration holds both in one list; see src/config/schema.ts).

import { stringify } from 'yaml';
import { ACCESS_KEY_ENV, type Environment, isEnvSet, type LoadedConfig } from './load.ts';
import { escapeControlChars } from './network.ts';
import { PROVIDER_IDS } from './schema.ts';

export type KeyStatus = 'set' | 'missing' | 'not required';

export function keyStatus(env: Environment, variable: string | null): KeyStatus {
  if (variable === null) return 'not required';
  return isEnvSet(env, variable) ? 'set' : 'missing';
}

function formatBytes(bytes: number): string {
  const mib = 1024 * 1024;
  if (bytes % mib === 0) return `${bytes / mib}mb`;
  if (bytes % 1024 === 0) return `${bytes / 1024}kb`;
  return `${bytes}`;
}

function describeSource(loaded: LoadedConfig): string {
  const origin: Record<LoadedConfig['fileOrigin'], string> = {
    flag: ' (from --config)',
    env: ' (from TOLLWISE_CONFIG)',
    default: ' (found in the current directory)',
    none: '',
  };
  const file =
    loaded.file === null
      ? 'Config file: none found; using built-in defaults'
      : `Config file: ${escapeControlChars(loaded.file)}${origin[loaded.fileOrigin]}`;
  const env =
    loaded.envOverrides.length > 0
      ? `Environment overrides: ${loaded.envOverrides.join(', ')}`
      : 'Environment overrides: none';
  return `${file}\n${env}`;
}

/** The text printed by `tollwise config check` on success. */
export function describeEffectiveConfig(loaded: LoadedConfig, env: Environment): string {
  const { config } = loaded;
  const providers = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const provider = config.providers[id];
      return [
        id,
        {
          enabled: provider.enabled,
          base_url: provider.base_url,
          api_key_env: provider.api_key_env,
          api_key: keyStatus(env, provider.api_key_env),
        },
      ];
    }),
  );
  const { equivalence_groups: groups, equivalence_presets: presets, ...routing } = config.routing;
  const presetNames = new Set(presets);
  const routingView = {
    policy: routing.policy,
    on_no_candidate: routing.on_no_candidate,
    ...(routing.pinned !== undefined ? { pinned: routing.pinned } : {}),
    equivalence_groups: groups.filter((group) => !presetNames.has(group.name)),
    equivalence_presets: groups.filter((group) => presetNames.has(group.name)),
    retries: routing.retries,
    timeouts: routing.timeouts,
  };
  const view = {
    server: {
      host: config.server.host,
      port: config.server.port,
      max_body_size: formatBytes(config.server.max_body_size),
      allowed_hosts: config.server.allowed_hosts,
      access_key: `${loaded.accessKeySet ? 'set' : 'missing'} (${ACCESS_KEY_ENV})`,
    },
    providers,
    routing: routingView,
    analytics: config.analytics,
    logging: config.logging,
  };
  return `OK: configuration is valid.\n${describeSource(loaded)}\n\nEffective configuration:\n${stringify(view, { indent: 2, lineWidth: 0 })}`;
}
