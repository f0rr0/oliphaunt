import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import {
  liboliphauntPackageTarget,
  type NativePackageTarget,
  resolveExplicitLibraryPath,
  resolveExplicitRuntimeDirectory,
} from './common.js';

export type ResolvedNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
  icuDataDirectory?: string;
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

const require = createRequire(import.meta.url);

export async function resolveNodeNativeInstall(
  libraryPath?: string,
): Promise<ResolvedNativeInstall> {
  const versions = await packageVersions();
  const icuDataDirectory = await resolveNodeIcuDataDirectory(versions.icuVersion, versions.icuPackage);
  const explicit = resolveExplicitLibraryPath(libraryPath);
  if (explicit !== undefined) {
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
      icuDataDirectory,
    };
  }

  const target = liboliphauntPackageTarget(platform(), arch());
  return resolvePackageNativeInstall(target, versions.liboliphauntVersion, icuDataDirectory);
}

export async function resolveNodeIcuDataDirectory(
  expectedVersion?: string,
  packageName?: string,
): Promise<string | undefined> {
  const versions =
    expectedVersion === undefined || packageName === undefined ? await packageVersions() : undefined;
  const expected = expectedVersion ?? versions?.icuVersion;
  const name = packageName ?? versions?.icuPackage ?? '@oliphaunt/icu';
  const packageJsonPath = optionalResolvePackageJson(name);
  if (packageJsonPath === undefined) {
    return undefined;
  }
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as IcuPackageMetadata;
  if (packageJson.name !== name) {
    throw new Error(`${name} package metadata has name ${packageJson.name ?? '<missing>'}`);
  }
  if (expected !== undefined && packageJson.version !== expected) {
    throw new Error(
      `${name} version ${packageJson.version ?? '<missing>'} does not match @oliphaunt/ts icuVersion ${expected}`,
    );
  }
  if (packageJson.oliphaunt?.product !== 'oliphaunt-icu') {
    throw new Error(`${name} package metadata does not declare oliphaunt-icu`);
  }
  if (packageJson.oliphaunt?.kind !== 'icu-data') {
    throw new Error(`${name} package metadata does not declare ICU data`);
  }
  if (packageJson.oliphaunt?.target !== 'portable') {
    throw new Error(`${name} package metadata must target portable ICU data`);
  }
  const dataDirectory = join(packageRoot, packageJson.oliphaunt.dataRelativePath ?? 'share/icu');
  await requireIcuDataDirectory(dataDirectory, `${name} ICU data directory`);
  return dataDirectory;
}

async function packageVersions(): Promise<{
  liboliphauntVersion: string;
  icuPackage: string;
  icuVersion: string;
}> {
  const packageJson = JSON.parse(
    await readFile(require.resolve('@oliphaunt/ts/package.json'), 'utf8'),
  ) as PackageMetadata;
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
  target: NativePackageTarget,
  expectedVersion: string,
  icuDataDirectory: string | undefined,
): Promise<ResolvedNativeInstall> {
  const packageJsonPath = resolvePackageJson(target.packageName);
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
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
  const libraryPath = join(
    packageRoot,
    packageJson.oliphaunt?.libraryRelativePath ?? target.libraryRelativePath,
  );
  await requireFile(libraryPath, `${target.packageName} liboliphaunt library`);
  const runtimeDirectory = join(
    packageRoot,
    packageJson.oliphaunt?.runtimeRelativePath ?? target.runtimeRelativePath,
  );
  await requireDirectory(runtimeDirectory, `${target.packageName} runtime directory`);
  return { libraryPath, runtimeDirectory, icuDataDirectory };
}

function resolvePackageJson(packageName: string): string {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `${packageName} is not installed; reinstall @oliphaunt/ts with optional dependencies enabled`,
      { cause: error },
    );
  }
}

function optionalResolvePackageJson(packageName: string): string | undefined {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

async function requireFile(path: string, source: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) {
      return;
    }
  } catch {}
  throw new Error(`${source} does not point to an existing file: ${path}`);
}

async function requireDirectory(path: string, source: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      return;
    }
  } catch {}
  throw new Error(`${source} does not point to an existing directory: ${path}`);
}

async function requireIcuDataDirectory(path: string, source: string): Promise<void> {
  await requireDirectory(path, source);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('icudt') && entry.name.endsWith('.dat')) {
      return;
    }
    if (entry.isDirectory() && entry.name.startsWith('icudt')) {
      return;
    }
  }
  throw new Error(`${source} does not contain ICU icudt data files: ${path}`);
}
