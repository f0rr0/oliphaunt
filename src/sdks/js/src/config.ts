import { join } from 'node:path';

import {
  generatedExtensionBySqlName,
  generatedSharedPreloadLibraries,
} from './generated/extensions.js';
import type { OpenConfig, ServerListen, ServerOpenConfig } from './types.js';

type Execution = 'direct' | 'broker' | 'server';

type AnyOpenConfig = OpenConfig | (ServerOpenConfig & { execution: 'server' });

export const DEFAULT_USERNAME = 'postgres';
export const DEFAULT_DATABASE = 'postgres';

export type NormalizedOpenConfig = {
  execution: Execution;
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
  const execution = config.execution ?? 'direct';
  const serverListen = 'listen' in config ? validateServerListen(config.listen) : undefined;

  return {
    execution,
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
  const assignments = [...validateStartupGUCs(options.startupGUCs ?? {})];
  const preloadLibraries = requiredSharedPreloadLibraries(extensions);
  if (preloadLibraries.length > 0) {
    assignments.push(`shared_preload_libraries=${preloadLibraries.join(',')}`);
  }

  return assignments.flatMap((assignment) => ['-c', assignment]);
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
  return Object.entries(gucs).map(([name, value]) => {
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
    return `${trimmedName}=${value}`;
  });
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
