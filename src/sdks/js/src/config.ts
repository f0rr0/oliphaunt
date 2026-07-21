import { join } from 'node:path';

import {
  generatedExtensionBySqlName,
  generatedSharedPreloadLibraries,
} from './generated/extensions.js';
import type {
  BrokerTransport,
  DurabilityProfile,
  EngineMode,
  OpenConfig,
  PostgresStartupGUC,
  RuntimeFootprintProfile,
} from './types.js';

export const DEFAULT_USERNAME = 'postgres';
export const DEFAULT_DATABASE = 'postgres';

export type NormalizedOpenConfig = {
  engine: EngineMode;
  root: string;
  pgdata: string;
  temporary: boolean;
  durability: DurabilityProfile;
  runtimeFootprint: RuntimeFootprintProfile;
  startupArgs: string[];
  username: string;
  database: string;
  extensions: string[];
  libraryPath?: string;
  runtimeDirectory?: string;
  maxClientSessions: number;
  brokerExecutable?: string;
  brokerMaxRoots: number;
  brokerTransport: BrokerTransport;
  serverExecutable?: string;
  serverPort?: number;
  serverToolDirectory?: string;
};

export function normalizeOpenConfig(
  config: OpenConfig,
  resolvedRoot: string,
): NormalizedOpenConfig {
  if (config.root !== undefined && config.temporary === true) {
    throw new Error('root and temporary are mutually exclusive');
  }
  validateRootPath(resolvedRoot, 'database root');
  validateStartupIdentity(config.username ?? DEFAULT_USERNAME, 'username');
  validateStartupIdentity(config.database ?? DEFAULT_DATABASE, 'database');
  const runtimeFootprint = normalizeRuntimeFootprint(config.runtimeFootprint ?? 'throughput');
  const durability = normalizeDurability(config.durability ?? 'safe');
  const extensions = config.extensions ? validateExtensionIds(config.extensions) : [];
  const startupArgs = buildStartupArgs({
    durability,
    runtimeFootprint,
    startupGUCs: config.startupGUCs ?? [],
    extensions,
  });
  const libraryPath = validateOptionalPathOverride(config.libraryPath, 'libraryPath');
  const runtimeDirectory = validateOptionalPathOverride(
    config.runtimeDirectory,
    'runtimeDirectory',
  );
  const brokerExecutable = validateOptionalPathOverride(
    config.brokerExecutable,
    'brokerExecutable',
  );
  const serverExecutable = validateOptionalPathOverride(
    config.serverExecutable,
    'serverExecutable',
  );
  const serverToolDirectory = validateOptionalPathOverride(
    config.serverToolDirectory,
    'serverToolDirectory',
  );
  const engine = config.engine ?? 'nativeDirect';
  const maxClientSessions = validateMaxClientSessions(config.maxClientSessions, engine);
  const brokerMaxRoots = validateBrokerMaxRoots(config.brokerMaxRoots);
  const brokerTransport = validateBrokerTransport(config.brokerTransport ?? 'auto');
  const serverPort = validateServerPort(config.serverPort);

  return {
    engine,
    root: resolvedRoot,
    pgdata: join(resolvedRoot, 'pgdata'),
    temporary: config.temporary === true,
    durability,
    runtimeFootprint,
    startupArgs,
    username: config.username ?? DEFAULT_USERNAME,
    database: config.database ?? DEFAULT_DATABASE,
    extensions,
    libraryPath,
    runtimeDirectory,
    maxClientSessions,
    brokerExecutable,
    brokerMaxRoots,
    brokerTransport,
    serverExecutable,
    serverPort,
    serverToolDirectory,
  };
}

export function buildStartupArgs(options: {
  durability: DurabilityProfile;
  runtimeFootprint: RuntimeFootprintProfile;
  startupGUCs?: ReadonlyArray<PostgresStartupGUC>;
  extensions?: ReadonlyArray<string>;
}): string[] {
  const extensions = validateExtensionIds(options.extensions ?? []);
  const assignments = [
    ...runtimeFootprintAssignments(options.runtimeFootprint),
    ...durabilityAssignments(options.durability),
    ...validateStartupGUCs(options.startupGUCs ?? []),
  ];
  const preloadLibraries = requiredSharedPreloadLibraries(extensions);
  if (preloadLibraries.length > 0) {
    assignments.push(`shared_preload_libraries=${preloadLibraries.join(',')}`);
  }

  return assignments.flatMap((assignment) => ['-c', assignment]);
}

export function validateRootPath(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    throw new Error(rootPathMessage(label, 'empty'));
  }
  if (value.includes('\0')) {
    throw new Error(rootPathMessage(label, 'nul'));
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

export function validateMaxClientSessions(value: number | undefined, engine: EngineMode): number {
  const sessions = value ?? (engine === 'nativeServer' ? 32 : 1);
  if (!Number.isInteger(sessions)) {
    throw new Error('maxClientSessions must be an integer');
  }
  if (sessions <= 0) {
    throw new Error(
      engine === 'nativeServer'
        ? 'native server maxClientSessions must be greater than zero'
        : `${engine} maxClientSessions must be exactly 1`,
    );
  }
  if (engine !== 'nativeServer' && sessions !== 1) {
    throw new Error(`${engine} supports exactly 1 client session, got ${sessions}`);
  }
  return sessions;
}

export function validateBrokerMaxRoots(value: number | undefined): number {
  const roots = value ?? 1;
  if (!Number.isInteger(roots)) {
    throw new Error('brokerMaxRoots must be an integer');
  }
  if (roots <= 0) {
    throw new Error('native broker max_roots must be greater than zero');
  }
  return roots;
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

export function validateBrokerTransport(value: BrokerTransport): BrokerTransport {
  if (value === 'auto' || value === 'unix' || value === 'tcp') {
    return value;
  }
  throw new Error(`unknown native broker transport '${value}'`);
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

export function validateStartupGUCs(gucs: ReadonlyArray<PostgresStartupGUC>): string[] {
  return gucs.map((guc) => {
    const [name, value] =
      typeof guc === 'string' ? splitStartupGUCAssignment(guc) : [guc.name, guc.value];
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error('PostgreSQL startup GUC name must not be empty');
    }
    if (trimmedName.includes('\0') || value.includes('\0')) {
      throw new Error('PostgreSQL startup GUC must not contain NUL bytes');
    }
    if (!/^[A-Za-z0-9_.]+$/.test(trimmedName)) {
      throw new Error(
        `PostgreSQL startup GUC name '${name}' must contain only ASCII letters, digits, '_' or '.'`,
      );
    }
    if (value.trim().length === 0) {
      throw new Error(`PostgreSQL startup GUC '${name}' value must not be empty`);
    }
    return `${trimmedName}=${value}`;
  });
}

export function normalizeRuntimeFootprint(
  profile: RuntimeFootprintProfile,
): RuntimeFootprintProfile {
  if (profile === 'throughput' || profile === 'balancedMobile' || profile === 'smallMobile') {
    return profile;
  }
  throw new Error(`unknown liboliphaunt runtime footprint profile '${profile}'`);
}

export function normalizeDurability(profile: DurabilityProfile): DurabilityProfile {
  if (profile === 'safe' || profile === 'balanced' || profile === 'fastDev') {
    return profile;
  }
  throw new Error(`unknown liboliphaunt durability profile '${profile}'`);
}

function runtimeFootprintAssignments(profile: RuntimeFootprintProfile): string[] {
  switch (profile) {
    case 'throughput':
      return ['shared_buffers=128MB', 'wal_buffers=4MB', 'min_wal_size=80MB'];
    case 'balancedMobile':
      return [
        'max_connections=1',
        'superuser_reserved_connections=0',
        'reserved_connections=0',
        'autovacuum_worker_slots=1',
        'max_wal_senders=0',
        'max_replication_slots=0',
        'shared_buffers=32MB',
        'wal_buffers=-1',
        'min_wal_size=32MB',
        'max_wal_size=64MB',
        'io_method=sync',
        'io_max_concurrency=1',
      ];
    case 'smallMobile':
      return [
        'max_connections=1',
        'superuser_reserved_connections=0',
        'reserved_connections=0',
        'autovacuum_worker_slots=1',
        'max_wal_senders=0',
        'max_replication_slots=0',
        'shared_buffers=8MB',
        'wal_buffers=256kB',
        'min_wal_size=32MB',
        'max_wal_size=64MB',
        'work_mem=1MB',
        'maintenance_work_mem=16MB',
        'io_method=sync',
        'io_max_concurrency=1',
      ];
  }
}

function durabilityAssignments(profile: DurabilityProfile): string[] {
  switch (profile) {
    case 'safe':
      return ['fsync=on', 'full_page_writes=on', 'synchronous_commit=on'];
    case 'balanced':
      return ['fsync=on', 'full_page_writes=on', 'synchronous_commit=off'];
    case 'fastDev':
      return ['fsync=off', 'full_page_writes=off', 'synchronous_commit=off'];
  }
}

function requiredSharedPreloadLibraries(extensions: ReadonlyArray<string>): string[] {
  return generatedSharedPreloadLibraries(extensions);
}

function splitStartupGUCAssignment(assignment: string): [string, string] {
  const index = assignment.indexOf('=');
  if (index < 0) {
    throw new Error('PostgreSQL startup GUC string must use name=value');
  }
  return [assignment.slice(0, index), assignment.slice(index + 1)];
}

function rootPathMessage(label: string, reason: 'empty' | 'nul'): string {
  switch (`${label}:${reason}`) {
    case 'database root:empty':
      return 'database root must not be empty';
    case 'database root:nul':
      return 'database root must not contain NUL bytes';
    case 'restore root:empty':
      return 'restore root must not be empty';
    case 'restore root:nul':
      return 'restore root must not contain NUL bytes';
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
    case 'serverToolDirectory:empty':
      return 'serverToolDirectory must not be empty';
    case 'serverToolDirectory:nul':
      return 'serverToolDirectory must not contain NUL bytes';
    default:
      return reason === 'empty'
        ? `${label} must not be empty`
        : `${label} must not contain NUL bytes`;
  }
}
