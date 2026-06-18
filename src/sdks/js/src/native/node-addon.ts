import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import type { NativeHandle, NativeOpenConfig } from './types.js';
import {
  assertSha256Matches,
  checksumForReleaseAsset,
  envVar,
  LIBOLIPHAUNT_CACHE_DIR_ENV,
  parseReleaseChecksumManifest,
} from './common.js';
import { extractTarArchive } from './tar.js';
import { extractZipArchive } from './zip.js';

export type NodeDirectAddon = {
  version(libraryPath: string): string;
  capabilities(libraryPath: string): bigint | number;
  open(config: NodeDirectOpenConfig): NativeHandle;
  execProtocolRaw(handle: NativeHandle, request: Uint8Array): Uint8Array | ArrayBuffer;
  execSimpleQuery(handle: NativeHandle, sql: string): Uint8Array | ArrayBuffer;
  execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array | ArrayBuffer) => void,
  ): void;
  backup(handle: NativeHandle, format: number): Uint8Array | ArrayBuffer;
  restore(options: NodeDirectRestoreOptions): void;
  cancel(handle: NativeHandle): void;
  detach(handle: NativeHandle): void;
};

export type NodeDirectOpenConfig = NativeOpenConfig & {
  libraryPath: string;
};

export type NodeDirectRestoreOptions = {
  libraryPath: string;
  root: string;
  format: number;
  bytes: Uint8Array;
  replaceExisting: boolean;
};

type PackageMetadata = {
  name?: string;
  version?: string;
  oliphaunt?: {
    nodeDirectAddon?: string;
    nodeDirectAddonVersion?: string;
  };
};

type NodeAddonReleaseTarget = {
  id: string;
  assetName: string;
  addonRelativePath: string;
  packageName: string;
};

type InstallMarker = {
  version: string;
  asset: string;
  checksum: string;
};

const require = createRequire(import.meta.url);
const NODE_ADDON_ENV = 'OLIPHAUNT_NODE_ADDON';
const NODE_ADDON_ASSET_DIR_ENV = 'OLIPHAUNT_NODE_ADDON_ASSET_DIR';
const NODE_ADDON_RELEASE_BASE_URL_ENV = 'OLIPHAUNT_NODE_DIRECT_RELEASE_BASE_URL';
const RELEASE_REPOSITORY = 'f0rr0/oliphaunt';
const RELEASE_TAG_PREFIX = 'oliphaunt-node-direct-v';
const ADDON_STEM = 'oliphaunt_node';

export async function loadNodeDirectAddon(explicitPath?: string): Promise<NodeDirectAddon> {
  const addonPath = await resolveNodeDirectAddonPath(explicitPath);
  const loaded = require(addonPath) as { default?: unknown } | unknown;
  const addon = normalizeAddon(loaded);
  validateAddon(addon, addonPath);
  return addon;
}

async function resolveNodeDirectAddonPath(explicitPath?: string): Promise<string> {
  const explicit = explicitPath ?? envVar(NODE_ADDON_ENV);
  if (explicit !== undefined && explicit.trim().length > 0) {
    if (explicit.includes('\0')) {
      throw new Error(`${NODE_ADDON_ENV} must not contain NUL bytes`);
    }
    const resolved = resolve(explicit);
    await requireFile(resolved, NODE_ADDON_ENV);
    return resolved;
  }

  for (const candidate of packageAdjacentAddons()) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  for (const candidate of optionalDependencyAddons()) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return resolveNodeDirectAddonInstall();
}

async function resolveNodeDirectAddonInstall(): Promise<string> {
  const version = await packageNodeDirectAddonVersion();
  const target = nodeAddonReleaseTarget(version, platform(), arch());
  const installRoot = join(cacheRoot(), 'oliphaunt-node-direct', version, target.id);
  const addonPath = join(installRoot, target.addonRelativePath);
  const release = await acquireInstallLock(`${installRoot}.lock`);
  try {
    if (await validateExistingInstall(addonPath, version, target.assetName)) {
      return addonPath;
    }
    const checksums = parseReleaseChecksumManifest(
      new TextDecoder().decode(await readReleaseAssetBytes(version, checksumAssetName(version))),
    );
    const expectedChecksum = checksumForReleaseAsset(checksums, target.assetName);
    const archive = await readReleaseAssetBytes(version, target.assetName);
    assertSha256Matches(target.assetName, expectedChecksum, sha256Hex(archive));
    await installArchive(archive, installRoot, {
      version,
      asset: target.assetName,
      checksum: expectedChecksum,
    });
    return addonPath;
  } finally {
    await release();
  }
}

function nodeAddonReleaseTarget(
  version: string,
  currentPlatform: string,
  currentArch: string,
): NodeAddonReleaseTarget {
  validateVersion(version);
  const normalizedPlatform = normalizePlatform(currentPlatform);
  const normalizedArch = normalizeArchitecture(currentArch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      assetName: `oliphaunt-node-direct-${version}-macos-arm64.tar.gz`,
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-darwin-arm64',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      assetName: `oliphaunt-node-direct-${version}-linux-x64-gnu.tar.gz`,
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-linux-x64-gnu',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      assetName: `oliphaunt-node-direct-${version}-linux-arm64-gnu.tar.gz`,
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-linux-arm64-gnu',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      assetName: `oliphaunt-node-direct-${version}-windows-x64-msvc.zip`,
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-win32-x64-msvc',
    };
  }
  throw new Error(
    `no Oliphaunt Node.js native-direct adapter ${version} release asset is defined for ${currentPlatform}/${currentArch}; pass nodeAddonPath or set ${NODE_ADDON_ENV}`,
  );
}

async function packageNodeDirectAddonVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(require.resolve('@oliphaunt/ts/package.json'), 'utf8'),
  ) as PackageMetadata;
  const version = packageJson.oliphaunt?.nodeDirectAddonVersion;
  if (
    packageJson.name !== '@oliphaunt/ts' ||
    version === undefined ||
    version.length === 0 ||
    packageJson.oliphaunt?.nodeDirectAddon !== 'oliphaunt-node-direct'
  ) {
    throw new Error('@oliphaunt/ts package metadata does not pin nodeDirectAddonVersion');
  }
  return version;
}

async function readReleaseAssetBytes(version: string, assetName: string): Promise<Uint8Array> {
  const localAssetDir = envVar(NODE_ADDON_ASSET_DIR_ENV);
  if (localAssetDir !== undefined && localAssetDir.trim().length > 0) {
    return Uint8Array.from(await readFile(join(localAssetDir, assetName)));
  }
  const response = await fetch(nodeDirectAddonReleaseAssetUrl(version, assetName));
  if (!response.ok) {
    throw new Error(
      `download ${nodeDirectAddonReleaseAssetUrl(version, assetName)} failed with HTTP ${response.status}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function nodeDirectAddonReleaseAssetUrl(version: string, assetName: string): string {
  validateVersion(version);
  validateAssetName(assetName);
  const override = envVar(NODE_ADDON_RELEASE_BASE_URL_ENV);
  const base =
    override !== undefined && override.trim().length > 0
      ? override.replace(/\/+$/, '')
      : `https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG_PREFIX}${version}`;
  return `${base}/${assetName}`;
}

function checksumAssetName(version: string): string {
  validateVersion(version);
  return `oliphaunt-node-direct-${version}-release-assets.sha256`;
}

async function validateExistingInstall(
  addonPath: string,
  version: string,
  assetName: string,
): Promise<boolean> {
  const markerPath = join(dirname(addonPath), '.oliphaunt-node-direct-install.json');
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstallMarker;
    const addonStat = await stat(addonPath);
    return (
      marker.version === version &&
      marker.asset === assetName &&
      marker.checksum.length === 64 &&
      addonStat.isFile()
    );
  } catch {
    return false;
  }
}

async function installArchive(
  archive: Uint8Array,
  installRoot: string,
  marker: InstallMarker,
): Promise<void> {
  const parent = dirname(installRoot);
  const scratch = join(
    parent,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    if (marker.asset.endsWith('.zip')) {
      await extractZipArchive(archive, scratch, archiveExtractionHost(), (bytes) =>
        Uint8Array.from(inflateRawSync(bytes)),
      );
    } else {
      await extractTarArchive(
        Uint8Array.from(gunzipSync(archive)),
        scratch,
        archiveExtractionHost(),
      );
    }
    await writeFile(
      join(scratch, '.oliphaunt-node-direct-install.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
      'utf8',
    );
    await rm(installRoot, { recursive: true, force: true });
    await rename(scratch, installRoot);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

function archiveExtractionHost() {
  return {
    join,
    dirname,
    async mkdir(path: string) {
      await mkdir(path, { recursive: true });
    },
    async writeFile(file: { path: string; bytes: Uint8Array; mode: number }) {
      await writeFile(file.path, file.bytes, { mode: file.mode });
      await chmod(file.path, file.mode);
    },
  };
}

function packageAdjacentAddons(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, `${ADDON_STEM}.node`),
    join(here, '..', `${ADDON_STEM}.node`),
    resolve(process.cwd(), `${ADDON_STEM}.node`),
  ];
}

function optionalDependencyAddons(): string[] {
  const target = optionalNodeDirectPackage(platform(), arch());
  if (target === undefined) {
    return [];
  }
  try {
    return [require.resolve(`${target}/oliphaunt_node.node`)];
  } catch {
    return [];
  }
}

function optionalNodeDirectPackage(
  currentPlatform: string,
  currentArch: string,
): string | undefined {
  const normalizedPlatform = normalizePlatform(currentPlatform);
  const normalizedArch = normalizeArchitecture(currentArch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return '@oliphaunt/node-direct-darwin-arm64';
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return '@oliphaunt/node-direct-linux-x64-gnu';
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return '@oliphaunt/node-direct-linux-arm64-gnu';
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return '@oliphaunt/node-direct-win32-x64-msvc';
  }
  return undefined;
}

async function requireFile(path: string, source: string): Promise<void> {
  if (!(await isFile(path))) {
    throw new Error(`${source} does not point to an existing file: ${path}`);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function normalizeAddon(loaded: unknown): NodeDirectAddon {
  const maybeDefault = loaded as { default?: unknown };
  return (maybeDefault.default ?? loaded) as NodeDirectAddon;
}

function validateAddon(addon: NodeDirectAddon, addonPath: string): void {
  for (const name of [
    'version',
    'capabilities',
    'open',
    'execProtocolRaw',
    'execSimpleQuery',
    'execProtocolStream',
    'backup',
    'restore',
    'cancel',
    'detach',
  ] as const) {
    if (typeof addon[name] !== 'function') {
      throw new Error(`Oliphaunt Node.js native-direct adapter ${addonPath} is missing ${name}()`);
    }
  }
}

function cacheRoot(): string {
  const override = envVar(LIBOLIPHAUNT_CACHE_DIR_ENV);
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'oliphaunt');
  }
  const xdgCache = envVar('XDG_CACHE_HOME');
  if (xdgCache !== undefined && xdgCache.trim().length > 0) {
    return join(xdgCache, 'oliphaunt');
  }
  return join(homedir() || tmpdir(), '.cache', 'oliphaunt');
}

async function acquireInstallLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx' });
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if (isFileExistsError(error)) {
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`timed out waiting for Oliphaunt Node.js adapter install lock ${path}`);
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizePlatform(value: string): string {
  switch (value) {
    case 'darwin':
    case 'macos':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
    case 'windows':
      return 'windows';
    default:
      return value;
  }
}

function normalizeArchitecture(value: string): string {
  switch (value) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x64':
    case 'x86_64':
      return 'x64';
    default:
      return value;
  }
}

function validateVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`invalid Oliphaunt Node direct release version '${version}'`);
  }
}

function validateAssetName(assetName: string): void {
  if (!/^[A-Za-z0-9._+-]+$/.test(assetName) || assetName.includes('..')) {
    throw new Error(`invalid Oliphaunt Node direct release asset name '${assetName}'`);
  }
}
