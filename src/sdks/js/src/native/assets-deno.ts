import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  liboliphauntPackageTarget,
  type NativePackageTarget,
  resolveExplicitLibraryPath,
  resolveExplicitRuntimeDirectory,
} from './common.js';

export type ResolvedDenoNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
  icuDataDirectory?: string;
  packageManaged: boolean;
};

type DenoRuntime = {
  build: { os: string; arch: string };
  env?: { get(name: string): string | undefined };
  readTextFile(path: string | URL): Promise<string>;
  writeTextFile(path: string | URL, data: string): Promise<void>;
  readDir(path: string | URL): AsyncIterable<{ name: string; isFile?: boolean; isDirectory?: boolean }>;
  stat(path: string | URL): Promise<{ isFile?: boolean; isDirectory?: boolean }>;
  mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  copyFile(from: string | URL, to: string | URL): Promise<void>;
};

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
  };
};

type NativeToolsPackageMetadata = {
  name?: string;
  version?: string;
  oliphaunt?: {
    product?: string;
    kind?: string;
    target?: string;
    runtimeRelativePath?: string;
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
  };
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
        : await resolveDenoIcuDataDirectory(
            deno,
            versions.icuVersion,
            versions.icuPackage,
          );
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
      icuDataDirectory,
      packageManaged: false,
    };
  }

  const deno = denoRuntime();
  const versions = await packageVersions(deno);
  const icuDataDirectory = await resolveDenoIcuDataDirectory(
    deno,
    versions.icuVersion,
    versions.icuPackage,
  );
  const target = liboliphauntPackageTarget(deno.build.os, deno.build.arch);
  return resolvePackageNativeInstall(deno, target, versions.liboliphauntVersion, icuDataDirectory);
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
  icuDataDirectory: string | undefined,
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
  const packageRoot = new URL('.', packageJsonUrl);
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
  const tools = await resolveDenoNativeToolsPackage(deno, target, expectedVersion);
  const libraryPath = fileURLToPath(libraryUrl);
  const mergedRuntimeDirectory = await materializeDenoToolsRuntime(deno, {
    target: target.id,
    libraryPath,
    runtimePackage: {
      name: target.packageName,
      version: packageJson.version,
      runtimeDirectory: fileURLToPath(runtimeUrl),
      runtimeUrl,
    },
    toolsPackage: tools,
  });
  return {
    libraryPath,
    runtimeDirectory: mergedRuntimeDirectory,
    icuDataDirectory,
    packageManaged: true,
  };
}

async function resolveDenoNativeToolsPackage(
  deno: DenoRuntime,
  target: NativePackageTarget,
  expectedVersion: string,
): Promise<{ name: string; version: string; runtimeDirectory: string; runtimeUrl: URL }> {
  const packageJsonUrl = resolvePackageJsonUrl(target.toolsPackageName);
  const packageJson = JSON.parse(
    await deno.readTextFile(packageJsonUrl),
  ) as NativeToolsPackageMetadata;
  if (packageJson.name !== target.toolsPackageName) {
    throw new Error(
      `${target.toolsPackageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `${target.toolsPackageName} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts liboliphauntVersion ${expectedVersion}`,
    );
  }
  if (packageJson.oliphaunt?.product !== 'oliphaunt-tools') {
    throw new Error(`${target.toolsPackageName} package metadata does not declare oliphaunt-tools`);
  }
  if (packageJson.oliphaunt?.kind !== 'native-tools') {
    throw new Error(`${target.toolsPackageName} package metadata does not declare native tools`);
  }
  if (packageJson.oliphaunt?.target !== target.id) {
    throw new Error(`${target.toolsPackageName} package metadata does not target ${target.id}`);
  }
  const runtimeUrl = resolvePackageRelativeUrl(
    new URL('.', packageJsonUrl),
    packageJson.oliphaunt?.runtimeRelativePath ?? target.toolsRuntimeRelativePath,
    `${target.toolsPackageName} runtime directory metadata`,
  );
  await requireDirectory(deno, runtimeUrl, `${target.toolsPackageName} runtime directory`);
  for (const tool of nativeClientToolsForTarget(target.id)) {
    await requireFile(
      deno,
      new URL(`bin/${tool}`, directoryUrl(runtimeUrl)),
      `${target.toolsPackageName} native tool bin/${tool}`,
    );
  }
  return {
    name: target.toolsPackageName,
    version: packageJson.version,
    runtimeDirectory: fileURLToPath(runtimeUrl),
    runtimeUrl,
  };
}

async function materializeDenoToolsRuntime(
  deno: DenoRuntime,
  config: {
    target: string;
    libraryPath: string;
    runtimePackage: {
      name: string;
      version?: string;
      runtimeDirectory: string;
      runtimeUrl: URL;
    };
    toolsPackage: {
      name: string;
      version: string;
      runtimeDirectory: string;
      runtimeUrl: URL;
    };
  },
): Promise<string> {
  const cacheRoot = denoRuntimeCacheRoot(deno);
  const root = pathToFileURL(join(cacheRoot, runtimeCacheKey(config)));
  const runtimeUrl = pathToFileURL(join(fileURLToPath(root), 'runtime'));
  const marker = pathToFileURL(join(fileURLToPath(root), 'manifest.json'));
  const manifest = JSON.stringify(
    {
      target: config.target,
      libraryPath: config.libraryPath,
      runtimePackage: {
        name: config.runtimePackage.name,
        version: config.runtimePackage.version,
        runtimeDirectory: config.runtimePackage.runtimeDirectory,
      },
      toolsPackage: {
        name: config.toolsPackage.name,
        version: config.toolsPackage.version,
        runtimeDirectory: config.toolsPackage.runtimeDirectory,
      },
    },
    null,
    2,
  );
  if ((await optionalReadText(deno, marker)) === manifest) {
    return fileURLToPath(runtimeUrl);
  }

  await removeTree(deno, root);
  await deno.mkdir(root, { recursive: true });
  await copyDirectory(deno, config.runtimePackage.runtimeUrl, runtimeUrl);
  await copyDirectory(deno, config.toolsPackage.runtimeUrl, runtimeUrl);
  await deno.writeTextFile(marker, manifest);
  return fileURLToPath(runtimeUrl);
}

async function resolveDenoIcuDataDirectory(
  deno: DenoRuntime,
  expectedVersion: string,
  packageName: string,
): Promise<string | undefined> {
  const packageJsonUrl = optionalResolvePackageJsonUrl(packageName);
  if (packageJsonUrl === undefined) {
    return undefined;
  }
  const packageJson = JSON.parse(await deno.readTextFile(packageJsonUrl)) as IcuPackageMetadata;
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
  const dataUrl = resolvePackageRelativeUrl(
    new URL('.', packageJsonUrl),
    packageJson.oliphaunt.dataRelativePath ?? 'share/icu',
    `${packageName} ICU data directory metadata`,
  );
  await requireIcuDataDirectory(deno, dataUrl, `${packageName} ICU data directory`);
  return fileURLToPath(dataUrl);
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

async function copyDirectory(deno: DenoRuntime, source: URL, destination: URL): Promise<void> {
  await deno.mkdir(destination, { recursive: true });
  for await (const entry of deno.readDir(source)) {
    const sourceChild = new URL(encodePathSegment(entry.name), directoryUrl(source));
    const destinationChild = new URL(encodePathSegment(entry.name), directoryUrl(destination));
    if (entry.isDirectory === true) {
      await copyDirectory(deno, sourceChild, destinationChild);
    } else if (entry.isFile === true) {
      await deno.copyFile(sourceChild, destinationChild);
    } else {
      const info = await deno.stat(sourceChild);
      if (info.isDirectory === true) {
        await copyDirectory(deno, sourceChild, destinationChild);
      } else if (info.isFile === true) {
        await deno.copyFile(sourceChild, destinationChild);
      }
    }
  }
}

async function optionalReadText(
  deno: DenoRuntime,
  path: string | URL,
): Promise<string | undefined> {
  try {
    return await deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

async function removeTree(deno: DenoRuntime, path: string | URL): Promise<void> {
  try {
    await deno.remove(path, { recursive: true });
  } catch {}
}

function denoRuntimeCacheRoot(deno: DenoRuntime): string {
  const temp =
    denoEnv(deno, 'TMPDIR') ??
    denoEnv(deno, 'TMP') ??
    denoEnv(deno, 'TEMP') ??
    (deno.build.os === 'windows' ? 'C:\\Temp' : '/tmp');
  return join(temp, 'oliphaunt-js-runtime-cache');
}

function denoEnv(deno: DenoRuntime, name: string): string | undefined {
  try {
    return deno.env?.get(name);
  } catch {
    return undefined;
  }
}

function nativeRuntimeToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc'
    ? ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']
    : ['initdb', 'pg_ctl', 'postgres'];
}

function nativeClientToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc' ? ['pg_dump.exe', 'psql.exe'] : ['pg_dump', 'psql'];
}

function runtimeCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function directoryUrl(url: URL): URL {
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/');
}

function resolvePackageJsonUrl(packageName: string): URL {
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (resolver === undefined) {
    throw new Error('Deno native resolution requires import.meta.resolve support');
  }
  try {
    return new URL(resolver(`${packageName}/package.json`));
  } catch (error) {
    throw new Error(
      `${packageName} is not installed; import Oliphaunt from npm:@oliphaunt/ts with optional dependencies enabled`,
      { cause: error },
    );
  }
}

function optionalResolvePackageJsonUrl(packageName: string): URL | undefined {
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (resolver === undefined) {
    throw new Error('Deno native resolution requires import.meta.resolve support');
  }
  try {
    return new URL(resolver(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

async function requireFile(deno: DenoRuntime, path: URL, source: string): Promise<void> {
  try {
    const info = await deno.stat(path);
    if (info.isFile === true) {
      return;
    }
  } catch {}
  throw new Error(`${source} does not point to an existing file: ${decodeURIComponent(path.pathname)}`);
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
  throw new Error(`${source} does not contain ICU icudt data files: ${decodeURIComponent(path.pathname)}`);
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
