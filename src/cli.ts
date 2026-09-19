#!/usr/bin/env node
// Tollwise CLI entry point.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError } from './catalog/errors.ts';
import { runCatalogUpdate, toTerminalText, UpdateError } from './catalog/update.ts';
import { describeEffectiveConfig } from './config/describe.ts';
import { ConfigError } from './config/errors.ts';
import { loadConfig } from './config/load.ts';
import { StartError, startTollwise } from './server/start.ts';

interface PackageInfo {
  version: string;
}

function readPackageInfo(): PackageInfo {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(here, '..', 'package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  return JSON.parse(raw) as PackageInfo;
}

const USAGE = `Usage: tollwise [command] [options]

Commands:
  start [--config <path>]                     Start the proxy (the default when no command is given)
  config check [--config <path>]              Validate the configuration and print the effective settings
  catalog update [--write] [--source-url u]   Compare the pricing catalog against the OpenRouter public list

Options:
  --help, -h      Show this help and exit
  --version, -v   Show the installed version and exit

Tollwise is a local-first smart-routing proxy for LLM APIs. Point the
official OpenAI or Anthropic SDK's base_url at Tollwise once it is running.
`;

const CONFIG_USAGE = `Usage: tollwise config check [--config <path>]

Validates the configuration and prints the effective settings. API keys are
never printed, only whether each one is set.

The configuration file is, in order: the --config path, else the file named by
TOLLWISE_CONFIG, else ./tollwise.yaml if present. Without any file Tollwise
runs on built-in defaults. TOLLWISE_HOST, TOLLWISE_PORT and TOLLWISE_LOG_LEVEL
override the file; TOLLWISE_ACCESS_KEY is read from the environment only.

Exit codes: 0 valid, 1 invalid configuration, 2 wrong usage.
`;

const START_USAGE = `Usage: tollwise start [--config <path>]
       tollwise

Starts the proxy and keeps it running until Ctrl+C (SIGINT) or SIGTERM.
It listens on 127.0.0.1:8484 unless TOLLWISE_HOST / TOLLWISE_PORT (or
server.host / server.port in the configuration file) say otherwise, and logs
one line per request (method, path, status, duration) as JSON on stderr.

The configuration file is chosen as for "tollwise config check".

Exit codes: 0 stopped by a signal, 1 invalid configuration or cannot listen,
2 wrong usage.
`;

const CATALOG_USAGE = `Usage: tollwise catalog <command>

Commands:
  update [--write] [--source-url <url>]   Compare catalog/models.yaml against the OpenRouter public models list
`;

const CATALOG_UPDATE_USAGE = `Usage: tollwise catalog update [--write] [--source-url <url>] [--catalog <path>]

Fetches the OpenRouter public models list (no API key needed) and compares
it against the "openrouter" entries already in catalog/models.yaml: prices,
capabilities (tools, JSON mode, vision), context window and max output.
Prints a human-readable diff (changed, added, removed). A field the upstream
list does not state for a model (for example a null max output) is left as
it is in the catalog, never guessed.

Without --write, nothing on disk changes. With --write, catalog/models.yaml
is updated in place for entries whose fields changed: only those fields plus
verified_on are touched, and every comment and the entry order are
preserved. Models found upstream but not yet in the catalog ("added"), and
catalog entries no longer found upstream ("removed"), are reported but never
written automatically -- adding or dropping a catalog entry is a curation
decision for a person, not something this command decides alone.

--source-url <url>   Fetch the list from this URL instead of the default
                      (https://openrouter.ai/api/v1/models). Only http and
                      https URLs are accepted.
--catalog <path>     Compare against (and with --write, update) this catalog
                      file instead of the shipped catalog/models.yaml.

Exit codes: 0 success (whether or not differences were found), 1 could not
fetch or parse the upstream list, read the catalog or write it, 2 wrong usage.
`;

function usageError(message: string, usage: string): number {
  console.error(`tollwise: ${message}\n`);
  console.error(usage);
  return 2;
}

function printConfigError(error: ConfigError): number {
  const count = error.problems.length;
  console.error(`tollwise: the configuration is not valid (${count} problem${count === 1 ? '' : 's'}):`);
  for (const line of error.lines()) console.error(`  ${line}`);
  return 1;
}

function parseConfigFlag(
  args: readonly string[],
  usage: string,
): { configPath: string | undefined } | { exit: number } {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      return { exit: 0 };
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      if (configPath !== undefined) return { exit: usageError('--config given more than once', usage) };
      const value = arg === '--config' ? args[++index] : arg.slice('--config='.length);
      if (value === undefined || value === '') return { exit: usageError('--config needs a file path', usage) };
      configPath = value;
      continue;
    }
    return { exit: usageError(`unknown option "${arg}"`, usage) };
  }
  return { configPath };
}

async function runStart(args: readonly string[]): Promise<number> {
  const parsed = parseConfigFlag(args, START_USAGE);
  if ('exit' in parsed) return parsed.exit;
  try {
    const running = await startTollwise({ configPath: parsed.configPath });
    return await running.stopped;
  } catch (error) {
    if (error instanceof ConfigError) return printConfigError(error);
    if (error instanceof StartError) {
      console.error(`tollwise: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function runConfig(args: readonly string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(CONFIG_USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand !== 'check') return usageError(`unknown config command "${subcommand}"`, CONFIG_USAGE);

  const parsed = parseConfigFlag(rest, CONFIG_USAGE);
  if ('exit' in parsed) return parsed.exit;

  try {
    const loaded = loadConfig({ configPath: parsed.configPath });
    console.log(describeEffectiveConfig(loaded, process.env));
    return 0;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return printConfigError(error);
  }
}

async function runCatalogUpdateCommand(args: readonly string[]): Promise<number> {
  let write = false;
  let sourceUrl: string | undefined;
  let catalogPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      console.log(CATALOG_UPDATE_USAGE);
      return 0;
    }
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--source-url' || arg.startsWith('--source-url=')) {
      if (sourceUrl !== undefined) return usageError('--source-url given more than once', CATALOG_UPDATE_USAGE);
      const value = arg === '--source-url' ? args[++index] : arg.slice('--source-url='.length);
      if (value === undefined || value === '') return usageError('--source-url needs a URL', CATALOG_UPDATE_USAGE);
      sourceUrl = value;
      continue;
    }
    if (arg === '--catalog' || arg.startsWith('--catalog=')) {
      if (catalogPath !== undefined) return usageError('--catalog given more than once', CATALOG_UPDATE_USAGE);
      const value = arg === '--catalog' ? args[++index] : arg.slice('--catalog='.length);
      if (value === undefined || value === '') return usageError('--catalog needs a path', CATALOG_UPDATE_USAGE);
      catalogPath = value;
      continue;
    }
    return usageError(`unknown option "${arg}"`, CATALOG_UPDATE_USAGE);
  }

  try {
    const result = await runCatalogUpdate({
      write,
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(catalogPath !== undefined ? { catalogPath: path.resolve(catalogPath) } : {}),
    });
    console.log(result.report);
    if (result.wrote) {
      console.log(
        `\nWrote ${result.diff.changed.length} changed model${result.diff.changed.length === 1 ? '' : 's'} to ${toTerminalText(catalogPath ?? 'catalog/models.yaml')}.`,
      );
    } else if (!write && result.diff.changed.length > 0) {
      console.log('\nRun again with --write to apply the changed fields above.');
    }
    return 0;
  } catch (error) {
    if (error instanceof UpdateError || error instanceof CatalogError) {
      // Messages may quote catalog or upstream text: keep their line breaks, escape everything else.
      console.error(`tollwise: ${toTerminalText(error.message, { keepNewlines: true })}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`tollwise: catalog update failed: ${toTerminalText(message)}`);
    }
    return 1;
  }
}

function runCatalog(args: readonly string[]): number | Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(CATALOG_USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand !== 'update') return usageError(`unknown catalog command "${subcommand}"`, CATALOG_USAGE);
  return runCatalogUpdateCommand(rest);
}

export function run(argv: readonly string[]): number | Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) return runStart([]);

  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    console.log(readPackageInfo().version);
    return 0;
  }

  if (command === 'start') return runStart(rest);
  if (command === 'config') return runConfig(rest);
  if (command === 'catalog') return runCatalog(rest);

  console.error(`tollwise: unknown command "${command}"\n`);
  console.error(USAGE);
  return 1;
}

// This file is only ever used as the CLI entry point (the package's "bin" target),
// never imported as a library, so it always executes when loaded.
Promise.resolve()
  .then(() => run(process.argv.slice(2)))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`tollwise: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
