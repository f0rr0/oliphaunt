import type { BackupFormat } from '../types.js';

export const ABI_VERSION = 6;
export const RESTORE_REPLACE_EXISTING = 1n;
export const LIBOLIPHAUNT_RUNTIME_DIR_ENV = 'OLIPHAUNT_RUNTIME_DIR';
export const OLIPHAUNT_ICU_DATA_DIR_ENV = 'OLIPHAUNT_ICU_DATA_DIR';
export const ICU_DATA_ENV = 'ICU_DATA';
export const OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV = 'OLIPHAUNT_EMBEDDED_MODULE_DIR';

export const CAP_PROTOCOL_RAW = 1n << 0n;
export const CAP_PROTOCOL_STREAM = 1n << 1n;
export const CAP_MULTI_INSTANCE = 1n << 2n;
export const CAP_SERVER_MODE = 1n << 3n;
export const CAP_EXTENSIONS = 1n << 4n;
export const CAP_QUERY_CANCEL = 1n << 5n;
export const CAP_BACKUP_RESTORE = 1n << 6n;
export const CAP_SIMPLE_QUERY = 1n << 7n;
export const CAP_LOGICAL_REOPEN = 1n << 9n;

export type NativePackageTarget = {
  id: string;
  packageName: string;
  libraryRelativePath: string;
  runtimeRelativePath: string;
  toolsPackageName: string;
  toolsRuntimeRelativePath: string;
};

export function resolveLibraryPath(libraryPath?: string): string {
  const resolved = resolveExplicitLibraryPath(libraryPath);
  if (resolved === undefined || resolved.trim().length === 0) {
    throw new Error(
      'no liboliphaunt native asset is available; pass libraryPath, set LIBOLIPHAUNT_PATH, or install the compatible @oliphaunt/liboliphaunt-* package',
    );
  }
  return resolved;
}

export function resolveExplicitLibraryPath(libraryPath?: string): string | undefined {
  const resolved = libraryPath ?? envVar('LIBOLIPHAUNT_PATH');
  if (resolved === undefined || resolved.trim().length === 0) {
    return undefined;
  }
  if (resolved.includes('\0')) {
    throw new Error('libraryPath must not contain NUL bytes');
  }
  return resolved;
}

export function resolveExplicitRuntimeDirectory(): string | undefined {
  const resolved = envVar(LIBOLIPHAUNT_RUNTIME_DIR_ENV);
  if (resolved === undefined || resolved.trim().length === 0) {
    return undefined;
  }
  if (resolved.includes('\0')) {
    throw new Error(`${LIBOLIPHAUNT_RUNTIME_DIR_ENV} must not contain NUL bytes`);
  }
  return resolved;
}

export function applyNativeIcuDataEnvironment(icuDataDirectory?: string): void {
  if (icuDataDirectory === undefined || icuDataDirectory.trim().length === 0) {
    return;
  }
  if (icuDataDirectory.includes('\0')) {
    throw new Error(`${OLIPHAUNT_ICU_DATA_DIR_ENV} must not contain NUL bytes`);
  }
  setRuntimeEnvironment(OLIPHAUNT_ICU_DATA_DIR_ENV, icuDataDirectory);
  setRuntimeEnvironment(ICU_DATA_ENV, icuDataDirectory);
}

export function applyNativeModuleEnvironment(moduleDirectory?: string): void {
  if (moduleDirectory === undefined || moduleDirectory.trim().length === 0) {
    return;
  }
  if (moduleDirectory.includes('\0')) {
    throw new Error(`${OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV} must not contain NUL bytes`);
  }
  setRuntimeEnvironment(OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV, moduleDirectory);
}

export function liboliphauntPackageTarget(
  platform: string,
  architecture: string,
): NativePackageTarget {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArchitecture(architecture);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      packageName: '@oliphaunt/liboliphaunt-darwin-arm64',
      libraryRelativePath: 'lib/liboliphaunt.dylib',
      runtimeRelativePath: 'runtime',
      toolsPackageName: '@oliphaunt/tools-darwin-arm64',
      toolsRuntimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      packageName: '@oliphaunt/liboliphaunt-linux-x64-gnu',
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
      toolsPackageName: '@oliphaunt/tools-linux-x64-gnu',
      toolsRuntimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      packageName: '@oliphaunt/liboliphaunt-linux-arm64-gnu',
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
      toolsPackageName: '@oliphaunt/tools-linux-arm64-gnu',
      toolsRuntimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      packageName: '@oliphaunt/liboliphaunt-win32-x64-msvc',
      libraryRelativePath: 'bin/oliphaunt.dll',
      runtimeRelativePath: 'runtime',
      toolsPackageName: '@oliphaunt/tools-win32-x64-msvc',
      toolsRuntimeRelativePath: 'runtime',
    };
  }
  throw new Error(
    `no liboliphaunt package is defined for ${platform}/${architecture}; pass libraryPath and runtimeDirectory explicitly for this platform`,
  );
}

export function nativeBackupFormat(format: BackupFormat): number {
  switch (format) {
    case 'physicalArchive':
      return 2;
    case 'sql':
      return 1;
    case 'oliphauntArchive':
      return 3;
  }
}

export function assertSupportedDirectBackupFormat(format: BackupFormat): void {
  if (format !== 'physicalArchive') {
    throw new Error(`${format} backup is not supported by nativeDirect`);
  }
}

export function errorMessage(prefix: string, status: number, lastError?: string | null): Error {
  const detail = lastError && lastError.length > 0 ? lastError : `status ${status}`;
  return new Error(`${prefix}: ${detail}`);
}

export function envVar(name: string): string | undefined {
  const processEnv = globalThis.process?.env?.[name];
  if (processEnv !== undefined) {
    return processEnv;
  }
  const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno;
  try {
    return deno?.env?.get(name);
  } catch {
    return undefined;
  }
}

function setRuntimeEnvironment(name: string, value: string): void {
  const processEnv = globalThis.process?.env;
  if (processEnv !== undefined) {
    processEnv[name] = value;
    return;
  }
  const deno = (globalThis as { Deno?: { env?: { set(name: string, value: string): void } } })
    .Deno;
  if (deno?.env?.set === undefined) {
    throw new Error(`cannot set ${name}; this JavaScript runtime does not expose process.env or Deno.env`);
  }
  try {
    deno.env.set(name, value);
  } catch (error) {
    throw new Error(`cannot set ${name}; grant environment-write permission for native runtime data`, {
      cause: error,
    });
  }
}

function normalizePlatform(platform: string): string {
  switch (platform) {
    case 'darwin':
    case 'macos':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
    case 'windows':
      return 'windows';
    default:
      return platform;
  }
}

function normalizeArchitecture(architecture: string): string {
  switch (architecture) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x64':
    case 'x86_64':
      return 'x64';
    default:
      return architecture;
  }
}
