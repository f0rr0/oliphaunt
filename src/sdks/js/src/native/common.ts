export const ABI_VERSION = 10;
export const LIBOLIPHAUNT_RUNTIME_DIR_ENV = 'OLIPHAUNT_RUNTIME_DIR';
export const OLIPHAUNT_ICU_DATA_DIR_ENV = 'OLIPHAUNT_ICU_DATA_DIR';
export const ICU_DATA_ENV = 'ICU_DATA';
export const OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV = 'OLIPHAUNT_EMBEDDED_MODULE_DIR';
export const INTERNAL_NATIVE_POSTGRES_ENVIRONMENT = [
  'OLIPHAUNT_INTERNAL_ICU_READY',
  'OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY',
  'OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY',
] as const;

export type NativePackageTarget = {
  id: string;
  packageName: string;
  libraryRelativePath: string;
  runtimeRelativePath: string;
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

/** Replace ambient ICU selection with one exact resolved runtime closure. */
export function replaceNativeIcuDataEnvironment(icuDataDirectory?: string): void {
  if (icuDataDirectory === undefined) {
    unsetRuntimeEnvironment(OLIPHAUNT_ICU_DATA_DIR_ENV);
    unsetRuntimeEnvironment(ICU_DATA_ENV);
    return;
  }
  if (icuDataDirectory.trim().length === 0 || icuDataDirectory.includes('\0')) {
    throw new Error(`${OLIPHAUNT_ICU_DATA_DIR_ENV} must be a nonempty path without NUL bytes`);
  }
  setRuntimeEnvironment(OLIPHAUNT_ICU_DATA_DIR_ENV, icuDataDirectory);
  setRuntimeEnvironment(ICU_DATA_ENV, icuDataDirectory);
}

export function nativeRuntimeLibraryEnvironment(
  runtimeDirectory?: string,
  platformName: string = runtimePlatform(),
): Record<string, string> {
  if (runtimeDirectory === undefined || runtimeDirectory.trim().length === 0) return {};
  if (runtimeDirectory.includes('\0')) {
    throw new Error('runtimeDirectory must not contain NUL bytes');
  }
  const platform = normalizePlatform(platformName);
  const name =
    platform === 'windows'
      ? 'PATH'
      : platform === 'darwin'
        ? 'DYLD_LIBRARY_PATH'
        : 'LD_LIBRARY_PATH';
  const separator = platform === 'windows' ? ';' : ':';
  const directories =
    platform === 'windows'
      ? [`${runtimeDirectory}\\bin`, `${runtimeDirectory}\\lib`]
      : [`${runtimeDirectory}/lib`];
  const existing = envVar(name);
  const value = [...directories, ...(existing === undefined ? [] : existing.split(separator))]
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index)
    .join(separator);
  return { [name]: value };
}

export function applyNativeRuntimeLibraryEnvironment(runtimeDirectory?: string): void {
  for (const [name, value] of Object.entries(nativeRuntimeLibraryEnvironment(runtimeDirectory))) {
    setRuntimeEnvironment(name, value);
  }
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
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      packageName: '@oliphaunt/liboliphaunt-linux-x64-gnu',
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      packageName: '@oliphaunt/liboliphaunt-linux-arm64-gnu',
      libraryRelativePath: 'lib/liboliphaunt.so',
      runtimeRelativePath: 'runtime',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      packageName: '@oliphaunt/liboliphaunt-win32-x64-msvc',
      libraryRelativePath: 'bin/oliphaunt.dll',
      runtimeRelativePath: 'runtime',
    };
  }
  throw new Error(
    `no liboliphaunt package is defined for ${platform}/${architecture}; pass libraryPath and runtimeDirectory explicitly for this platform`,
  );
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
  const deno = (
    globalThis as {
      Deno?: { env?: { set(name: string, value: string): void } };
    }
  ).Deno;
  if (deno?.env?.set === undefined) {
    throw new Error(
      `cannot set ${name}; this JavaScript runtime does not expose process.env or Deno.env`,
    );
  }
  try {
    deno.env.set(name, value);
  } catch (error) {
    throw new Error(
      `cannot set ${name}; grant environment-write permission for native runtime data`,
      {
        cause: error,
      },
    );
  }
}

function unsetRuntimeEnvironment(name: string): void {
  const processEnv = globalThis.process?.env;
  if (processEnv !== undefined) {
    delete processEnv[name];
    return;
  }
  const deno = (globalThis as { Deno?: { env?: { delete(name: string): void } } }).Deno;
  if (deno?.env?.delete === undefined) return;
  try {
    deno.env.delete(name);
  } catch (error) {
    throw new Error(
      `cannot clear ${name}; grant environment-write permission for native runtime data`,
      { cause: error },
    );
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

function runtimePlatform(): string {
  const processPlatform = globalThis.process?.platform;
  if (typeof processPlatform === 'string') return processPlatform;
  const deno = (globalThis as { Deno?: { build?: { os?: string } } }).Deno;
  return deno?.build?.os ?? 'unknown';
}
