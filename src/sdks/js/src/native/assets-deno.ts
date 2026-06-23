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
};

type DenoRuntime = {
  build: { os: string; arch: string };
  readTextFile(path: string | URL): Promise<string>;
  readDir(path: string | URL): AsyncIterable<{ name: string; isFile?: boolean; isDirectory?: boolean }>;
  stat(path: string | URL): Promise<{ isFile?: boolean; isDirectory?: boolean }>;
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

export async function resolveDenoNativeInstall(
  libraryPath?: string,
): Promise<ResolvedDenoNativeInstall> {
  const explicit = resolveExplicitLibraryPath(libraryPath);
  if (explicit !== undefined) {
    return {
      libraryPath: explicit,
      runtimeDirectory: resolveExplicitRuntimeDirectory(),
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
  const libraryUrl = new URL(
    packageJson.oliphaunt?.libraryRelativePath ?? target.libraryRelativePath,
    packageRoot,
  );
  await requireFile(deno, libraryUrl, `${target.packageName} liboliphaunt library`);
  const runtimeUrl = new URL(
    `${packageJson.oliphaunt?.runtimeRelativePath ?? target.runtimeRelativePath}/`,
    new URL('.', packageJsonUrl),
  );
  await requireDirectory(deno, runtimeUrl, `${target.packageName} runtime directory`);
  return {
    libraryPath: decodeURIComponent(libraryUrl.pathname),
    runtimeDirectory: decodeURIComponent(runtimeUrl.pathname.replace(/\/+$/, '')),
    icuDataDirectory,
  };
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
  const dataUrl = new URL(packageJson.oliphaunt.dataRelativePath ?? 'share/icu', new URL('.', packageJsonUrl));
  await requireIcuDataDirectory(deno, dataUrl, `${packageName} ICU data directory`);
  return decodeURIComponent(dataUrl.pathname.replace(/\/+$/, ''));
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
  const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
  if (deno === undefined) {
    throw new Error('Deno native binding can only be used inside Deno');
  }
  return deno;
}
