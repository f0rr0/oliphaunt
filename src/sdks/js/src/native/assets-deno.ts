import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  liboliphauntPackageTarget,
  type NativePackageTarget,
  resolveExplicitLibraryPath,
  resolveExplicitRuntimeDirectory,
} from './common.js';
import { type RuntimeFileHost, validatePreparedRuntimeExtensions } from './extension-runtime.js';
import {
  requireIcuDataTreeSha256,
  requireIcuManifestRelativePath,
  requireNativeClusterSeedPath,
  requireNativeClusterSeedTarget,
  validateNativeClusterSeedManifest,
  validateNativeIcuDataReceipt,
  validateNativeRuntimeCarrierReceipt,
  type NativeCatalogProfile,
} from './cluster-seed.js';

export type ResolvedDenoNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
  icuDataDirectory?: string;
  clusterSeedDirectory?: string;
  catalogProfile?: NativeCatalogProfile;
  packageManaged: boolean;
};

export type DenoRuntime = {
  build: { os: string; arch: string };
  env?: { get(name: string): string | undefined };
  readTextFile(path: string | URL): Promise<string>;
  readDir(
    path: string | URL,
  ): AsyncIterable<{ name: string; isFile?: boolean; isDirectory?: boolean }>;
  stat(path: string | URL): Promise<{ isFile?: boolean; isDirectory?: boolean }>;
};
const require = createRequire(import.meta.url);

type PackageMetadata = {
  name: string;
  oliphaunt?: {
    liboliphauntVersion?: string;
    icuPackage?: string;
    icuVersion?: string;
  };
};

type LiboliphauntPackageMetadata = {
  name?: string;
  version?: string;
  oliphaunt?: {
    target?: string;
    libraryRelativePath?: string;
    runtimeRelativePath?: string;
    clusterSeedRelativePath?: string;
    icuClusterSeedRelativePath?: string;
    clusterSeedTarget?: string;
  };
};

type IcuPackageMetadata = {
  name?: string;
  version?: string;
  oliphaunt?: {
    product?: string;
    kind?: string;
    target?: string;
    dataRelativePath?: string;
    manifestRelativePath?: string;
    icuDataTreeSha256?: string;
  };
};

type ResolvedDenoIcuResources = {
  dataDirectory: string;
  dataTreeSha256: string;
};

export async function resolveDenoNativeInstall(
  libraryPath?: string,
): Promise<ResolvedDenoNativeInstall> {
  const explicit = resolveExplicitLibraryPath(libraryPath);
  if (explicit !== undefined) {
    const deno = optionalDenoRuntime();
    const versions = deno === undefined ? undefined : await packageVersions(deno);
    const icuDataDirectory =
      deno === undefined || versions === undefined
        ? undefined
        : (await resolveDenoIcuResources(deno, versions.icuVersion, versions.icuPackage))
            ?.dataDirectory;
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
      icuDataDirectory,
      catalogProfile: icuDataDirectory === undefined ? 'standard' : 'icu',
      packageManaged: false,
    };
  }

  const deno = denoRuntime();
  const versions = await packageVersions(deno);
  const icu = await resolveDenoIcuResources(deno, versions.icuVersion, versions.icuPackage);
  const target = liboliphauntPackageTarget(deno.build.os, deno.build.arch);
  return resolvePackageNativeInstall(deno, target, versions.liboliphauntVersion, icu);
}

export async function validatePreparedDenoRuntimeExtensions(config: {
  deno: DenoRuntime;
  runtimeDirectory?: string;
  extensions: ReadonlyArray<string>;
  source: string;
}): Promise<{ runtimeDirectory: string; moduleDirectory?: string }> {
  const target = liboliphauntPackageTarget(config.deno.build.os, config.deno.build.arch);
  return validatePreparedRuntimeExtensions({
    runtimeDirectory: config.runtimeDirectory,
    extensions: config.extensions,
    target: target.id,
    source: config.source,
    host: denoRuntimeFileHost(config.deno),
  });
}

async function packageVersions(deno: DenoRuntime): Promise<{
  liboliphauntVersion: string;
  icuPackage: string;
  icuVersion: string;
}> {
  const packageUrl = new URL('../../package.json', import.meta.url);
  const packageJson = JSON.parse(await deno.readTextFile(packageUrl)) as PackageMetadata;
  const liboliphauntVersion = packageJson.oliphaunt?.liboliphauntVersion;
  const icuPackage = packageJson.oliphaunt?.icuPackage;
  const icuVersion = packageJson.oliphaunt?.icuVersion;
  if (
    packageJson.name !== '@oliphaunt/ts' ||
    liboliphauntVersion === undefined ||
    liboliphauntVersion.length === 0
  ) {
    throw new Error('@oliphaunt/ts package metadata does not pin liboliphauntVersion');
  }
  if (icuPackage !== '@oliphaunt/icu' || icuVersion === undefined || icuVersion.length === 0) {
    throw new Error('@oliphaunt/ts package metadata does not pin @oliphaunt/icu');
  }
  return { liboliphauntVersion, icuPackage, icuVersion };
}

async function resolvePackageNativeInstall(
  deno: DenoRuntime,
  target: NativePackageTarget,
  expectedVersion: string,
  icu: ResolvedDenoIcuResources | undefined,
): Promise<ResolvedDenoNativeInstall> {
  const packageJsonUrl = resolvePackageJsonUrl(target.packageName);
  const packageJson = JSON.parse(
    await deno.readTextFile(packageJsonUrl),
  ) as LiboliphauntPackageMetadata;
  if (packageJson.name !== target.packageName) {
    throw new Error(
      `${target.packageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${target.packageName} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts liboliphauntVersion ${expectedVersion}`,
    );
  }
  if (packageJson.oliphaunt?.target !== target.id) {
    throw new Error(`${target.packageName} package metadata does not target ${target.id}`);
  }
  const clusterSeedTarget = requireNativeClusterSeedTarget(
    packageJson.oliphaunt.clusterSeedTarget,
    target.id,
    `${target.packageName} package metadata`,
  );
  const standardClusterSeedRelativePath = requireNativeClusterSeedPath(
    packageJson.oliphaunt.clusterSeedRelativePath,
    'cluster-seed',
    `${target.packageName} clusterSeedRelativePath`,
  );
  const icuClusterSeedRelativePath = requireNativeClusterSeedPath(
    packageJson.oliphaunt.icuClusterSeedRelativePath,
    'cluster-seed-icu',
    `${target.packageName} icuClusterSeedRelativePath`,
  );
  const packageRoot = new URL('.', packageJsonUrl);
  const carrierManifestUrl = new URL('manifest.properties', packageRoot);
  await requireFile(deno, carrierManifestUrl, `${target.packageName} runtime carrier receipt`);
  validateNativeRuntimeCarrierReceipt(
    await deno.readTextFile(carrierManifestUrl),
    clusterSeedTarget,
    `${target.packageName} runtime carrier receipt`,
  );
  const libraryUrl = resolvePackageRelativeUrl(
    packageRoot,
    packageJson.oliphaunt?.libraryRelativePath ?? target.libraryRelativePath,
    `${target.packageName} liboliphaunt library metadata`,
  );
  await requireFile(deno, libraryUrl, `${target.packageName} liboliphaunt library`);
  const runtimeUrl = resolvePackageRelativeUrl(
    packageRoot,
    packageJson.oliphaunt?.runtimeRelativePath ?? target.runtimeRelativePath,
    `${target.packageName} runtime directory metadata`,
  );
  await requireDirectory(deno, runtimeUrl, `${target.packageName} runtime directory`);
  for (const tool of nativeRuntimeToolsForTarget(target.id)) {
    await requireFile(
      deno,
      new URL(`bin/${tool}`, directoryUrl(runtimeUrl)),
      `${target.packageName} runtime tool bin/${tool}`,
    );
  }
  const standardClusterSeedUrl = resolvePackageRelativeUrl(
    packageRoot,
    standardClusterSeedRelativePath,
    `${target.packageName} standard cluster seed metadata`,
  );
  await requireClusterSeedDirectory(
    deno,
    standardClusterSeedUrl,
    'standard',
    clusterSeedTarget,
    `${target.packageName} standard cluster seed`,
  );
  const selectedClusterSeedUrl =
    icu === undefined
      ? standardClusterSeedUrl
      : resolvePackageRelativeUrl(
          packageRoot,
          icuClusterSeedRelativePath,
          `${target.packageName} ICU cluster seed metadata`,
        );
  let icuDataTreeSha256: string | undefined;
  if (icu !== undefined) {
    icuDataTreeSha256 = await requireClusterSeedDirectory(
      deno,
      selectedClusterSeedUrl,
      'icu',
      clusterSeedTarget,
      `${target.packageName} ICU cluster seed`,
    );
    if (icuDataTreeSha256 !== icu.dataTreeSha256) {
      throw new Error(
        `${target.packageName} ICU cluster seed and the selected ICU data package identify different logical trees`,
      );
    }
  }
  const libraryPath = fileURLToPath(libraryUrl);
  return {
    libraryPath,
    runtimeDirectory: fileURLToPath(runtimeUrl),
    icuDataDirectory: icu?.dataDirectory,
    clusterSeedDirectory: fileURLToPath(selectedClusterSeedUrl),
    catalogProfile: icu === undefined ? 'standard' : 'icu',
    packageManaged: true,
  };
}

async function resolveDenoIcuResources(
  deno: DenoRuntime,
  expectedVersion: string,
  packageName: string,
): Promise<ResolvedDenoIcuResources | undefined> {
  const packageJsonUrl = optionalResolvePackageJsonUrl(packageName);
  if (packageJsonUrl === undefined) {
    return undefined;
  }
  const packageJson = JSON.parse(await deno.readTextFile(packageJsonUrl)) as IcuPackageMetadata;
  validateDenoIcuPackageMetadata(packageJson, packageName, expectedVersion);
  const metadata = packageJson.oliphaunt!;
  const dataUrl = resolvePackageRelativeUrl(
    new URL('.', packageJsonUrl),
    metadata.dataRelativePath ?? 'share/icu',
    `${packageName} ICU data directory metadata`,
  );
  await requireIcuDataDirectory(deno, dataUrl, `${packageName} ICU data directory`);
  const manifestRelativePath = requireIcuManifestRelativePath(
    metadata.dataRelativePath,
    metadata.manifestRelativePath,
    `${packageName} package metadata`,
  );
  const manifestUrl = resolvePackageRelativeUrl(
    new URL('.', packageJsonUrl),
    manifestRelativePath,
    `${packageName} ICU data manifest metadata`,
  );
  await requireFile(deno, manifestUrl, `${packageName} ICU data manifest`);
  const dataTreeSha256 = requireIcuDataTreeSha256(
    metadata.icuDataTreeSha256,
    `${packageName} package metadata`,
  );
  const receiptDigest = validateNativeIcuDataReceipt(
    await deno.readTextFile(manifestUrl),
    `${packageName} ICU data manifest`,
  );
  if (receiptDigest !== dataTreeSha256) {
    throw new Error(`${packageName} ICU data receipt does not match package metadata`);
  }
  return {
    dataDirectory: fileURLToPath(dataUrl),
    dataTreeSha256,
  };
}

function validateDenoIcuPackageMetadata(
  packageJson: IcuPackageMetadata,
  packageName: string,
  expectedVersion: string,
): void {
  if (packageJson.name !== packageName) {
    throw new Error(`${packageName} package metadata has name ${packageJson.name ?? '<missing>'}`);
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${packageName} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts icuVersion ${expectedVersion}`,
    );
  }
  if (packageJson.oliphaunt?.product !== 'oliphaunt-icu') {
    throw new Error(`${packageName} package metadata does not declare oliphaunt-icu`);
  }
  if (packageJson.oliphaunt?.kind !== 'icu-data') {
    throw new Error(`${packageName} package metadata does not declare ICU data`);
  }
  if (packageJson.oliphaunt?.target !== 'portable') {
    throw new Error(`${packageName} package metadata must target portable ICU data`);
  }
}

export function resolvePackageRelativeUrl(
  packageRoot: URL,
  metadataPath: string,
  source: string,
): URL {
  const relativePath = safePackageRelativePath(metadataPath, source);
  const resolved = new URL(relativePath, packageRoot);
  const rootHref = packageRoot.href.endsWith('/') ? packageRoot.href : `${packageRoot.href}/`;
  if (resolved.protocol !== packageRoot.protocol || !resolved.href.startsWith(rootHref)) {
    throw new Error(`${source} contains unsafe package metadata path: ${metadataPath}`);
  }
  return resolved;
}

function safePackageRelativePath(metadataPath: string, source: string): string {
  if (metadataPath.length === 0) {
    throw new Error(`${source} contains unsafe package metadata path: <empty>`);
  }
  if (metadataPath.includes('\0')) {
    throw new Error(`${source} contains unsafe package metadata path: ${metadataPath}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(metadataPath);
  } catch {
    throw new Error(`${source} contains unsafe package metadata path: ${metadataPath}`);
  }
  const normalized = decoded.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${source} contains unsafe package metadata path: ${metadataPath}`);
  }
  return normalized;
}

function nativeRuntimeToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc'
    ? ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']
    : ['initdb', 'pg_ctl', 'postgres'];
}

function directoryUrl(url: URL): URL {
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function resolvePackageJsonUrl(packageName: string): URL {
  const specifier = `${packageName}/package.json`;
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (resolver === undefined) {
    return resolvePackageJsonUrlWithRequire(packageName, specifier);
  }
  try {
    return new URL(resolver(specifier));
  } catch (error) {
    if (importMetaResolveUnsupported(error)) {
      return resolvePackageJsonUrlWithRequire(packageName, specifier);
    }
    throw new Error(
      `${packageName} is not installed; import Oliphaunt from npm:@oliphaunt/ts with optional dependencies enabled`,
      { cause: error },
    );
  }
}

function optionalResolvePackageJsonUrl(packageName: string): URL | undefined {
  const specifier = `${packageName}/package.json`;
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (resolver === undefined) {
    return optionalResolvePackageJsonUrlWithRequire(specifier);
  }
  try {
    return new URL(resolver(specifier));
  } catch (error) {
    if (importMetaResolveUnsupported(error)) {
      return optionalResolvePackageJsonUrlWithRequire(specifier);
    }
    return undefined;
  }
}

function resolvePackageJsonUrlWithRequire(packageName: string, specifier: string): URL {
  const resolved = optionalResolvePackageJsonUrlWithRequire(specifier);
  if (resolved !== undefined) {
    return resolved;
  }
  throw new Error(
    `${packageName} is not installed; import Oliphaunt from npm:@oliphaunt/ts with optional dependencies enabled`,
  );
}

function optionalResolvePackageJsonUrlWithRequire(specifier: string): URL | undefined {
  try {
    return pathToFileURL(require.resolve(specifier));
  } catch {
    return undefined;
  }
}

function importMetaResolveUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message.includes('import.meta.resolve');
}

async function requireFile(deno: DenoRuntime, path: URL, source: string): Promise<void> {
  try {
    const info = await deno.stat(path);
    if (info.isFile === true) {
      return;
    }
  } catch {}
  throw new Error(
    `${source} does not point to an existing file: ${decodeURIComponent(path.pathname)}`,
  );
}

async function requireDirectory(deno: DenoRuntime, path: URL, source: string): Promise<void> {
  try {
    const info = await deno.stat(path);
    if (info.isDirectory === true) {
      return;
    }
  } catch {}
  throw new Error(
    `${source} does not point to an existing directory: ${decodeURIComponent(path.pathname)}`,
  );
}

async function requireIcuDataDirectory(
  deno: DenoRuntime,
  path: URL,
  source: string,
): Promise<void> {
  await requireDirectory(deno, path, source);
  for await (const entry of deno.readDir(path)) {
    if (entry.isFile === true && entry.name.startsWith('icudt') && entry.name.endsWith('.dat')) {
      return;
    }
    if (entry.isDirectory === true && entry.name.startsWith('icudt')) {
      return;
    }
  }
  throw new Error(
    `${source} does not contain ICU icudt data files: ${decodeURIComponent(path.pathname)}`,
  );
}

async function requireClusterSeedDirectory(
  deno: DenoRuntime,
  path: URL,
  profile: NativeCatalogProfile,
  target: string,
  source: string,
): Promise<string | undefined> {
  await requireDirectory(deno, path, source);
  const root = directoryUrl(path);
  await requireFile(deno, new URL('files/PG_VERSION', root), `${source} PG_VERSION`);
  await requireFile(deno, new URL('files/global/pg_control', root), `${source} pg_control`);
  const manifest = await deno.readTextFile(new URL('manifest.properties', root)).catch(() => '');
  return validateNativeClusterSeedManifest(manifest, profile, target, source);
}

function denoRuntime(): DenoRuntime {
  const deno = optionalDenoRuntime();
  if (deno === undefined) {
    throw new Error('Deno native binding can only be used inside Deno');
  }
  return deno;
}

function optionalDenoRuntime(): DenoRuntime | undefined {
  const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
  return deno;
}

function denoRuntimeFileHost(deno: DenoRuntime): RuntimeFileHost {
  return {
    join,
    async readDir(path: string) {
      const entries: Array<{ name: string; isFile?: boolean }> = [];
      for await (const entry of deno.readDir(path)) {
        entries.push({ name: entry.name, isFile: entry.isFile });
      }
      return entries;
    },
    async isDirectory(path: string) {
      try {
        return (await deno.stat(path)).isDirectory === true;
      } catch {
        return false;
      }
    },
    async isFile(path: string) {
      try {
        return (await deno.stat(path)).isFile === true;
      } catch {
        return false;
      }
    },
  };
}
