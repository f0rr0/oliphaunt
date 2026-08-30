import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeWasixStorage =
  | Readonly<{ kind: 'memory' }>
  | Readonly<{ kind: 'directory'; path: string }>;

export type NativeProfile = 'standard' | 'icu';

export type NativeWasixOpenOptions = Readonly<{
  profile: NativeProfile;
  storage: NativeWasixStorage;
  username: string;
  database: string;
  startupGucs: Record<string, string>;
  extensions: string[];
}>;

export type NativeWasixServerListen =
  | Readonly<{ transport: 'tcp'; port?: number }>
  | Readonly<{ transport: 'unix'; directory: string; port?: number }>;

export type NativeWasixServerOpenOptions = NativeWasixOpenOptions &
  Readonly<{ listen: NativeWasixServerListen }>;

export type NativeWasixDatabaseHandle = {
  readonly closed: boolean;
  execProtocolRaw(request: Uint8Array): Uint8Array;
  execProtocolRawStream(
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): 'complete' | 'callbackAborted';
  backup(): Uint8Array;
  pgDump(args: string[]): NativeWasixToolResult;
  psql(args: string[], command?: string, script?: string): NativeWasixToolResult;
  close(): void;
};

export type NativeWasixActorDatabaseHandle = {
  readonly closed: boolean;
  execProtocolRaw(request: Uint8Array): Promise<Uint8Array>;
  execProtocolRawStream(
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<'complete' | 'callbackAborted'>;
  backup(): Promise<Uint8Array>;
  pgDump(args: string[]): Promise<NativeWasixToolResult>;
  psql(args: string[], command?: string, script?: string): Promise<NativeWasixToolResult>;
  close(): Promise<void>;
};

export type NativeWasixToolResult = Readonly<{
  status: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type NativeWasixServerHandle = {
  readonly connectionString: string;
  readonly closed: boolean;
  close(): Promise<void>;
};

export type NativeWasixAddon = {
  NativeWasixDatabase: {
    open(options: NativeWasixOpenOptions): NativeWasixDatabaseHandle;
    readonly prototype: NativeWasixDatabaseHandle;
  };
  NativeWasixActorDatabase: {
    open(options: NativeWasixOpenOptions): Promise<NativeWasixActorDatabaseHandle>;
    readonly prototype: NativeWasixActorDatabaseHandle;
  };
  NativeWasixServer: {
    open(options: NativeWasixServerOpenOptions): Promise<NativeWasixServerHandle>;
    readonly prototype: NativeWasixServerHandle;
  };
  restore(destination: string, bytes: Uint8Array): Promise<void>;
  restoreDirect(destination: string, bytes: Uint8Array): void;
  addonAbiVersion(): number;
  nodeApiVersion(): number;
  runtimeVersion(): string;
  supportedProfiles(): readonly NativeProfile[];
  payloadIdentity(
    component:
      | 'runtimeArchive'
      | 'standardSeedArchive'
      | 'standardSeedManifest'
      | 'icuDataArchive'
      | 'icuSeedArchive'
      | 'icuSeedManifest',
  ): string;
  extensionIdentity(sqlName: string): string;
  toolIdentity(name: 'pg_dump' | 'psql'): string;
};

type WasixPackageMetadata = Readonly<{
  name?: string;
  oliphaunt?: {
    runtimeProduct?: string;
    runtimeVersion?: string;
    wasixNapiProduct?: string;
    wasixNapiVersion?: string;
    wasixAddonAbiVersion?: number;
    nodeApiVersion?: number;
  };
}>;

type NativeCarrierMetadata = Readonly<{
  name?: string;
  version?: string;
  libc?: string[];
  oliphaunt?: {
    target?: string;
    runtimeProduct?: string;
    runtimeVersion?: string;
    addonAbiVersion?: number;
    nodeApiVersion?: number;
    profiles?: string[];
  };
}>;

type NativeTarget = Readonly<{
  id: string;
  packageName: string;
  libc?: 'glibc';
}>;

type LinuxLibc = 'glibc' | 'musl' | 'unknown';
type LinuxDiagnosticReport = Readonly<{
  header?: Readonly<{ glibcVersionRuntime?: unknown }>;
  sharedObjects?: unknown;
}>;
type DenoRuntime = Readonly<{ build?: Readonly<{ target?: unknown }> }>;

const require = createRequire(import.meta.url);
const ADDON_ENV = 'OLIPHAUNT_WASIX_NAPI';
const ADDON_STEM = 'oliphaunt_wasix_napi';
const EXPECTED_NAPI_VERSION = 8;
const PRODUCT = 'oliphaunt-wasix-napi';
let loadedAddon: NativeWasixAddon | undefined;

/** @internal Load and verify the platform addon selected by the server runtime. */
export function loadNativeWasixAddon(): NativeWasixAddon {
  if (loadedAddon !== undefined) return loadedAddon;
  const runtimeNapi = Number(process.versions.napi);
  if (!Number.isSafeInteger(runtimeNapi) || runtimeNapi < EXPECTED_NAPI_VERSION) {
    throw new Error(
      `this runtime does not provide the Node-API ${EXPECTED_NAPI_VERSION} ABI required by @oliphaunt/wasix-ts`,
    );
  }
  const runtimePlatform = platform();
  const runtimeLibc = runtimePlatform === 'linux' ? detectLinuxLibc() : 'unknown';
  if (runtimePlatform === 'linux') requireSupportedLinuxLibc(runtimeLibc);

  const metadata = packageMetadata();
  const path = resolveNativeAddonPath(metadata, runtimePlatform, runtimeLibc);
  const loaded = require(path) as { default?: unknown } | unknown;
  const addon = normalizeAddon(loaded);
  validateNativeWasixAddon(addon, path, metadata);
  loadedAddon = addon;
  return addon;
}

function resolveNativeAddonPath(
  metadata: WasixPackageMetadata,
  runtimePlatform: string,
  runtimeLibc: LinuxLibc,
): string {
  const explicit = optionalEnvironmentValue(ADDON_ENV);
  if (explicit !== undefined && explicit.trim().length > 0) {
    if (explicit.includes('\0')) throw new Error(`${ADDON_ENV} must not contain NUL bytes`);
    const path = resolve(explicit);
    requireRegularFile(path, ADDON_ENV);
    return path;
  }

  for (const candidate of packageAdjacentAddons()) {
    if (isRegularFile(candidate)) return candidate;
  }

  const version = metadata.oliphaunt?.wasixNapiVersion;
  if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('@oliphaunt/wasix-ts package metadata does not pin wasixNapiVersion');
  }
  const target = nativeTarget(runtimePlatform, arch(), runtimeLibc);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw new Error(
      `${target.packageName} ${version} is not installed; reinstall @oliphaunt/wasix-ts with optional dependencies enabled`,
    );
  }
  const carrier = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as NativeCarrierMetadata;
  if (
    carrier.name !== target.packageName ||
    carrier.version !== version ||
    JSON.stringify(carrier.libc) !==
      JSON.stringify(target.libc === undefined ? undefined : [target.libc]) ||
    carrier.oliphaunt?.target !== target.id ||
    carrier.oliphaunt?.runtimeProduct !== metadata.oliphaunt?.runtimeProduct ||
    carrier.oliphaunt?.runtimeVersion !== metadata.oliphaunt?.runtimeVersion ||
    carrier.oliphaunt?.addonAbiVersion !== metadata.oliphaunt?.wasixAddonAbiVersion ||
    carrier.oliphaunt?.nodeApiVersion !== metadata.oliphaunt?.nodeApiVersion ||
    JSON.stringify(carrier.oliphaunt?.profiles) !== JSON.stringify(['standard', 'icu'])
  ) {
    throw new Error(`${target.packageName} metadata is incompatible with @oliphaunt/wasix-ts`);
  }
  const addonPath = require.resolve(`${target.packageName}/${ADDON_STEM}.node`);
  requireRegularFile(addonPath, `${target.packageName} addon`);
  return addonPath;
}

/** @internal Read an optional override without making Deno env permission mandatory. */
export function optionalEnvironmentValue(
  name: string,
  read: (name: string) => string | undefined = (key) => process.env[key],
  denoRuntime = 'Deno' in globalThis,
): string | undefined {
  try {
    return read(name);
  } catch (error) {
    if (
      denoRuntime &&
      error instanceof Error &&
      (error.name === 'NotCapable' || error.name === 'PermissionDenied')
    ) {
      return undefined;
    }
    throw error;
  }
}

function packageMetadata(): WasixPackageMetadata {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as WasixPackageMetadata;
}

function packageAdjacentAddons(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = `${ADDON_STEM}.node`;
  return [join(here, file), join(here, '..', file)];
}

/** @internal Resolve only the GNU Linux carriers; musl addons are not published. */
export function nativeTarget(
  currentPlatform: string,
  currentArch: string,
  currentLibc: LinuxLibc = currentPlatform === 'linux' ? detectLinuxLibc() : 'unknown',
): NativeTarget {
  if (currentPlatform === 'darwin' && currentArch === 'arm64') {
    return { id: 'macos-arm64', packageName: '@oliphaunt/wasix-napi-darwin-arm64' };
  }
  if (currentPlatform === 'linux') requireSupportedLinuxLibc(currentLibc);
  if (currentPlatform === 'linux' && currentArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      packageName: '@oliphaunt/wasix-napi-linux-arm64-gnu',
      libc: 'glibc',
    };
  }
  if (currentPlatform === 'linux' && currentArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      packageName: '@oliphaunt/wasix-napi-linux-x64-gnu',
      libc: 'glibc',
    };
  }
  if (currentPlatform === 'win32' && currentArch === 'x64') {
    return { id: 'windows-x64-msvc', packageName: '@oliphaunt/wasix-napi-win32-x64-msvc' };
  }
  throw new Error(
    `no Oliphaunt WASIX Node-API package is defined for ${currentPlatform}/${currentArch}`,
  );
}

/** @internal Detect Linux libc without probing mutable external commands. */
export function detectLinuxLibc(
  report: LinuxDiagnosticReport | undefined = undefined,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  denoTarget: string | undefined = denoBuildTarget(),
): LinuxLibc {
  if (typeof versions.musl === 'string' && versions.musl.length > 0) return 'musl';
  if (denoTarget?.endsWith('-linux-musl')) return 'musl';
  if (denoTarget?.endsWith('-linux-gnu')) return 'glibc';
  const diagnostic =
    report ?? (process.report?.getReport?.() as LinuxDiagnosticReport | undefined);
  if (
    Array.isArray(diagnostic?.sharedObjects) &&
    diagnostic.sharedObjects.some(
      (member) => typeof member === 'string' && /(?:^|[/\\])ld-musl-/iu.test(member),
    )
  ) {
    return 'musl';
  }
  if (
    typeof diagnostic?.header?.glibcVersionRuntime === 'string' &&
    diagnostic.header.glibcVersionRuntime.length > 0
  ) {
    return 'glibc';
  }
  return 'unknown';
}

function denoBuildTarget(): string | undefined {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno;
  return typeof deno?.build?.target === 'string' ? deno.build.target : undefined;
}

function requireSupportedLinuxLibc(libc: LinuxLibc): void {
  if (libc === 'musl') {
    throw new Error(
      'Oliphaunt WASIX Node-API does not support Linux musl; install on a glibc-based system',
    );
  }
  if (libc !== 'glibc') {
    throw new Error('Oliphaunt WASIX Node-API could not verify a supported Linux glibc runtime');
  }
}

function normalizeAddon(loaded: unknown): NativeWasixAddon {
  const maybeDefault = loaded as { default?: unknown };
  return (maybeDefault.default ?? loaded) as NativeWasixAddon;
}

/** @internal Enforce the complete v1 release surface before any database opens. */
export function validateNativeWasixAddon(
  addon: NativeWasixAddon,
  path: string,
  metadata: WasixPackageMetadata,
): void {
  const databasePrototype = addon?.NativeWasixDatabase?.prototype;
  const actorDatabasePrototype = addon?.NativeWasixActorDatabase?.prototype;
  const serverPrototype = addon?.NativeWasixServer?.prototype;
  if (
    metadata.name !== '@oliphaunt/wasix-ts' ||
    typeof addon !== 'object' ||
    addon === null ||
    typeof addon.NativeWasixDatabase?.open !== 'function' ||
    typeof databasePrototype?.execProtocolRaw !== 'function' ||
    typeof databasePrototype.execProtocolRawStream !== 'function' ||
    typeof databasePrototype.backup !== 'function' ||
    typeof databasePrototype.pgDump !== 'function' ||
    typeof databasePrototype.psql !== 'function' ||
    typeof databasePrototype.close !== 'function' ||
    typeof addon.NativeWasixActorDatabase?.open !== 'function' ||
    typeof actorDatabasePrototype?.execProtocolRaw !== 'function' ||
    typeof actorDatabasePrototype.execProtocolRawStream !== 'function' ||
    typeof actorDatabasePrototype.backup !== 'function' ||
    typeof actorDatabasePrototype.pgDump !== 'function' ||
    typeof actorDatabasePrototype.psql !== 'function' ||
    typeof actorDatabasePrototype.close !== 'function' ||
    typeof addon.NativeWasixServer?.open !== 'function' ||
    typeof serverPrototype?.close !== 'function' ||
    typeof addon.restore !== 'function' ||
    typeof addon.restoreDirect !== 'function' ||
    typeof addon.addonAbiVersion !== 'function' ||
    typeof addon.nodeApiVersion !== 'function' ||
    typeof addon.runtimeVersion !== 'function' ||
    typeof addon.supportedProfiles !== 'function' ||
    typeof addon.payloadIdentity !== 'function' ||
    typeof addon.extensionIdentity !== 'function' ||
    typeof addon.toolIdentity !== 'function'
  ) {
    throw new Error(`Oliphaunt WASIX native addon ${path} has an invalid export surface`);
  }
  const expectedAbi = metadata.oliphaunt?.wasixAddonAbiVersion;
  if (expectedAbi !== 1 || addon.addonAbiVersion() !== expectedAbi) {
    throw new Error(`Oliphaunt WASIX native addon ${path} has an incompatible addon ABI`);
  }
  const expectedNodeApi = metadata.oliphaunt?.nodeApiVersion;
  if (expectedNodeApi !== EXPECTED_NAPI_VERSION || addon.nodeApiVersion() !== expectedNodeApi) {
    throw new Error(
      `Oliphaunt WASIX native addon ${path} does not use Node-API ${EXPECTED_NAPI_VERSION}`,
    );
  }
  const expectedRuntime = metadata.oliphaunt?.runtimeVersion;
  if (expectedRuntime === undefined || addon.runtimeVersion() !== expectedRuntime) {
    throw new Error(`Oliphaunt WASIX native addon ${path} has an incompatible runtime version`);
  }
  if (metadata.oliphaunt?.wasixNapiProduct !== PRODUCT) {
    throw new Error('@oliphaunt/wasix-ts package metadata has an invalid WASIX N-API product');
  }
  if (JSON.stringify(addon.supportedProfiles()) !== JSON.stringify(['standard', 'icu'])) {
    throw new Error(`Oliphaunt WASIX native addon ${path} has incompatible catalog profiles`);
  }
}

function requireRegularFile(path: string, source: string): void {
  if (!isRegularFile(path)) throw new Error(`${source} does not point to a regular file: ${path}`);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
