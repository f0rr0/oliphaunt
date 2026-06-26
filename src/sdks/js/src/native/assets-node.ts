import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type GeneratedExtensionMetadata,
  generatedExtensionBySqlName,
} from '../generated/extensions.js';
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
  moduleDirectory?: string;
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

type ExtensionPackageMetadata = {
  name?: string;
  version?: string;
  oliphaunt?: {
    product?: string;
    kind?: string;
    sqlName?: string;
    target?: string;
    runtimeRelativePath?: string;
    moduleRelativePath?: string;
    liboliphauntVersion?: string;
    targetPackageNames?: Record<string, string>;
    payloadPackageNames?: string[];
  };
};

const require = createRequire(import.meta.url);

export async function resolveNodeNativeInstall(
  libraryPath?: string,
): Promise<ResolvedNativeInstall> {
  const versions = await packageVersions();
  const icuDataDirectory = await resolveNodeIcuDataDirectory(
    versions.icuVersion,
    versions.icuPackage,
  );
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

export async function materializeNodeExtensionInstall(
  install: ResolvedNativeInstall,
  extensions: ReadonlyArray<string> = [],
): Promise<ResolvedNativeInstall> {
  const selected = selectedExtensionClosure(extensions);
  if (selected.length === 0) {
    return install;
  }
  if (install.runtimeDirectory === undefined) {
    throw new Error(
      `native extension packages require a package-managed runtime directory; selected extensions: ${selected.join(', ')}`,
    );
  }

  const versions = await packageVersions();
  const target = liboliphauntPackageTarget(platform(), arch());
  const packages = await Promise.all(
    selected.map((sqlName) =>
      resolveExtensionPackage(sqlName, target.id, versions.liboliphauntVersion),
    ),
  );
  const cacheKey = runtimeCacheKey({
    libraryPath: install.libraryPath,
    runtimeDirectory: install.runtimeDirectory,
    target: target.id,
    packages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      runtimeDirectories: entry.runtimeDirectories,
      moduleDirectories: entry.moduleDirectories,
    })),
  });
  const root = join(tmpdir(), 'oliphaunt-js-runtime-cache', cacheKey);
  const runtimeDirectory = join(root, 'runtime');
  const moduleDirectory = join(root, 'modules');
  const marker = join(root, 'manifest.json');
  const manifest = JSON.stringify(
    {
      runtimeDirectory: install.runtimeDirectory,
      libraryPath: install.libraryPath,
      target: target.id,
      packages: packages.map((entry) => ({
        name: entry.name,
        version: entry.version,
        sqlName: entry.sqlName,
      })),
    },
    null,
    2,
  );
  if ((await optionalRead(marker)) === manifest) {
    return { ...install, runtimeDirectory, moduleDirectory };
  }

  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });
  await cp(install.runtimeDirectory, runtimeDirectory, { recursive: true });
  await mkdir(moduleDirectory, { recursive: true });
  for (const source of nativeModuleDirectoryCandidates(install.libraryPath)) {
    if (await isDirectory(source)) {
      await cp(source, moduleDirectory, { force: true, recursive: true });
    }
  }
  for (const entry of packages) {
    for (const source of entry.runtimeDirectories) {
      await cp(source, runtimeDirectory, { force: true, recursive: true });
    }
    for (const source of entry.moduleDirectories) {
      if (await isDirectory(source)) {
        await cp(source, moduleDirectory, { force: true, recursive: true });
      }
    }
  }
  await writeFile(marker, manifest, 'utf8');
  return { ...install, runtimeDirectory, moduleDirectory };
}

export async function resolveNodeIcuDataDirectory(
  expectedVersion?: string,
  packageName?: string,
): Promise<string | undefined> {
  const versions =
    expectedVersion === undefined || packageName === undefined
      ? await packageVersions()
      : undefined;
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
  const dataDirectory = resolvePackageRelativePath(
    packageRoot,
    packageJson.oliphaunt.dataRelativePath ?? 'share/icu',
    `${name} ICU data directory metadata`,
  );
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

type ResolvedExtensionPackage = {
  name: string;
  version: string;
  sqlName: string;
  runtimeDirectories: string[];
  moduleDirectories: string[];
};

async function resolveExtensionPackage(
  sqlName: string,
  target: string,
  liboliphauntVersion: string,
): Promise<ResolvedExtensionPackage> {
  const packageName = extensionPackageName(sqlName);
  const targetPackageName = extensionTargetPackageName(sqlName, target);
  const packageJsonPath = await resolveExtensionTargetPackageJson(
    packageName,
    targetPackageName,
    sqlName,
    target,
  );
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as ExtensionPackageMetadata;
  const expectedProduct = `oliphaunt-extension-${sqlName.replaceAll('_', '-')}`;
  if (packageJson.name !== targetPackageName) {
    throw new Error(
      `${targetPackageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  if (packageJson.oliphaunt?.kind !== 'exact-extension-target') {
    throw new Error(
      `${targetPackageName} package metadata does not declare an exact Oliphaunt extension target`,
    );
  }
  if (packageJson.oliphaunt?.product !== expectedProduct) {
    throw new Error(`${targetPackageName} package metadata does not declare ${expectedProduct}`);
  }
  if (packageJson.oliphaunt?.sqlName !== sqlName) {
    throw new Error(
      `${targetPackageName} package metadata does not declare SQL extension ${sqlName}`,
    );
  }
  if (packageJson.oliphaunt?.target !== target) {
    throw new Error(`${targetPackageName} package metadata does not target ${target}`);
  }
  if (packageJson.oliphaunt?.liboliphauntVersion !== liboliphauntVersion) {
    throw new Error(
      `${targetPackageName} liboliphauntVersion ${packageJson.oliphaunt?.liboliphauntVersion ?? '<missing>'} does not match @oliphaunt/ts liboliphauntVersion ${liboliphauntVersion}`,
    );
  }
  if (packageJson.version === undefined || packageJson.version.length === 0) {
    throw new Error(`${targetPackageName} package metadata is missing version`);
  }
  const runtimeDirectories: string[] = [];
  const moduleDirectories: string[] = [];
  const extension = generatedExtensionBySqlName(sqlName);
  if (extension === undefined) {
    throw new Error(`unknown Oliphaunt extension id '${sqlName}'`);
  }
  const payloadPackageNames = packageJson.oliphaunt.payloadPackageNames ?? [];
  if (payloadPackageNames.length > 0) {
    for (const payloadPackageName of payloadPackageNames) {
      const payload = await resolveExtensionPayloadPackage(
        payloadPackageName,
        packageJsonPath,
        expectedProduct,
        sqlName,
        target,
        liboliphauntVersion,
      );
      runtimeDirectories.push(payload.runtimeDirectory);
      if (payload.moduleDirectory !== undefined) {
        moduleDirectories.push(payload.moduleDirectory);
      }
    }
  } else {
    const runtimeDirectory = resolvePackageRelativePath(
      packageRoot,
      packageJson.oliphaunt.runtimeRelativePath ?? 'runtime',
      `${targetPackageName} extension runtime directory metadata`,
    );
    await requireDirectory(runtimeDirectory, `${targetPackageName} extension runtime directory`);
    runtimeDirectories.push(runtimeDirectory);
    const moduleRelativePath = packageJson.oliphaunt.moduleRelativePath;
    const moduleDirectory =
      moduleRelativePath === undefined
        ? undefined
        : resolvePackageRelativePath(
            packageRoot,
            moduleRelativePath,
            `${targetPackageName} extension module directory metadata`,
          );
    if (moduleDirectory !== undefined) {
      await requireDirectory(moduleDirectory, `${targetPackageName} extension module directory`);
      moduleDirectories.push(moduleDirectory);
    }
  }
  await requireExtensionPackagePayload({
    extension,
    target,
    source: targetPackageName,
    runtimeDirectories,
    moduleDirectories,
  });
  return {
    name: targetPackageName,
    version: packageJson.version,
    sqlName,
    runtimeDirectories,
    moduleDirectories,
  };
}

async function resolveExtensionPayloadPackage(
  packageName: string,
  targetPackageJsonPath: string,
  expectedProduct: string,
  sqlName: string,
  target: string,
  liboliphauntVersion: string,
): Promise<{ runtimeDirectory: string; moduleDirectory?: string }> {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(targetPackageJsonPath).resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `${packageName} is not installed; reinstall ${extensionPackageName(sqlName)} with optional dependencies enabled`,
      { cause: error },
    );
  }
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as ExtensionPackageMetadata;
  if (packageJson.name !== packageName) {
    throw new Error(`${packageName} package metadata has name ${packageJson.name ?? '<missing>'}`);
  }
  if (packageJson.oliphaunt?.kind !== 'exact-extension-payload') {
    throw new Error(`${packageName} package metadata does not declare an exact extension payload`);
  }
  if (packageJson.oliphaunt?.product !== expectedProduct) {
    throw new Error(`${packageName} package metadata does not declare ${expectedProduct}`);
  }
  if (packageJson.oliphaunt?.sqlName !== sqlName) {
    throw new Error(`${packageName} package metadata does not declare SQL extension ${sqlName}`);
  }
  if (packageJson.oliphaunt?.target !== target) {
    throw new Error(`${packageName} package metadata does not target ${target}`);
  }
  if (packageJson.oliphaunt?.liboliphauntVersion !== liboliphauntVersion) {
    throw new Error(
      `${packageName} liboliphauntVersion ${packageJson.oliphaunt?.liboliphauntVersion ?? '<missing>'} does not match @oliphaunt/ts liboliphauntVersion ${liboliphauntVersion}`,
    );
  }
  const runtimeDirectory = resolvePackageRelativePath(
    packageRoot,
    packageJson.oliphaunt.runtimeRelativePath ?? 'runtime',
    `${packageName} extension runtime directory metadata`,
  );
  await requireDirectory(runtimeDirectory, `${packageName} extension runtime directory`);
  const moduleRelativePath = packageJson.oliphaunt.moduleRelativePath;
  const moduleDirectory =
    moduleRelativePath === undefined
      ? undefined
      : resolvePackageRelativePath(
          packageRoot,
          moduleRelativePath,
          `${packageName} extension module directory metadata`,
        );
  if (moduleDirectory !== undefined) {
    await requireDirectory(moduleDirectory, `${packageName} extension module directory`);
  }
  return { runtimeDirectory, moduleDirectory };
}

async function requireExtensionPackagePayload(config: {
  extension: GeneratedExtensionMetadata;
  target: string;
  source: string;
  runtimeDirectories: readonly string[];
  moduleDirectories: readonly string[];
}): Promise<void> {
  if (config.extension.createsExtension) {
    const entries = await extensionSqlDirectoryEntries(config.runtimeDirectories);
    const hasControl = entries.includes(`${config.extension.sqlName}.control`);
    if (!hasControl) {
      throw new Error(
        `${config.source} extension runtime payload is missing ${config.extension.sqlName}.control`,
      );
    }
    const hasInstallSql = entries.some(
      (entry) => entry.endsWith('.sql') && extensionSqlFileBelongs(config.extension, entry),
    );
    if (!hasInstallSql) {
      throw new Error(
        `${config.source} extension runtime payload is missing SQL install files for ${config.extension.sqlName}`,
      );
    }
  }

  for (const dataFile of config.extension.dataFiles) {
    await requireFileInAnyRoot(
      config.runtimeDirectories,
      dataFile,
      `${config.source} extension runtime payload`,
    );
  }

  if (config.extension.nativeModuleStem !== null) {
    const moduleFile = `${config.extension.nativeModuleStem}${nativeModuleSuffixForTarget(config.target)}`;
    await requireFileInAnyRoot(
      config.moduleDirectories,
      moduleFile,
      `${config.source} extension module payload`,
    );
  }
}

async function extensionSqlDirectoryEntries(
  runtimeDirectories: readonly string[],
): Promise<string[]> {
  const entries: string[] = [];
  for (const runtimeDirectory of runtimeDirectories) {
    const extensionDirectory = join(runtimeDirectory, 'share/postgresql/extension');
    if (!(await isDirectory(extensionDirectory))) {
      continue;
    }
    for (const entry of await readdir(extensionDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        entries.push(entry.name);
      }
    }
  }
  return entries;
}

function extensionSqlFileBelongs(extension: GeneratedExtensionMetadata, fileName: string): boolean {
  return (
    fileName === `${extension.sqlName}.control` ||
    fileName === `${extension.sqlName}.sql` ||
    (fileName.startsWith(`${extension.sqlName}--`) && fileName.endsWith('.sql')) ||
    extension.extensionSqlFileNames.includes(fileName) ||
    extension.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix))
  );
}

async function requireFileInAnyRoot(
  roots: readonly string[],
  relativePath: string,
  source: string,
): Promise<void> {
  for (const root of roots) {
    const path = join(root, relativePath);
    try {
      if ((await stat(path)).isFile()) {
        return;
      }
    } catch {}
  }
  throw new Error(`${source} is missing required file ${relativePath}`);
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
  const libraryPath = resolvePackageRelativePath(
    packageRoot,
    packageJson.oliphaunt?.libraryRelativePath ?? target.libraryRelativePath,
    `${target.packageName} liboliphaunt library metadata`,
  );
  await requireFile(libraryPath, `${target.packageName} liboliphaunt library`);
  const runtimeDirectory = resolvePackageRelativePath(
    packageRoot,
    packageJson.oliphaunt?.runtimeRelativePath ?? target.runtimeRelativePath,
    `${target.packageName} runtime directory metadata`,
  );
  await requireDirectory(runtimeDirectory, `${target.packageName} runtime directory`);
  for (const tool of nativeRuntimeToolsForTarget(target.id)) {
    await requireFile(
      join(runtimeDirectory, 'bin', tool),
      `${target.packageName} runtime tool bin/${tool}`,
    );
  }
  const tools = await resolveNativeToolsPackage(target, expectedVersion, packageJsonPath);
  const mergedRuntimeDirectory = await materializeNativeToolsRuntime({
    target: target.id,
    libraryPath,
    runtimePackage: {
      name: target.packageName,
      version: packageJson.version,
      runtimeDirectory,
    },
    toolsPackage: tools,
  });
  return { libraryPath, runtimeDirectory: mergedRuntimeDirectory, icuDataDirectory };
}

async function resolveNativeToolsPackage(
  target: NativePackageTarget,
  expectedVersion: string,
  runtimePackageJsonPath: string,
): Promise<{ name: string; version: string; runtimeDirectory: string }> {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(runtimePackageJsonPath).resolve(
      `${target.toolsPackageName}/package.json`,
    );
  } catch (error) {
    throw new Error(
      `${target.toolsPackageName} is not installed; reinstall @oliphaunt/ts with optional dependencies enabled`,
      { cause: error },
    );
  }
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
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
  const runtimeDirectory = resolvePackageRelativePath(
    packageRoot,
    packageJson.oliphaunt?.runtimeRelativePath ?? target.toolsRuntimeRelativePath,
    `${target.toolsPackageName} runtime directory metadata`,
  );
  await requireDirectory(runtimeDirectory, `${target.toolsPackageName} runtime directory`);
  for (const tool of nativeClientToolsForTarget(target.id)) {
    await requireFile(
      join(runtimeDirectory, 'bin', tool),
      `${target.toolsPackageName} native tool bin/${tool}`,
    );
  }
  return {
    name: target.toolsPackageName,
    version: packageJson.version,
    runtimeDirectory,
  };
}

async function materializeNativeToolsRuntime(config: {
  target: string;
  libraryPath: string;
  runtimePackage: {
    name: string;
    version?: string;
    runtimeDirectory: string;
  };
  toolsPackage: {
    name: string;
    version: string;
    runtimeDirectory: string;
  };
}): Promise<string> {
  const cacheKey = runtimeCacheKey(config);
  const root = join(tmpdir(), 'oliphaunt-js-runtime-cache', cacheKey);
  const runtimeDirectory = join(root, 'runtime');
  const marker = join(root, 'manifest.json');
  const manifest = JSON.stringify(config, null, 2);
  if ((await optionalRead(marker)) === manifest) {
    return runtimeDirectory;
  }

  await rm(root, { force: true, recursive: true });
  await mkdir(root, { recursive: true });
  await cp(config.runtimePackage.runtimeDirectory, runtimeDirectory, { recursive: true });
  await cp(config.toolsPackage.runtimeDirectory, runtimeDirectory, {
    force: true,
    recursive: true,
  });
  await writeFile(marker, manifest, 'utf8');
  return runtimeDirectory;
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

async function resolveExtensionTargetPackageJson(
  packageName: string,
  targetPackageName: string,
  sqlName: string,
  target: string,
): Promise<string> {
  const packageJsonPath = optionalResolvePackageJson(packageName);
  if (packageJsonPath === undefined) {
    return resolveExtensionPackageJson(targetPackageName, packageName);
  }

  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as ExtensionPackageMetadata;
  const expectedProduct = `oliphaunt-extension-${sqlName.replaceAll('_', '-')}`;
  if (packageJson.name !== packageName) {
    throw new Error(`${packageName} package metadata has name ${packageJson.name ?? '<missing>'}`);
  }
  if (packageJson.oliphaunt?.kind !== 'exact-extension') {
    throw new Error(
      `${packageName} package metadata does not declare an exact Oliphaunt extension`,
    );
  }
  if (packageJson.oliphaunt?.product !== expectedProduct) {
    throw new Error(`${packageName} package metadata does not declare ${expectedProduct}`);
  }
  if (packageJson.oliphaunt?.sqlName !== sqlName) {
    throw new Error(`${packageName} package metadata does not declare SQL extension ${sqlName}`);
  }
  const resolvedTargetPackageName =
    packageJson.oliphaunt.targetPackageNames?.[target] ?? targetPackageName;
  try {
    return createRequire(packageJsonPath).resolve(`${resolvedTargetPackageName}/package.json`);
  } catch (error) {
    throw new Error(
      `${resolvedTargetPackageName} is not installed; reinstall ${packageName} with optional dependencies enabled`,
      { cause: error },
    );
  }
}

function resolveExtensionPackageJson(packageName: string, installPackageName: string): string {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `${installPackageName} is not installed; add it to the application dependencies for CREATE EXTENSION support`,
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

export function resolvePackageRelativePath(
  packageRoot: string,
  metadataPath: string,
  source: string,
): string {
  const relativePath = safePackageRelativePath(metadataPath, source);
  const root = resolve(packageRoot);
  const resolved = resolve(root, relativePath);
  const fromRoot = relative(root, resolved);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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

async function optionalRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function extensionPackageName(sqlName: string): string {
  return `@oliphaunt/extension-${sqlName.replaceAll('_', '-')}`;
}

function extensionTargetPackageName(sqlName: string, target: string): string {
  return `${extensionPackageName(sqlName)}-${target}`;
}

function selectedExtensionClosure(extensions: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const queue = [...extensions];
  while (queue.length > 0) {
    const sqlName = queue.shift();
    if (sqlName === undefined || seen.has(sqlName)) {
      continue;
    }
    seen.add(sqlName);
    const metadata = generatedExtensionBySqlName(sqlName);
    if (metadata === undefined) {
      throw new Error(`unknown Oliphaunt extension id '${sqlName}'`);
    }
    for (const dependency of metadata.selectedExtensionDependencies) {
      queue.push(dependency);
    }
  }
  return [...seen].sort();
}

function nativeModuleDirectoryCandidates(libraryPath: string): string[] {
  const libraryDir = dirname(libraryPath);
  return [join(libraryDir, 'modules'), join(dirname(libraryDir), 'lib', 'modules')];
}

function nativeRuntimeToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc'
    ? ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']
    : ['initdb', 'pg_ctl', 'postgres'];
}

function nativeClientToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc' ? ['pg_dump.exe', 'psql.exe'] : ['pg_dump', 'psql'];
}

function nativeModuleSuffixForTarget(target: string): string {
  if (target.startsWith('macos-')) {
    return '.dylib';
  }
  if (target === 'windows-x64-msvc') {
    return '.dll';
  }
  return '.so';
}

function runtimeCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
