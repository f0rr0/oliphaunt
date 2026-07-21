import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GENERATED_EXTENSION_METADATA,
  generatedExtensionBySqlName,
  type GeneratedExtensionMetadata,
} from '../generated/extensions.js';
import {
  liboliphauntPackageTarget,
  type NativePackageTarget,
  resolveExplicitLibraryPath,
  resolveExplicitRuntimeDirectory,
} from './common.js';
import {
  nativeModuleSuffixForTarget,
  selectedExtensionClosure,
  type RuntimeFileHost,
  validatePreparedRuntimeExtensions,
} from './extension-runtime.js';

export type ResolvedNativeInstall = {
  libraryPath: string;
  runtimeDirectory?: string;
  icuDataDirectory?: string;
  moduleDirectory?: string;
  packageManaged?: boolean;
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
    bundleManifest?: string;
    extensionContract?: string;
    members?: string[];
    memberRuntimeRelativePaths?: Record<string, string>;
    memberModuleRelativePaths?: Record<string, string>;
    targetPackageNames?: Record<string, string>;
    payloadPackageNames?: string[];
  };
};

type NpmExtensionRuntimeBundleMember = {
  sqlName: string;
  kind: 'runtime';
  identity: null;
  path: string;
  sha256: string;
  bytes: number;
  runtimeRelativePath: string;
  moduleRelativePath?: string;
};

type NpmExtensionMemberContract = {
  sqlName: string;
  createsExtension: boolean;
  nativeModuleStem: string | null;
  dependencies: string[];
  dataFiles: string[];
  extensionSqlFileNames: string[];
  extensionSqlFilePrefixes: string[];
  sharedPreloadLibraries: string[];
};

type NpmExtensionContractManifest = {
  schema?: string;
  product?: string;
  version?: string;
  family?: string;
  target?: string;
  members?: unknown[];
};

type NpmExtensionBundleManifest = {
  schema?: string;
  product?: string;
  version?: string;
  family?: string;
  target?: string;
  members?: unknown[];
};

const require = createRequire(import.meta.url);
const CACHE_LOCK_POLL_MS = 25;
const CACHE_LOCK_TIMEOUT_MS = 30_000;
const CACHE_LOCK_STALE_MS = 5 * 60_000;
const MAX_EXTENSION_RUNTIME_FILES = 4096;
const MAX_EXTENSION_RUNTIME_FILE_BYTES = 48 * 1024 * 1024;
const MAX_EXTENSION_RUNTIME_BYTES = 256 * 1024 * 1024;
const NPM_EXTENSION_CONTRACT_SCHEMA = 'oliphaunt-npm-extension-contract-v1';
const NPM_EXTENSION_CONTRACT_MEMBER_FIELDS = [
  'createsExtension',
  'dataFiles',
  'dependencies',
  'extensionSqlFileNames',
  'extensionSqlFilePrefixes',
  'nativeModuleStem',
  'sharedPreloadLibraries',
  'sqlName',
] as const;

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
      packageManaged: false,
    };
  }

  const target = liboliphauntPackageTarget(platform(), arch());
  return resolvePackageNativeInstall(target, versions.liboliphauntVersion, icuDataDirectory);
}

export async function prepareNodeExtensionInstall(
  install: ResolvedNativeInstall,
  extensions: ReadonlyArray<string> = [],
  options: { explicitRuntimeDirectory?: boolean } = {},
): Promise<ResolvedNativeInstall> {
  if (options.explicitRuntimeDirectory === true && extensions.length > 0) {
    return validatePreparedNodeRuntimeExtensions(install, extensions);
  }
  return materializeNodeExtensionInstall(install, extensions);
}

export async function validatePreparedNodeRuntimeExtensions(
  install: ResolvedNativeInstall,
  extensions: ReadonlyArray<string> = [],
): Promise<ResolvedNativeInstall> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const validated = await validatePreparedRuntimeExtensions({
    runtimeDirectory: install.runtimeDirectory,
    extensions,
    target: target.id,
    source: 'explicit native runtimeDirectory',
    host: nodeRuntimeFileHost,
  });
  return {
    ...install,
    runtimeDirectory: validated.runtimeDirectory,
    moduleDirectory: validated.moduleDirectory,
  };
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
  const installRuntimeDirectory = install.runtimeDirectory;

  const versions = await packageVersions();
  const target = liboliphauntPackageTarget(platform(), arch());
  const packages = await Promise.all(
    selected.map((sqlName) =>
      resolveExtensionPackage(sqlName, target.id, versions.liboliphauntVersion),
    ),
  );
  const cacheKey = runtimeCacheKey({
    libraryPath: install.libraryPath,
    runtimeDirectory: installRuntimeDirectory,
    target: target.id,
    packages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      contract: entry.contract,
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
      runtimeDirectory: installRuntimeDirectory,
      libraryPath: install.libraryPath,
      target: target.id,
      packages: packages.map((entry) => ({
        name: entry.name,
        version: entry.version,
        sqlName: entry.sqlName,
        contract: entry.contract,
      })),
    },
    null,
    2,
  );
  if ((await optionalRead(marker)) === manifest) {
    return { ...install, runtimeDirectory, moduleDirectory };
  }

  await publishRuntimeCache(root, manifest, async (stageRoot) => {
    const stageRuntimeDirectory = join(stageRoot, 'runtime');
    const stageModuleDirectory = join(stageRoot, 'modules');
    await cp(installRuntimeDirectory, stageRuntimeDirectory, { recursive: true });
    await mkdir(stageModuleDirectory, { recursive: true });
    for (const source of nativeModuleDirectoryCandidates(install.libraryPath)) {
      if (await isDirectory(source)) {
        await cp(source, stageModuleDirectory, { force: true, recursive: true });
      }
    }
    for (const entry of packages) {
      for (const source of entry.runtimeDirectories) {
        await cp(source, stageRuntimeDirectory, { force: true, recursive: true });
      }
      for (const source of entry.moduleDirectories) {
        if (await isDirectory(source)) {
          await cp(source, stageModuleDirectory, { force: true, recursive: true });
        }
      }
    }
  });
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
  contract: NpmExtensionMemberContract;
  runtimeDirectories: string[];
  moduleDirectories: string[];
};

async function resolveExtensionPackage(
  sqlName: string,
  target: string,
  liboliphauntVersion: string,
): Promise<ResolvedExtensionPackage> {
  const extension = generatedExtensionBySqlName(sqlName);
  if (extension === undefined) {
    throw new Error(`unknown Oliphaunt extension id '${sqlName}'`);
  }
  const packageName = extension.npmPackage;
  const targetPackageName = extensionTargetPackageName(extension, target);
  const resolvedTarget = await resolveExtensionTargetPackageJson(
    extension,
    targetPackageName,
    target,
  );
  const packageJsonPath = resolvedTarget.packageJsonPath;
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as ExtensionPackageMetadata;
  const expectedProduct = extension.releaseProduct;
  const expectedMembers = extensionOwnerMembers(extension);
  const isBundle = expectedMembers.length > 1;
  if (packageJson.name !== targetPackageName) {
    throw new Error(
      `${targetPackageName} package metadata has name ${packageJson.name ?? '<missing>'}`,
    );
  }
  const expectedKind = isBundle ? 'exact-extension-bundle-target' : 'exact-extension-target';
  if (packageJson.oliphaunt?.kind !== expectedKind) {
    throw new Error(`${targetPackageName} package metadata does not declare ${expectedKind}`);
  }
  if (packageJson.oliphaunt?.product !== expectedProduct) {
    throw new Error(`${targetPackageName} package metadata does not declare ${expectedProduct}`);
  }
  requireExtensionPackageMembers(packageJson, expectedMembers, targetPackageName);
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
  if (packageJson.version !== resolvedTarget.ownerVersion) {
    throw new Error(
      `${targetPackageName} version ${packageJson.version} does not match ${packageName} version ${resolvedTarget.ownerVersion}`,
    );
  }
  const memberContracts = await loadExtensionPackageContract({
    extension,
    expectedMembers,
    packageJson,
    packageRoot,
    packageName: targetPackageName,
    target,
  });
  const selectedContract = memberContracts.get(sqlName);
  if (selectedContract === undefined) {
    throw new Error(
      `${targetPackageName} extension contract is missing selected member ${sqlName}`,
    );
  }
  const runtimeDirectories: string[] = [];
  const moduleDirectories: string[] = [];
  const payloadPackageNames = packageJson.oliphaunt.payloadPackageNames ?? [];
  if (
    !Array.isArray(payloadPackageNames) ||
    payloadPackageNames.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error(`${targetPackageName} payloadPackageNames metadata must be a string array`);
  }
  if (payloadPackageNames.length > 0) {
    throw new Error(
      `${targetPackageName} legacy payloadPackageNames carriers are unsupported; publish one exact canonical runtime tree`,
    );
  } else if (isBundle) {
    const payload = await resolveExtensionBundleMember({
      extension,
      expectedMembers,
      packageJson,
      packageRoot,
      packageName: targetPackageName,
      target,
      memberContracts,
    });
    runtimeDirectories.push(payload.runtimeDirectory);
    if (payload.moduleDirectory !== undefined) {
      moduleDirectories.push(payload.moduleDirectory);
    }
  } else {
    const runtimeRelativePath = packageJson.oliphaunt.runtimeRelativePath;
    if (runtimeRelativePath !== 'runtime') {
      throw new Error(`${targetPackageName} extension runtime path must be exactly runtime`);
    }
    const runtimeDirectory = resolvePackageRelativePath(
      packageRoot,
      runtimeRelativePath,
      `${targetPackageName} extension runtime directory metadata`,
    );
    await requireDirectory(runtimeDirectory, `${targetPackageName} extension runtime directory`);
    await requireExactExtensionRuntimeInventory({
      contract: selectedContract,
      runtimeDirectory,
      target,
      source: `${targetPackageName} extension runtime directory`,
    });
    runtimeDirectories.push(runtimeDirectory);
    const moduleRelativePath = packageJson.oliphaunt.moduleRelativePath;
    const expectedModuleRelativePath =
      selectedContract.nativeModuleStem === null ? undefined : 'runtime/lib/modules';
    if (moduleRelativePath !== expectedModuleRelativePath) {
      throw new Error(
        `${targetPackageName} extension module path must be ${expectedModuleRelativePath ?? '<absent>'}`,
      );
    }
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
  return {
    name: targetPackageName,
    version: packageJson.version,
    sqlName,
    contract: selectedContract,
    runtimeDirectories,
    moduleDirectories,
  };
}

function extensionOwnerMembers(extension: GeneratedExtensionMetadata): string[] {
  const rows = GENERATED_EXTENSION_METADATA.filter(
    (candidate) =>
      candidate.releaseProduct === extension.releaseProduct &&
      candidate.npmPackage === extension.npmPackage,
  );
  if (
    rows.length === 0 ||
    rows.some(
      (candidate) =>
        candidate.cargoPackage !== extension.cargoPackage ||
        candidate.mavenGroup !== extension.mavenGroup ||
        candidate.mavenArtifact !== extension.mavenArtifact ||
        candidate.runtimeBound !== extension.runtimeBound,
    )
  ) {
    throw new Error(
      `generated extension metadata has inconsistent release ownership for ${extension.sqlName}`,
    );
  }
  return rows.map((candidate) => candidate.sqlName).sort();
}

function requireExtensionPackageMembers(
  packageJson: ExtensionPackageMetadata,
  expectedMembers: readonly string[],
  packageName: string,
): void {
  if (expectedMembers.length === 1) {
    if (packageJson.oliphaunt?.sqlName !== expectedMembers[0]) {
      throw new Error(
        `${packageName} package metadata does not declare SQL extension ${expectedMembers[0]}`,
      );
    }
    return;
  }
  const members = packageJson.oliphaunt?.members;
  if (
    !Array.isArray(members) ||
    members.some((member) => typeof member !== 'string') ||
    JSON.stringify(members) !== JSON.stringify(expectedMembers)
  ) {
    throw new Error(
      `${packageName} package metadata members must exactly match ${expectedMembers.join(', ')}`,
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseExtensionContractStringList(value: unknown, field: string, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`${label}.${field} must be a string array`);
  }
  const rows = value as string[];
  const canonical = [...new Set(rows)].sort(compareText);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) {
    throw new Error(`${label}.${field} must be sorted and unique`);
  }
  return rows;
}

function parseExtensionMemberContract(value: unknown, label: string): NpmExtensionMemberContract {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort(compareText)) !==
    JSON.stringify(NPM_EXTENSION_CONTRACT_MEMBER_FIELDS)
  ) {
    throw new Error(
      `${label} fields must be exactly ${NPM_EXTENSION_CONTRACT_MEMBER_FIELDS.join(', ')}`,
    );
  }
  if (typeof row.sqlName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(row.sqlName)) {
    throw new Error(`${label}.sqlName must be a portable identifier`);
  }
  if (typeof row.createsExtension !== 'boolean') {
    throw new Error(`${label}.createsExtension must be a boolean`);
  }
  if (
    row.nativeModuleStem !== null &&
    (typeof row.nativeModuleStem !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/u.test(row.nativeModuleStem))
  ) {
    throw new Error(`${label}.nativeModuleStem must be null or a portable identifier`);
  }
  const dependencies = parseExtensionContractStringList(row.dependencies, 'dependencies', label);
  if (
    dependencies.includes(row.sqlName) ||
    dependencies.some((item) => !/^[A-Za-z0-9._-]{1,128}$/u.test(item))
  ) {
    throw new Error(`${label}.dependencies contains an invalid or self dependency`);
  }
  const dataFiles = parseExtensionContractStringList(row.dataFiles, 'dataFiles', label);
  for (const file of dataFiles) {
    const parts = file.split('/');
    if (
      file.includes('\\') ||
      file !== file.normalize('NFC') ||
      file.startsWith('/') ||
      /[\u0000-\u001f\u007f]/u.test(file) ||
      parts.some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(`${label}.dataFiles contains unsafe relative path ${file}`);
    }
  }
  const extensionSqlFileNames = parseExtensionContractStringList(
    row.extensionSqlFileNames,
    'extensionSqlFileNames',
    label,
  );
  if (
    extensionSqlFileNames.some(
      (file) => !/^[A-Za-z0-9._-]+\.sql$/u.test(file) || file.includes('/') || file.includes('\\'),
    )
  ) {
    throw new Error(`${label}.extensionSqlFileNames must contain portable .sql basenames`);
  }
  const extensionSqlFilePrefixes = parseExtensionContractStringList(
    row.extensionSqlFilePrefixes,
    'extensionSqlFilePrefixes',
    label,
  );
  if (extensionSqlFilePrefixes.some((prefix) => !/^[A-Za-z0-9_-]{1,128}$/u.test(prefix))) {
    throw new Error(`${label}.extensionSqlFilePrefixes must contain portable dot-free prefixes`);
  }
  const sharedPreloadLibraries = parseExtensionContractStringList(
    row.sharedPreloadLibraries,
    'sharedPreloadLibraries',
    label,
  );
  if (sharedPreloadLibraries.some((library) => !/^[A-Za-z0-9._-]{1,128}$/u.test(library))) {
    throw new Error(`${label}.sharedPreloadLibraries contains an invalid identifier`);
  }
  return {
    sqlName: row.sqlName,
    createsExtension: row.createsExtension,
    nativeModuleStem: row.nativeModuleStem as string | null,
    dependencies,
    dataFiles,
    extensionSqlFileNames,
    extensionSqlFilePrefixes,
    sharedPreloadLibraries,
  };
}

async function loadExtensionPackageContract(config: {
  extension: GeneratedExtensionMetadata;
  expectedMembers: readonly string[];
  packageJson: ExtensionPackageMetadata;
  packageRoot: string;
  packageName: string;
  target: string;
}): Promise<Map<string, NpmExtensionMemberContract>> {
  const pointer = config.packageJson.oliphaunt?.extensionContract;
  if (pointer !== 'extension-contract.json') {
    throw new Error(
      `${config.packageName} target must declare oliphaunt.extensionContract=extension-contract.json`,
    );
  }
  const contractPath = resolvePackageRelativePath(
    config.packageRoot,
    pointer,
    `${config.packageName} extension contract metadata`,
  );
  await requireFile(contractPath, `${config.packageName} extension contract`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(contractPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${config.packageName} extension contract is not valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${config.packageName} extension contract must be a JSON object`);
  }
  const manifest = parsed as NpmExtensionContractManifest;
  const expectedFields = ['family', 'members', 'product', 'schema', 'target', 'version'];
  if (JSON.stringify(Object.keys(manifest).sort(compareText)) !== JSON.stringify(expectedFields)) {
    throw new Error(
      `${config.packageName} extension contract fields must be exactly ${expectedFields.join(', ')}`,
    );
  }
  if (manifest.schema !== NPM_EXTENSION_CONTRACT_SCHEMA) {
    throw new Error(`${config.packageName} extension contract has unsupported schema`);
  }
  if (
    manifest.product !== config.extension.releaseProduct ||
    manifest.version !== config.packageJson.version ||
    manifest.family !== 'native' ||
    manifest.target !== config.target
  ) {
    throw new Error(
      `${config.packageName} extension contract does not match its product, version, family, and target`,
    );
  }
  if (!Array.isArray(manifest.members)) {
    throw new Error(`${config.packageName} extension contract is missing members`);
  }
  const members = manifest.members.map((member, index) =>
    parseExtensionMemberContract(
      member,
      `${config.packageName} extension contract members[${index}]`,
    ),
  );
  if (
    JSON.stringify(members.map(({ sqlName }) => sqlName)) !== JSON.stringify(config.expectedMembers)
  ) {
    throw new Error(
      `${config.packageName} extension contract members must exactly match ${config.expectedMembers.join(', ')}`,
    );
  }
  for (const member of members) {
    const current = generatedExtensionBySqlName(member.sqlName);
    if (
      current === undefined ||
      current.releaseProduct !== config.extension.releaseProduct ||
      JSON.stringify(current.selectedExtensionDependencies) !== JSON.stringify(member.dependencies)
    ) {
      throw new Error(
        `${config.packageName} extension contract member ${member.sqlName} is incompatible with the SDK dependency contract`,
      );
    }
  }
  return new Map(members.map((member) => [member.sqlName, member]));
}

async function resolveExtensionBundleMember(config: {
  extension: GeneratedExtensionMetadata;
  expectedMembers: readonly string[];
  packageJson: ExtensionPackageMetadata;
  packageRoot: string;
  packageName: string;
  target: string;
  memberContracts: ReadonlyMap<string, NpmExtensionMemberContract>;
}): Promise<{ runtimeDirectory: string; moduleDirectory?: string }> {
  const pointer = config.packageJson.oliphaunt?.bundleManifest;
  if (pointer !== 'bundle-manifest.json') {
    throw new Error(
      `${config.packageName} bundle target must declare oliphaunt.bundleManifest=bundle-manifest.json`,
    );
  }
  const manifestPath = resolvePackageRelativePath(
    config.packageRoot,
    pointer,
    `${config.packageName} bundle manifest metadata`,
  );
  await requireFile(manifestPath, `${config.packageName} bundle manifest`);
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${config.packageName} bundle manifest is not valid JSON`, { cause: error });
  }
  if (
    parsedManifest === null ||
    typeof parsedManifest !== 'object' ||
    Array.isArray(parsedManifest)
  ) {
    throw new Error(`${config.packageName} bundle manifest must be a JSON object`);
  }
  const manifest = parsedManifest as NpmExtensionBundleManifest;
  if (manifest.schema === 'oliphaunt-extension-bundle-v1') {
    throw new Error(
      `${config.packageName} bundle manifest uses the physical carrier schema; expected oliphaunt-npm-extension-bundle-v1`,
    );
  }
  if (manifest.schema !== 'oliphaunt-npm-extension-bundle-v1') {
    throw new Error(`${config.packageName} bundle manifest has unsupported schema`);
  }
  const manifestFields = Object.keys(manifest).sort();
  const expectedManifestFields = ['family', 'members', 'product', 'schema', 'target', 'version'];
  if (JSON.stringify(manifestFields) !== JSON.stringify(expectedManifestFields)) {
    throw new Error(
      `${config.packageName} npm bundle manifest fields must be exactly ${expectedManifestFields.join(', ')}`,
    );
  }
  if (manifest.product !== config.extension.releaseProduct) {
    throw new Error(
      `${config.packageName} bundle manifest does not declare ${config.extension.releaseProduct}`,
    );
  }
  if (manifest.version !== config.packageJson.version) {
    throw new Error(
      `${config.packageName} bundle manifest version ${manifest.version ?? '<missing>'} does not match package version ${config.packageJson.version ?? '<missing>'}`,
    );
  }
  if (manifest.family !== 'native' || manifest.target !== config.target) {
    throw new Error(
      `${config.packageName} bundle manifest must declare native target ${config.target}`,
    );
  }
  if (!Array.isArray(manifest.members)) {
    throw new Error(`${config.packageName} bundle manifest is missing members`);
  }
  const expectedRuntimeRelativePaths = Object.fromEntries(
    config.expectedMembers.map((sqlName) => [sqlName, `extensions/${sqlName}/runtime`]),
  );
  const memberRuntimeRelativePaths = config.packageJson.oliphaunt?.memberRuntimeRelativePaths;
  if (
    memberRuntimeRelativePaths === undefined ||
    memberRuntimeRelativePaths === null ||
    typeof memberRuntimeRelativePaths !== 'object' ||
    Array.isArray(memberRuntimeRelativePaths) ||
    Object.values(memberRuntimeRelativePaths).some(
      (value) => typeof value !== 'string' || value.length === 0,
    ) ||
    JSON.stringify(Object.keys(memberRuntimeRelativePaths).sort()) !==
      JSON.stringify([...config.expectedMembers].sort()) ||
    JSON.stringify(memberRuntimeRelativePaths) !== JSON.stringify(expectedRuntimeRelativePaths)
  ) {
    throw new Error(
      `${config.packageName} bundle target must declare one runtime path for every exact member`,
    );
  }
  const rawMemberModuleRelativePaths = config.packageJson.oliphaunt?.memberModuleRelativePaths;
  const expectedMemberModuleRelativePaths = Object.fromEntries(
    config.expectedMembers.flatMap((sqlName) =>
      config.memberContracts.get(sqlName)?.nativeModuleStem === null
        ? []
        : [[sqlName, `extensions/${sqlName}/runtime/lib/modules`]],
    ),
  );
  if (
    rawMemberModuleRelativePaths === undefined
      ? Object.keys(expectedMemberModuleRelativePaths).length !== 0
      : rawMemberModuleRelativePaths === null ||
        typeof rawMemberModuleRelativePaths !== 'object' ||
        Array.isArray(rawMemberModuleRelativePaths) ||
        Object.values(rawMemberModuleRelativePaths).some(
          (value) => typeof value !== 'string' || value.length === 0,
        ) ||
        JSON.stringify(rawMemberModuleRelativePaths) !==
          JSON.stringify(expectedMemberModuleRelativePaths)
  ) {
    throw new Error(`${config.packageName} bundle target has invalid member module paths`);
  }
  const memberModuleRelativePaths = rawMemberModuleRelativePaths ?? {};
  const validatedMembers: NpmExtensionRuntimeBundleMember[] = [];
  const canonicalMembers = new Set<string>();
  const memberPaths = new Set<string>();
  const memberArchivePaths = new Map<string, string>();
  for (const [index, rawMember] of manifest.members.entries()) {
    if (rawMember === null || typeof rawMember !== 'object' || Array.isArray(rawMember)) {
      throw new Error(`${config.packageName} bundle manifest members[${index}] must be an object`);
    }
    const member = rawMember as Record<string, unknown>;
    if (typeof member.sqlName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(member.sqlName)) {
      throw new Error(
        `${config.packageName} bundle manifest members[${index}] has invalid sqlName`,
      );
    }
    if (member.kind !== 'runtime') {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} must declare kind=runtime`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(member, 'identity') || member.identity !== null) {
      throw new Error(
        `${config.packageName} bundle manifest runtime member ${member.sqlName} must declare identity=null`,
      );
    }
    if (
      typeof member.path !== 'string' ||
      !new RegExp(
        `^extensions/${member.sqlName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:tar\\.gz|tgz)$`,
      ).test(member.path) ||
      member.path !== member.path.normalize('NFC') ||
      decodeURIComponent(member.path) !== member.path
    ) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} has invalid archive path`,
      );
    }
    const archive = resolvePackageRelativePath(
      config.packageRoot,
      member.path,
      `${config.packageName} bundle member ${member.sqlName}`,
    );
    await requireFile(archive, `${config.packageName} bundle member ${member.sqlName}`);
    if (typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.sha256)) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} has invalid sha256`,
      );
    }
    if (
      typeof member.bytes !== 'number' ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes <= 0
    ) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} has invalid bytes`,
      );
    }
    const archiveIdentity = await fileSha256AndBytes(archive);
    if (archiveIdentity.bytes !== member.bytes || archiveIdentity.sha256 !== member.sha256) {
      throw new Error(
        `${config.packageName} bundle member ${member.sqlName} does not match its exact bytes and sha256`,
      );
    }
    if (
      typeof member.runtimeRelativePath !== 'string' ||
      member.runtimeRelativePath.length === 0 ||
      member.runtimeRelativePath !== memberRuntimeRelativePaths[member.sqlName] ||
      member.runtimeRelativePath !== `extensions/${member.sqlName}/runtime`
    ) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} runtime path disagrees with package metadata`,
      );
    }
    const runtimeDirectory = resolvePackageRelativePath(
      config.packageRoot,
      member.runtimeRelativePath,
      `${config.packageName} bundle member ${member.sqlName} runtime directory metadata`,
    );
    await requireDirectory(
      runtimeDirectory,
      `${config.packageName} bundle member ${member.sqlName} runtime directory`,
    );
    const memberContract = config.memberContracts.get(member.sqlName);
    if (memberContract === undefined) {
      throw new Error(
        `${config.packageName} bundle member ${member.sqlName} has no frozen package contract`,
      );
    }
    await requireExactExtensionRuntimeInventory({
      contract: memberContract,
      runtimeDirectory,
      target: config.target,
      source: `${config.packageName} bundle member ${member.sqlName} runtime directory`,
    });
    if (
      member.moduleRelativePath !== undefined &&
      (typeof member.moduleRelativePath !== 'string' || member.moduleRelativePath.length === 0)
    ) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} has invalid moduleRelativePath`,
      );
    }
    if (member.moduleRelativePath !== memberModuleRelativePaths[member.sqlName]) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} module path disagrees with package metadata`,
      );
    }
    const expectedModuleRelativePath =
      memberContract.nativeModuleStem === null
        ? undefined
        : `extensions/${member.sqlName}/runtime/lib/modules`;
    if (member.moduleRelativePath !== expectedModuleRelativePath) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} module path is not canonical`,
      );
    }
    if (member.moduleRelativePath !== undefined) {
      const moduleDirectory = resolvePackageRelativePath(
        config.packageRoot,
        member.moduleRelativePath,
        `${config.packageName} bundle member ${member.sqlName} module directory metadata`,
      );
      await requireDirectory(
        moduleDirectory,
        `${config.packageName} bundle member ${member.sqlName} module directory`,
      );
    }
    const expectedMemberFields = [
      'bytes',
      'identity',
      'kind',
      ...(member.moduleRelativePath === undefined ? [] : ['moduleRelativePath']),
      'path',
      'runtimeRelativePath',
      'sha256',
      'sqlName',
    ].sort();
    if (JSON.stringify(Object.keys(member).sort()) !== JSON.stringify(expectedMemberFields)) {
      throw new Error(
        `${config.packageName} bundle manifest member ${member.sqlName} has unexpected or missing fields`,
      );
    }
    const canonicalMember = `${member.sqlName}\u0000${member.kind}\u0000${member.path}`;
    if (canonicalMembers.has(canonicalMember) || memberPaths.has(member.path)) {
      throw new Error(
        `${config.packageName} bundle manifest repeats a canonical member or archive path`,
      );
    }
    canonicalMembers.add(canonicalMember);
    memberPaths.add(member.path);
    memberArchivePaths.set(member.sqlName, archive);
    validatedMembers.push({
      sqlName: member.sqlName,
      kind: 'runtime',
      identity: null,
      path: member.path,
      sha256: member.sha256,
      bytes: member.bytes,
      runtimeRelativePath: member.runtimeRelativePath,
      ...(member.moduleRelativePath === undefined
        ? {}
        : { moduleRelativePath: member.moduleRelativePath }),
    });
  }
  const sqlNames = validatedMembers.map((member) => member.sqlName);
  if (JSON.stringify(sqlNames) !== JSON.stringify(config.expectedMembers)) {
    throw new Error(
      `${config.packageName} bundle manifest members must exactly match ${config.expectedMembers.join(', ')}`,
    );
  }
  const member = validatedMembers.find(
    (candidate) => candidate.sqlName === config.extension.sqlName,
  );
  if (member === undefined) {
    throw new Error(
      `${config.packageName} bundle manifest is missing selected member ${config.extension.sqlName}`,
    );
  }
  const archive = memberArchivePaths.get(config.extension.sqlName);
  if (archive === undefined) {
    throw new Error(
      `${config.packageName} bundle manifest did not resolve selected member ${config.extension.sqlName}`,
    );
  }

  const runtimeRelativePath = member.runtimeRelativePath;
  const runtimeDirectory = resolvePackageRelativePath(
    config.packageRoot,
    runtimeRelativePath,
    `${config.packageName} bundle member ${config.extension.sqlName} runtime directory metadata`,
  );
  const moduleRelativePath = member.moduleRelativePath;
  const moduleDirectory =
    moduleRelativePath === undefined
      ? undefined
      : resolvePackageRelativePath(
          config.packageRoot,
          moduleRelativePath,
          `${config.packageName} bundle member ${config.extension.sqlName} module directory metadata`,
        );
  return { runtimeDirectory, moduleDirectory };
}

function extensionRuntimeSqlFileOwned(
  extension: NpmExtensionMemberContract,
  fileName: string,
): boolean {
  return (
    (extension.createsExtension && fileName === `${extension.sqlName}.control`) ||
    (extension.createsExtension && fileName === `${extension.sqlName}.sql`) ||
    (extension.createsExtension &&
      fileName.startsWith(`${extension.sqlName}--`) &&
      fileName.endsWith('.sql')) ||
    extension.extensionSqlFileNames.includes(fileName) ||
    (fileName.endsWith('.sql') &&
      extension.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix)))
  );
}

function isCanonicalExtensionInstallSql(fileName: string, sqlName: string): boolean {
  if (fileName === `${sqlName}.sql`) return true;
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.sql')) return false;
  const version = fileName.slice(prefix.length, -'.sql'.length);
  return /^[0-9][A-Za-z0-9._-]*$/u.test(version) && !version.includes('--');
}

async function exactRuntimeLeafPaths(root: string, source: string): Promise<string[]> {
  const rows: string[] = [];
  const collisionPaths = new Map<string, string>();
  let totalBytes = 0;
  const visit = async (current: string, relativePath: string): Promise<void> => {
    if (relativePath !== '') {
      if (
        relativePath.includes('\\') ||
        relativePath !== relativePath.normalize('NFC') ||
        /[\u0000-\u001f\u007f]/u.test(relativePath)
      ) {
        throw new Error(`${source} contains a noncanonical runtime path ${relativePath}`);
      }
      const collisionKey = relativePath.toLowerCase();
      const collision = collisionPaths.get(collisionKey);
      if (collision !== undefined && collision !== relativePath) {
        throw new Error(
          `${source} contains case/NFC-colliding paths ${collision} and ${relativePath}`,
        );
      }
      collisionPaths.set(collisionKey, relativePath);
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${source} contains symbolic link ${relativePath || '.'}`);
    }
    if (metadata.isDirectory()) {
      const entries = (await readdir(current)).sort();
      for (const entry of entries) {
        await visit(join(current, entry), relativePath === '' ? entry : `${relativePath}/${entry}`);
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(`${source} contains unsupported filesystem entry ${relativePath}`);
    }
    if (metadata.size > MAX_EXTENSION_RUNTIME_FILE_BYTES) {
      throw new Error(`${source} runtime file ${relativePath} exceeds the bounded member size`);
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_EXTENSION_RUNTIME_BYTES) {
      throw new Error(`${source} exceeds the bounded expanded runtime size`);
    }
    rows.push(relativePath);
    if (rows.length > MAX_EXTENSION_RUNTIME_FILES) {
      throw new Error(`${source} contains too many runtime files`);
    }
  };
  await visit(root, '');
  return rows;
}

async function requireExactExtensionRuntimeInventory(config: {
  contract: NpmExtensionMemberContract;
  runtimeDirectory: string;
  target: string;
  source: string;
}): Promise<void> {
  const files = await exactRuntimeLeafPaths(config.runtimeDirectory, config.source);
  const dataFiles = new Set(config.contract.dataFiles.map((file) => `share/postgresql/${file}`));
  const moduleFile =
    config.contract.nativeModuleStem === null
      ? undefined
      : `lib/postgresql/${config.contract.nativeModuleStem}${nativeModuleSuffixForTarget(config.target)}`;
  const embeddedModuleFile =
    config.contract.nativeModuleStem === null
      ? undefined
      : `lib/modules/${config.contract.nativeModuleStem}${nativeModuleSuffixForTarget(config.target)}`;
  let hasControl = false;
  let hasSql = false;
  for (const file of files) {
    const extensionPrefix = 'share/postgresql/extension/';
    if (file.startsWith(extensionPrefix)) {
      const fileName = file.slice(extensionPrefix.length);
      if (fileName.includes('/') || !extensionRuntimeSqlFileOwned(config.contract, fileName)) {
        throw new Error(`${config.source} contains undeclared extension SQL/control file ${file}`);
      }
      if (fileName === `${config.contract.sqlName}.control`) hasControl = true;
      if (isCanonicalExtensionInstallSql(fileName, config.contract.sqlName)) hasSql = true;
      continue;
    }
    if (dataFiles.has(file) || file === moduleFile || file === embeddedModuleFile) continue;
    throw new Error(`${config.source} contains undeclared runtime file ${file}`);
  }
  const missingDataFiles = [...dataFiles].filter((file) => !files.includes(file));
  if (missingDataFiles.length > 0) {
    throw new Error(
      `${config.source} is missing declared data file(s): ${missingDataFiles.join(', ')}`,
    );
  }
  if (moduleFile !== undefined && !files.includes(moduleFile)) {
    throw new Error(`${config.source} is missing declared native module ${moduleFile}`);
  }
  if (embeddedModuleFile !== undefined && !files.includes(embeddedModuleFile)) {
    throw new Error(`${config.source} is missing declared embedded native module ${embeddedModuleFile}`);
  }
  if (config.contract.createsExtension && (!hasControl || !hasSql)) {
    throw new Error(
      `${config.source} must contain ${config.contract.sqlName}.control and canonical base installation SQL`,
    );
  }
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
  return {
    libraryPath,
    runtimeDirectory: mergedRuntimeDirectory,
    icuDataDirectory,
    packageManaged: true,
  };
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

  await publishRuntimeCache(root, manifest, async (stageRoot) => {
    const stageRuntimeDirectory = join(stageRoot, 'runtime');
    await cp(config.runtimePackage.runtimeDirectory, stageRuntimeDirectory, { recursive: true });
    await cp(config.toolsPackage.runtimeDirectory, stageRuntimeDirectory, {
      force: true,
      recursive: true,
    });
  });
  return runtimeDirectory;
}

async function publishRuntimeCache(
  root: string,
  manifest: string,
  build: (stageRoot: string) => Promise<void>,
): Promise<void> {
  const marker = join(root, 'manifest.json');
  if ((await optionalRead(marker)) === manifest) {
    return;
  }
  await mkdir(dirname(root), { recursive: true });
  await withRuntimeCacheLock(root, async () => {
    if ((await optionalRead(marker)) === manifest) {
      return;
    }
    const unique = `${process.pid}-${randomUUID()}`;
    const stageRoot = `${root}.build-${unique}`;
    const oldRoot = `${root}.old-${unique}`;
    await rm(stageRoot, { force: true, recursive: true });
    await rm(oldRoot, { force: true, recursive: true });
    let movedExistingRoot = false;
    try {
      await mkdir(stageRoot, { recursive: true });
      await build(stageRoot);
      await writeFile(join(stageRoot, 'manifest.json'), manifest, 'utf8');
      try {
        await rename(root, oldRoot);
        movedExistingRoot = true;
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) {
          throw error;
        }
      }
      try {
        await rename(stageRoot, root);
      } catch (error) {
        if (movedExistingRoot) {
          await rename(oldRoot, root).catch(() => undefined);
          movedExistingRoot = false;
        }
        throw error;
      }
      if (movedExistingRoot) {
        await rm(oldRoot, { force: true, recursive: true }).catch(() => undefined);
      }
    } catch (error) {
      await rm(stageRoot, { force: true, recursive: true });
      await rm(oldRoot, { force: true, recursive: true });
      throw error;
    }
  });
}

async function withRuntimeCacheLock<T>(root: string, callback: () => Promise<T>): Promise<T> {
  const lock = `${root}.lock`;
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
      if (await runtimeCacheLockIsStale(lock)) {
        await rm(lock, { force: true, recursive: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Oliphaunt runtime cache lock: ${lock}`);
      }
      await delay(CACHE_LOCK_POLL_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lock, { force: true, recursive: true });
  }
}

async function runtimeCacheLockIsStale(lock: string): Promise<boolean> {
  try {
    const metadata = await stat(lock);
    return Date.now() - metadata.mtimeMs > CACHE_LOCK_STALE_MS;
  } catch {
    return true;
  }
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
  extension: GeneratedExtensionMetadata,
  targetPackageName: string,
  target: string,
): Promise<{ packageJsonPath: string; ownerVersion: string }> {
  const packageName = extension.npmPackage;
  const expectedMembers = extensionOwnerMembers(extension);
  const isBundle = expectedMembers.length > 1;
  const packageJsonPath = optionalResolvePackageJson(packageName);
  if (packageJsonPath === undefined) {
    if (isBundle) {
      throw new Error(
        `${packageName} is not installed; add it to the application dependencies for CREATE EXTENSION support`,
      );
    }
    const targetPath = resolveExtensionPackageJson(targetPackageName, packageName);
    const targetMetadata = JSON.parse(
      await readFile(targetPath, 'utf8'),
    ) as ExtensionPackageMetadata;
    if (typeof targetMetadata.version !== 'string' || targetMetadata.version.length === 0) {
      throw new Error(`${targetPackageName} package metadata is missing version`);
    }
    return { packageJsonPath: targetPath, ownerVersion: targetMetadata.version };
  }

  const packageJson = JSON.parse(
    await readFile(packageJsonPath, 'utf8'),
  ) as ExtensionPackageMetadata;
  if (packageJson.name !== packageName) {
    throw new Error(`${packageName} package metadata has name ${packageJson.name ?? '<missing>'}`);
  }
  const expectedKind = isBundle ? 'exact-extension-bundle' : 'exact-extension';
  if (packageJson.oliphaunt?.kind !== expectedKind) {
    throw new Error(`${packageName} package metadata does not declare ${expectedKind}`);
  }
  if (packageJson.oliphaunt?.product !== extension.releaseProduct) {
    throw new Error(`${packageName} package metadata does not declare ${extension.releaseProduct}`);
  }
  requireExtensionPackageMembers(packageJson, expectedMembers, packageName);
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`${packageName} package metadata is missing version`);
  }
  const resolvedTargetPackageName =
    packageJson.oliphaunt.targetPackageNames?.[target] ?? targetPackageName;
  if (resolvedTargetPackageName !== targetPackageName) {
    throw new Error(
      `${packageName} target package for ${target} must be ${targetPackageName}, got ${resolvedTargetPackageName}`,
    );
  }
  try {
    return {
      packageJsonPath: createRequire(packageJsonPath).resolve(
        `${resolvedTargetPackageName}/package.json`,
      ),
      ownerVersion: packageJson.version,
    };
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
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      return;
    }
  } catch {}
  throw new Error(`${source} does not point to an existing file: ${path}`);
}

async function fileSha256AndBytes(path: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    digest.update(buffer);
  }
  return { sha256: digest.digest('hex'), bytes };
}

async function requireDirectory(path: string, source: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function extensionTargetPackageName(extension: GeneratedExtensionMetadata, target: string): string {
  return `${extension.npmPackage}-${target}`;
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

function runtimeCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

const nodeRuntimeFileHost: RuntimeFileHost = {
  join,
  async readDir(path: string) {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    }));
  },
  async isDirectory(path: string) {
    return isDirectory(path);
  },
  async isFile(path: string) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};
