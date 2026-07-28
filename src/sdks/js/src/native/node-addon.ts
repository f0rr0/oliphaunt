import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';

import type { NativeHandle, NativeOpenConfig } from './types.js';
import { envVar } from './common.js';

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
  moduleDirectory?: string;
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

type NodeAddonPackageTarget = {
  id: string;
  addonRelativePath: string;
  packageName: string;
};

const require = createRequire(import.meta.url);
const NODE_ADDON_ENV = 'OLIPHAUNT_NODE_ADDON';
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
  const version = await packageNodeDirectAddonVersion();
  const target = nodeAddonPackageTarget(platform(), arch());
  const installed = await optionalDependencyAddon(target, version);
  if (installed !== undefined) {
    return installed;
  }
  throw new Error(
    `${target.packageName} ${version} is not installed; reinstall @oliphaunt/ts with optional dependencies enabled`,
  );
}

function nodeAddonPackageTarget(
  currentPlatform: string,
  currentArch: string,
): NodeAddonPackageTarget {
  const normalizedPlatform = normalizePlatform(currentPlatform);
  const normalizedArch = normalizeArchitecture(currentArch);
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') {
    return {
      id: 'macos-arm64',
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-darwin-arm64',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') {
    return {
      id: 'linux-x64-gnu',
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-linux-x64-gnu',
    };
  }
  if (normalizedPlatform === 'linux' && normalizedArch === 'arm64') {
    return {
      id: 'linux-arm64-gnu',
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-linux-arm64-gnu',
    };
  }
  if (normalizedPlatform === 'windows' && normalizedArch === 'x64') {
    return {
      id: 'windows-x64-msvc',
      addonRelativePath: `${ADDON_STEM}.node`,
      packageName: '@oliphaunt/node-direct-win32-x64-msvc',
    };
  }
  throw new Error(
    `no Oliphaunt Node.js native-direct adapter package is defined for ${currentPlatform}/${currentArch}; pass nodeAddonPath or set ${NODE_ADDON_ENV}`,
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

function packageAdjacentAddons(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, `${ADDON_STEM}.node`),
    join(here, '..', `${ADDON_STEM}.node`),
    resolve(process.cwd(), `${ADDON_STEM}.node`),
  ];
}

async function optionalDependencyAddon(
  target: NodeAddonPackageTarget,
  expectedVersion: string,
): Promise<string | undefined> {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    return undefined;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageMetadata & {
    oliphaunt?: { target?: string };
  };
  if (packageJson.name !== target.packageName) {
    throw new Error(
      `${target.packageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${target.packageName} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts nodeDirectAddonVersion ${expectedVersion}`,
    );
  }
  if (packageJson.oliphaunt?.target !== target.id) {
    throw new Error(`${target.packageName} package metadata does not target ${target.id}`);
  }
  const addonPath = require.resolve(`${target.packageName}/${target.addonRelativePath}`);
  await requireFile(addonPath, `${target.packageName} native addon`);
  return addonPath;
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
