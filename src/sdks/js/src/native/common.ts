import type { BackupFormat } from '../types.js';

export const ABI_VERSION = 6;
export const RESTORE_REPLACE_EXISTING = 1n;
export const DEFAULT_LIBOLIPHAUNT_REPOSITORY = 'f0rr0/oliphaunt';
export const DEFAULT_LIBOLIPHAUNT_RELEASE_TAG_PREFIX = 'liboliphaunt-native-v';
export const LIBOLIPHAUNT_RELEASE_ASSET_DIR_ENV = 'OLIPHAUNT_LIBOLIPHAUNT_ASSET_DIR';
export const LIBOLIPHAUNT_CACHE_DIR_ENV = 'OLIPHAUNT_CACHE_DIR';
export const LIBOLIPHAUNT_RELEASE_BASE_URL_ENV = 'OLIPHAUNT_RELEASE_BASE_URL';
export const LIBOLIPHAUNT_RUNTIME_DIR_ENV = 'OLIPHAUNT_RUNTIME_DIR';

export const CAP_PROTOCOL_RAW = 1n << 0n;
export const CAP_PROTOCOL_STREAM = 1n << 1n;
export const CAP_MULTI_INSTANCE = 1n << 2n;
export const CAP_SERVER_MODE = 1n << 3n;
export const CAP_EXTENSIONS = 1n << 4n;
export const CAP_QUERY_CANCEL = 1n << 5n;
export const CAP_BACKUP_RESTORE = 1n << 6n;
export const CAP_SIMPLE_QUERY = 1n << 7n;
export const CAP_LOGICAL_REOPEN = 1n << 9n;

export type NativeReleaseTarget = {
  id: string;
  assetName: string;
  libraryRelativePath: string;
  runtimeRelativePath: string;
};

export function resolveLibraryPath(libraryPath?: string): string {
  const resolved = resolveExplicitLibraryPath(libraryPath);
  if (resolved === undefined || resolved.trim().length === 0) {
    throw new Error(
      'no liboliphaunt native asset is available; pass libraryPath, set LIBOLIPHAUNT_PATH, or allow the SDK to resolve the compatible liboliphaunt release asset',
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

export function liboliphauntReleaseTag(version: string): string {
  validateVersion(version);
  return `${DEFAULT_LIBOLIPHAUNT_RELEASE_TAG_PREFIX}${version}`;
}

export function liboliphauntReleaseAssetBaseUrl(version: string): string {
  const override = envVar(LIBOLIPHAUNT_RELEASE_BASE_URL_ENV);
  if (override !== undefined && override.trim().length > 0) {
    return override.replace(/\/+$/, '');
  }
  return `https://github.com/${DEFAULT_LIBOLIPHAUNT_REPOSITORY}/releases/download/${liboliphauntReleaseTag(
    version,
  )}`;
}

export function liboliphauntChecksumAssetName(version: string): string {
  validateVersion(version);
  return `liboliphaunt-${version}-release-assets.sha256`;
}

export function liboliphauntReleaseAssetUrl(version: string, assetName: string): string {
  validateAssetName(assetName);
  return `${liboliphauntReleaseAssetBaseUrl(version)}/${assetName}`;
}

export function liboliphauntReleaseTarget(
  version: string,
  platform: string,
  architecture: string,
): NativeReleaseTarget {
  validateVersion(version);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArchitecture(architecture);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      assetName: `liboliphaunt-${version}-macos-arm64.tar.gz`,
      libraryRelativePath: 'lib/liboliphaunt.dylib',
      runtimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      assetName: `liboliphaunt-${version}-linux-x64-gnu.tar.gz`,
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      assetName: `liboliphaunt-${version}-linux-arm64-gnu.tar.gz`,
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      assetName: `liboliphaunt-${version}-windows-x64-msvc.zip`,
      libraryRelativePath: 'bin/oliphaunt.dll',
      runtimeRelativePath: 'runtime',
    };
  }
  throw new Error(
    `no liboliphaunt ${version} release asset is defined for ${platform}/${architecture}; pass libraryPath and runtimeDirectory explicitly for this platform`,
  );
}

export function parseReleaseChecksumManifest(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\.\/*([^/\0][^\0]*)$/.exec(line);
    if (match === null) {
      throw new Error(`malformed release checksum line ${index + 1}: ${rawLine}`);
    }
    const digest = match[1];
    const asset = match[2];
    if (digest === undefined || asset === undefined) {
      throw new Error(`malformed release checksum line ${index + 1}: ${rawLine}`);
    }
    checksums.set(asset, digest.toLowerCase());
  }
  return checksums;
}

export function checksumForReleaseAsset(
  checksums: ReadonlyMap<string, string>,
  assetName: string,
): string {
  validateAssetName(assetName);
  const checksum = checksums.get(assetName);
  if (checksum === undefined) {
    throw new Error(`release checksum manifest does not cover ${assetName}`);
  }
  return checksum;
}

export function assertSha256Matches(assetName: string, expected: string, actual: string): void {
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(
      `checksum mismatch for ${assetName}: expected ${expected.toLowerCase()}, got ${actual.toLowerCase()}`,
    );
  }
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

function validateVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`invalid liboliphaunt release version '${version}'`);
  }
}

function validateAssetName(assetName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(assetName) || assetName.includes('..')) {
    throw new Error(`invalid liboliphaunt release asset name '${assetName}'`);
  }
}
