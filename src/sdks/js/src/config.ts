import { join } from 'node:path';

import {
  generatedExtensionBySqlName,
  generatedSharedPreloadLibraries,
} from './generated/extensions.js';
import type { OpenConfig, ServerListen, ServerOpenConfig } from './types.js';

type RuntimeTopology = 'direct' | 'broker' | 'server';
export type DatabaseTopology = Exclude<RuntimeTopology, 'server'>;

type AnyOpenConfig = OpenConfig | (ServerOpenConfig & { topology: 'server' });

export const DEFAULT_USERNAME = 'postgres';
export const DEFAULT_DATABASE = 'postgres';
const SERVER_OWNED_STARTUP_GUCS = new Set(['listen_addresses', 'port', 'unix_socket_directories']);
const STORAGE_OWNED_STARTUP_GUCS = new Set(['config_file', 'data_directory']);

export type NormalizedOpenConfig = {
  topology: RuntimeTopology;
  instanceDirectory: string;
  pgdata: string;
  temporaryDirectory: boolean;
  startupArgs: string[];
  username: string;
  database: string;
  extensions: string[];
  libraryPath?: string;
  runtimeDirectory?: string;
  brokerExecutable?: string;
  serverExecutable?: string;
  serverListen?: ServerListen;
};

export function normalizeOpenConfig(
  config: AnyOpenConfig,
  resolvedStorage: {
    instanceDirectory: string;
    temporaryDirectory: boolean;
  },
): NormalizedOpenConfig {
  validateDirectoryPath(resolvedStorage.instanceDirectory, 'database storage directory');
  validateStartupIdentity(config.username ?? DEFAULT_USERNAME, 'username');
  validateStartupIdentity(config.database ?? DEFAULT_DATABASE, 'database');
  const extensions = config.extensions ? validateExtensionIds(config.extensions) : [];
  const topology =
    config.topology === 'server' ? 'server' : normalizeDatabaseTopology(config.topology);
  validateNativeStartupGUCs(topology, config.startupGUCs ?? {});
  const startupArgs = buildStartupArgs({
    startupGUCs: config.startupGUCs ?? {},
    extensions,
  });
  const libraryPath = validateOptionalPathOverride(
    'libraryPath' in config ? config.libraryPath : undefined,
    'libraryPath',
  );
  const runtimeDirectory = validateOptionalPathOverride(
    config.runtimeDirectory,
    'runtimeDirectory',
  );
  const brokerExecutable = validateOptionalPathOverride(
    'brokerExecutable' in config ? config.brokerExecutable : undefined,
    'brokerExecutable',
  );
  const serverExecutable = validateOptionalPathOverride(
    'serverExecutable' in config ? config.serverExecutable : undefined,
    'serverExecutable',
  );
  const serverListen = 'listen' in config ? validateServerListen(config.listen) : undefined;

  return {
    topology,
    instanceDirectory: resolvedStorage.instanceDirectory,
    pgdata: join(resolvedStorage.instanceDirectory, 'pgdata'),
    temporaryDirectory: resolvedStorage.temporaryDirectory,
    startupArgs,
    username: config.username ?? DEFAULT_USERNAME,
    database: config.database ?? DEFAULT_DATABASE,
    extensions,
    libraryPath,
    runtimeDirectory,
    brokerExecutable,
    serverExecutable,
    serverListen,
  };
}

export function normalizeDatabaseTopology(value: unknown): DatabaseTopology {
  if (value === undefined || value === 'direct') return 'direct';
  if (value === 'broker') return 'broker';
  throw new TypeError(
    `native database topology must be "direct" or "broker", received ${String(value)}`,
  );
}

function validateServerListen(listen: ServerListen | undefined): ServerListen | undefined {
  if (listen === undefined) {
    return undefined;
  }
  const port = validateServerPort(listen.port);
  if (listen.transport === 'tcp') {
    return port === undefined ? { transport: 'tcp' } : { transport: 'tcp', port };
  }
  validateDirectoryPath(listen.directory, 'server Unix socket directory');
  return port === undefined
    ? { transport: 'unix', directory: listen.directory }
    : { transport: 'unix', directory: listen.directory, port };
}

export function buildStartupArgs(options: {
  startupGUCs?: Readonly<Record<string, string>>;
  extensions?: ReadonlyArray<string>;
}): string[] {
  const extensions = validateExtensionIds(options.extensions ?? []);
  const entries = normalizedStartupGUCEntries(options.startupGUCs ?? {});
  const preloadLibraries = requiredSharedPreloadLibraries(extensions);
  if (preloadLibraries.length === 0) {
    return startupArgs(entries);
  }

  const configuredPreloads = entries.find(({ name }) => name === 'shared_preload_libraries')?.value;
  const assignments = entries.filter(({ name }) => name !== 'shared_preload_libraries');
  const mergedPreloads: string[] = [];
  const seenPreloads = new Set<string>();
  appendUniqueCsvValues(configuredPreloads, mergedPreloads, seenPreloads);
  for (const required of preloadLibraries) {
    appendUniqueCsvValues(required, mergedPreloads, seenPreloads);
  }
  assignments.push({
    name: 'shared_preload_libraries',
    value: mergedPreloads.join(','),
  });
  return startupArgs(assignments);
}

export function validateNativeStartupGUCs(
  topology: RuntimeTopology,
  gucs: Readonly<Record<string, string>>,
): void {
  for (const { name } of normalizedStartupGUCEntries(gucs)) {
    if (STORAGE_OWNED_STARTUP_GUCS.has(name)) {
      throw new Error(
        `Oliphaunt owns PostgreSQL startup GUC '${name}'; configure database storage through Oliphaunt open options`,
      );
    }
    if (topology === 'server' && SERVER_OWNED_STARTUP_GUCS.has(name)) {
      throw new Error(
        `native server owns PostgreSQL startup GUC '${name}'; configure storage and listen through Oliphaunt.openServer()`,
      );
    }
  }
}

function startupArgs(entries: ReadonlyArray<NormalizedStartupGUC>): string[] {
  return entries.flatMap(({ name, value }) => ['-c', `${name}=${value}`]);
}

function appendUniqueCsvValues(
  value: string | undefined,
  ordered: string[],
  seen: Set<string>,
): void {
  for (const item of value?.split(',') ?? []) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
}

export function validateDirectoryPath(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    throw new Error(directoryPathMessage(label, 'empty'));
  }
  if (value.includes('\0')) {
    throw new Error(directoryPathMessage(label, 'nul'));
  }
}

export function validateStartupIdentity(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
}

export function validateOptionalPathOverride(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(pathOverrideMessage(label, 'empty'));
  }
  if (value.includes('\0')) {
    throw new Error(pathOverrideMessage(label, 'nul'));
  }
  return value;
}

export function validateServerPort(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error('native server port must be an integer');
  }
  if (value <= 0 || value > 0xffff) {
    throw new Error('native server port must be in the range 1..65535');
  }
  return value;
}

export function validateExtensionIds(extensions: ReadonlyArray<string>): string[] {
  const normalized: string[] = [];
  for (const extension of extensions) {
    const trimmed = extension.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) {
      throw new Error(
        `Oliphaunt extension id '${trimmed}' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'`,
      );
    }
    if (generatedExtensionBySqlName(trimmed) === undefined) {
      throw new Error(`unknown Oliphaunt extension id '${trimmed}'`);
    }
    normalized.push(trimmed);
  }
  return normalized;
}

export function validateStartupGUCs(gucs: Readonly<Record<string, string>>): string[] {
  return normalizedStartupGUCEntries(gucs).map(({ name, value }) => `${name}=${value}`);
}

type NormalizedStartupGUC = { name: string; value: string };

function normalizedStartupGUCEntries(
  gucs: Readonly<Record<string, string>>,
): NormalizedStartupGUC[] {
  const entries = Object.entries(gucs).map(([name, value]) => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error('PostgreSQL startup GUC name must not be empty');
    }
    if (trimmedName.includes('\0') || value.includes('\0')) {
      throw new Error('PostgreSQL startup GUC must not contain NUL bytes');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(trimmedName)) {
      throw new Error(
        `PostgreSQL startup GUC name '${name}': each dot-separated component must start with an ASCII letter or '_', followed by ASCII letters, digits, '_', or '$'`,
      );
    }
    return { name: trimmedName.toLowerCase(), value };
  });
  const lastIndexByName = new Map<string, number>();
  entries.forEach(({ name }, index) => lastIndexByName.set(name, index));
  return entries.filter(({ name }, index) => lastIndexByName.get(name) === index);
}

function requiredSharedPreloadLibraries(extensions: ReadonlyArray<string>): string[] {
  return generatedSharedPreloadLibraries(extensions);
}

function directoryPathMessage(label: string, reason: 'empty' | 'nul'): string {
  switch (`${label}:${reason}`) {
    case 'database storage directory:empty':
      return 'database storage directory must not be empty';
    case 'database storage directory:nul':
      return 'database storage directory must not contain NUL bytes';
    case 'restore destination:empty':
      return 'restore destination must not be empty';
    case 'restore destination:nul':
      return 'restore destination must not contain NUL bytes';
    default:
      return reason === 'empty'
        ? `${label} must not be empty`
        : `${label} must not contain NUL bytes`;
  }
}

function pathOverrideMessage(label: string, reason: 'empty' | 'nul'): string {
  switch (`${label}:${reason}`) {
    case 'libraryPath:empty':
      return 'libraryPath must not be empty';
    case 'libraryPath:nul':
      return 'libraryPath must not contain NUL bytes';
    case 'runtimeDirectory:empty':
      return 'runtimeDirectory must not be empty';
    case 'runtimeDirectory:nul':
      return 'runtimeDirectory must not contain NUL bytes';
    case 'brokerExecutable:empty':
      return 'brokerExecutable must not be empty';
    case 'brokerExecutable:nul':
      return 'brokerExecutable must not contain NUL bytes';
    case 'serverExecutable:empty':
      return 'serverExecutable must not be empty';
    case 'serverExecutable:nul':
      return 'serverExecutable must not contain NUL bytes';
    default:
      return reason === 'empty'
        ? `${label} must not be empty`
        : `${label} must not contain NUL bytes`;
  }
}
