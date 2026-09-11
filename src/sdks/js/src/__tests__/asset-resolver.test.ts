import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { GENERATED_EXTENSION_METADATA } from '../generated/extensions.js';
import { resolvePackageRelativeUrl } from '../native/assets-deno.js';
import {
  materializeNodeExtensionInstall,
  prepareNodeExtensionInstall,
  type ResolvedNativeInstall,
  resolveNodeNativeInstall,
  resolvePackageRelativePath,
  validatePreparedNodeRuntimeExtensions,
} from '../native/assets-node.js';
import { liboliphauntPackageTarget } from '../native/common.js';
import {
  packageMetadataVersion,
  readTypeScriptPackageJson,
  readTypeScriptPackageVersions,
} from './package-metadata.js';

type FixtureExtensionContract = {
  sqlName: string;
  createsExtension: boolean;
  nativeModuleStem: string | null;
  dependencies: string[];
  dataFiles: string[];
  extensionSqlFileNames: string[];
  extensionSqlFilePrefixes: string[];
  licenseFiles: FixtureExtensionLicenseFile[];
  sharedPreloadLibraries: string[];
};

type FixtureExtensionLicenseFile = {
  [key: string]: unknown;
  path: string;
  sha256: string;
  mode: string;
};

function fixtureExtensionLicenseFile(
  path: string,
  contents: string | Uint8Array,
): FixtureExtensionLicenseFile {
  return {
    path,
    sha256: createHash('sha256').update(contents).digest('hex'),
    mode: '0644',
  };
}

function fixtureExtensionContract(
  extension: (typeof GENERATED_EXTENSION_METADATA)[number],
  overrides: Partial<FixtureExtensionContract> = {},
): FixtureExtensionContract {
  return {
    sqlName: extension.sqlName,
    createsExtension: extension.createsExtension,
    nativeModuleStem: extension.nativeModuleStem,
    dependencies: [...extension.selectedExtensionDependencies],
    dataFiles: [...extension.runtimeShareDataFiles],
    extensionSqlFileNames: [...extension.extensionSqlFileNames],
    extensionSqlFilePrefixes: [...extension.extensionSqlFilePrefixes],
    licenseFiles: [],
    sharedPreloadLibraries: [...extension.sharedPreloadLibraries],
    ...overrides,
  };
}

function fixtureExtensionContractManifest(
  product: string,
  version: string,
  target: string,
  members: FixtureExtensionContract[],
): object {
  return {
    schema: 'oliphaunt-npm-extension-contract-v1',
    product,
    version,
    family: 'native',
    target,
    members,
  };
}

async function main(): Promise<void> {
  packageTargetsMatchLiboliphauntPackages();
  packageMetadataPathsAreConfinedToPackageRoot();
  await nodeResolverUsesInstalledPackages();
  await nodeResolverUsesStandardCarrierRuntime();
  await nodeIcuResolverAcceptsValidPortablePackage();
  await nodeExtensionMaterializationValidatesSelections();
  await nodeExtensionMaterializationAcceptsBuiltInPostgresDependency();
  await explicitRuntimeExtensionValidationUsesPreparedFiles();
  await nodeExtensionMaterializationCopiesPackagePayloads();
  await nodeExtensionMaterializationRejectsIncompletePackagePayloads();
  await typeScriptPackageMetadataMatchesRuntimePackages();
}

function packageTargetsMatchLiboliphauntPackages(): void {
  const target = liboliphauntPackageTarget('darwin', 'aarch64');
  assert.equal(target.id, 'macos-arm64');
  assert.equal(target.packageName, '@oliphaunt/liboliphaunt-darwin-arm64');
  assert.equal(target.libraryRelativePath, 'lib/liboliphaunt.dylib');
  assert.equal(target.runtimeRelativePath, 'runtime');
  const linuxTarget = liboliphauntPackageTarget('linux', 'x64');
  assert.equal(linuxTarget.id, 'linux-x64-gnu');
  assert.equal(linuxTarget.packageName, '@oliphaunt/liboliphaunt-linux-x64-gnu');
  assert.equal(linuxTarget.libraryRelativePath, 'lib/liboliphaunt.so');
  assert.equal(linuxTarget.runtimeRelativePath, 'runtime');
  const linuxArmTarget = liboliphauntPackageTarget('linux', 'arm64');
  assert.equal(linuxArmTarget.id, 'linux-arm64-gnu');
  assert.equal(linuxArmTarget.packageName, '@oliphaunt/liboliphaunt-linux-arm64-gnu');
  assert.equal(linuxArmTarget.libraryRelativePath, 'lib/liboliphaunt.so');
  assert.equal(linuxArmTarget.runtimeRelativePath, 'runtime');
  const windowsTarget = liboliphauntPackageTarget('win32', 'x64');
  assert.equal(windowsTarget.id, 'windows-x64-msvc');
  assert.equal(windowsTarget.packageName, '@oliphaunt/liboliphaunt-win32-x64-msvc');
  assert.equal(windowsTarget.libraryRelativePath, 'bin/oliphaunt.dll');
  assert.equal(windowsTarget.runtimeRelativePath, 'runtime');
}

function packageMetadataPathsAreConfinedToPackageRoot(): void {
  const packageRoot = resolve('/tmp/oliphaunt-package-root');
  assert.equal(
    resolvePackageRelativePath(packageRoot, 'runtime/bin/postgres', 'test package metadata'),
    join(packageRoot, 'runtime/bin/postgres'),
  );
  const packageRootUrl = new URL('file:///tmp/oliphaunt-package-root/');
  assert.equal(
    resolvePackageRelativeUrl(packageRootUrl, 'runtime/bin/postgres', 'test package metadata').href,
    'file:///tmp/oliphaunt-package-root/runtime/bin/postgres',
  );
  for (const unsafePath of [
    '',
    '../outside',
    'runtime/../outside',
    'runtime/%2e%2e/outside',
    '/tmp/outside',
    'file:///tmp/outside',
    'https://example.invalid/runtime',
    'C:\\outside',
    'runtime\0outside',
  ]) {
    assert.throws(
      () => resolvePackageRelativePath(packageRoot, unsafePath, 'test package metadata'),
      /unsafe package metadata path/,
      unsafePath,
    );
    assert.throws(
      () => resolvePackageRelativeUrl(packageRootUrl, unsafePath, 'test package metadata'),
      /unsafe package metadata path/,
      unsafePath,
    );
  }
}

async function nodeResolverUsesInstalledPackages(): Promise<void> {
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  delete process.env.LIBOLIPHAUNT_PATH;
  delete process.env.OLIPHAUNT_RUNTIME_DIR;
  try {
    await assert.rejects(() => resolveNodeNativeInstall(), /@oliphaunt\/liboliphaunt-/);
  } finally {
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
  }
}

async function nodeResolverUsesStandardCarrierRuntime(): Promise<void> {
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  delete process.env.LIBOLIPHAUNT_PATH;
  delete process.env.OLIPHAUNT_RUNTIME_DIR;

  const target = liboliphauntPackageTarget(platform(), arch());
  const runtimePackageRoot = packageRoot(target.packageName);
  const createdFiles: string[] = [];
  try {
    await writeFixtureFile(
      join(runtimePackageRoot, target.libraryRelativePath),
      'liboliphaunt-test',
      createdFiles,
    );
    const runtimeBin = join(runtimePackageRoot, target.runtimeRelativePath, 'bin');
    for (const tool of nativeRuntimeToolsForTarget(target.id)) {
      await writeFixtureFile(join(runtimeBin, tool), `runtime:${tool}`, createdFiles);
    }
    await writeClusterSeedFixture(
      join(runtimePackageRoot, 'cluster-seed'),
      'standard',
      target.id,
      createdFiles,
    );
    const install = await resolveNodeNativeInstall();
    assert.equal(install.libraryPath, join(runtimePackageRoot, target.libraryRelativePath));
    assert.equal(install.runtimeDirectory, join(runtimePackageRoot, target.runtimeRelativePath));
    assert.equal(install.icuDataDirectory, undefined);
    assert.equal(install.clusterSeedDirectory, join(runtimePackageRoot, 'cluster-seed'));
    assert.equal(install.catalogProfile, 'standard');
  } finally {
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
    await removeFixtureFiles(createdFiles, [runtimePackageRoot]);
  }
}

async function nodeIcuResolverAcceptsValidPortablePackage(): Promise<void> {
  const { icuVersion } = await readTypeScriptPackageVersions();
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-icu-'));
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@oliphaunt/icu',
        version: icuVersion,
        oliphaunt: {
          product: 'oliphaunt-icu',
          kind: 'icu-data',
          target: 'portable',
          dataRelativePath: 'OliphauntICU.bundle/share/icu',
          manifestRelativePath: 'OliphauntICU.bundle/manifest.properties',
          icuDataTreeSha256: 'a'.repeat(64),
        },
      }),
      'utf8',
    );
    const dataDirectory = join(root, 'OliphauntICU.bundle/share/icu');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, 'icudt76l.dat'), 'icu');
    await writeFile(
      join(root, 'OliphauntICU.bundle/manifest.properties'),
      `schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256=${'a'.repeat(64)}\n`,
      'utf8',
    );
    const descriptor = {
      schema: 'oliphaunt-native-icu-v1' as const,
      packageName: '@oliphaunt/icu' as const,
      version: icuVersion,
      packageJsonUrl: pathToFileURL(join(root, 'package.json')).href,
    };
    const install = await resolveNodeNativeInstall('/explicit/liboliphaunt.so', descriptor);
    assert.equal(install.icuDataDirectory, await realpath(dataDirectory));
    assert.equal(install.catalogProfile, 'icu');
    await assert.rejects(
      () =>
        resolveNodeNativeInstall('/explicit/liboliphaunt.so', { ...descriptor, version: '9.9.8' }),
      /ICU package .* is incompatible with runtime/,
    );
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...metadata, version: '9.9.8' }));
    await assert.rejects(
      () => resolveNodeNativeInstall('/explicit/liboliphaunt.so', descriptor),
      /does not match @oliphaunt\/ts icuVersion/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function nodeExtensionMaterializationValidatesSelections(): Promise<void> {
  const install: ResolvedNativeInstall = {
    libraryPath: '/tmp/liboliphaunt-test.so',
  };
  assert.equal(await materializeNodeExtensionInstall(install, []), install);
  await assert.rejects(
    () => materializeNodeExtensionInstall(install, ['not_a_real_extension']),
    /unknown Oliphaunt extension id/,
  );
  await assert.rejects(
    () => materializeNodeExtensionInstall(install, ['hstore']),
    /native extension packages require a package-managed runtime directory/,
  );
}

async function nodeExtensionMaterializationAcceptsBuiltInPostgresDependency(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const { liboliphauntVersion } = await readTypeScriptPackageVersions();
  const extensionVersion = '9.9.8';
  const basePackageName = '@oliphaunt/extension-pgtap';
  const targetPackageName = `${basePackageName}-${target.id}`;
  const product = 'oliphaunt-extension-pgtap';
  const pgtap = GENERATED_EXTENSION_METADATA.find((candidate) => candidate.sqlName === 'pgtap');
  if (pgtap === undefined) assert.fail('missing generated pgtap metadata');
  assert.deepEqual(pgtap.dependencies, ['plpgsql']);
  assert.deepEqual(pgtap.selectedExtensionDependencies, []);
  const contract = fixtureExtensionContract(pgtap);
  const createdPackageRoots: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-extension-built-in-dependency-'));
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  const installRuntime = join(root, 'runtime');
  let installedRuntime: string | undefined;
  try {
    await writeFixturePackage(basePackageName, createdPackageRoots, {
      name: basePackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension',
        sqlName: 'pgtap',
        targetPackageNames: { [target.id]: targetPackageName },
      },
    });
    const targetRoot = await writeFixturePackage(targetPackageName, createdPackageRoots, {
      name: targetPackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension-target',
        sqlName: 'pgtap',
        target: target.id,
        liboliphauntVersion,
        extensionContract: 'extension-contract.json',
        runtimeRelativePath: 'runtime',
      },
    });
    const contractPath = join(targetRoot, 'extension-contract.json');
    await writeFile(
      contractPath,
      JSON.stringify(
        fixtureExtensionContractManifest(product, extensionVersion, target.id, [contract]),
      ),
    );
    const extensionDirectory = join(targetRoot, 'runtime/share/postgresql/extension');
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(extensionDirectory, 'pgtap.control'), 'extension');
    await writeFile(join(extensionDirectory, 'pgtap--1.3.5.sql'), 'install');
    await writeFile(join(extensionDirectory, 'uninstall_pgtap.sql'), 'owned exact SQL');
    await writeFile(join(extensionDirectory, 'pgtap-core--1.3.5.sql'), 'owned prefixed SQL');
    await mkdir(installRuntime, { recursive: true });

    const installed = await materializeNodeExtensionInstall(
      { libraryPath, runtimeDirectory: installRuntime },
      ['pgtap'],
    );
    installedRuntime = installed.runtimeDirectory;
    if (installedRuntime === undefined) {
      assert.fail('pgtap should materialize with its built-in plpgsql dependency omitted');
    }
    assert.equal(
      await readFile(join(installedRuntime, 'share/postgresql/extension/pgtap--1.3.5.sql'), 'utf8'),
      'install',
    );

    await writeFile(
      contractPath,
      JSON.stringify(
        fixtureExtensionContractManifest(product, extensionVersion, target.id, [
          { ...contract, dependencies: ['plpgsql'] },
        ]),
      ),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'pgtap',
        ]),
      /member pgtap is incompatible with the SDK dependency contract/,
    );
  } finally {
    if (installedRuntime !== undefined) {
      await rm(dirname(installedRuntime), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
    for (const packageRoot of createdPackageRoots.reverse()) {
      await rm(packageRoot, { recursive: true, force: true });
    }
    await removeEmptyParents(nativeResolverPackageScopeRoot(), [
      dirname(nativeResolverPackageScopeRoot()),
    ]);
  }
}

async function explicitRuntimeExtensionValidationUsesPreparedFiles(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-explicit-runtime-'));
  const directRuntime = join(root, 'runtime');
  const releaseRoot = join(root, 'release-shaped');
  const releaseRuntime = join(releaseRoot, 'oliphaunt/runtime/files');
  const invalidRuntime = join(root, 'invalid-runtime');
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  try {
    await writePreparedHstoreRuntime(directRuntime, target.id);
    await writePreparedHstoreRuntime(releaseRuntime, target.id);
    await mkdir(join(invalidRuntime, 'share/postgresql/extension'), {
      recursive: true,
    });
    await mkdir(join(invalidRuntime, 'lib/postgresql'), { recursive: true });

    const direct = await validatePreparedNodeRuntimeExtensions(
      { libraryPath, runtimeDirectory: directRuntime },
      ['hstore'],
    );
    assert.equal(direct.runtimeDirectory, directRuntime);
    assert.equal(direct.moduleDirectory, join(directRuntime, 'lib/modules'));

    const releaseShaped = await prepareNodeExtensionInstall(
      { libraryPath, runtimeDirectory: releaseRoot },
      ['hstore'],
      { explicitRuntimeDirectory: true },
    );
    assert.equal(releaseShaped.runtimeDirectory, releaseRuntime);
    assert.equal(releaseShaped.moduleDirectory, join(releaseRuntime, 'lib/modules'));

    await assert.rejects(
      () =>
        validatePreparedNodeRuntimeExtensions({ libraryPath, runtimeDirectory: invalidRuntime }, [
          'hstore',
        ]),
      /explicit native runtimeDirectory is missing hstore.control/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function nodeExtensionMaterializationCopiesPackagePayloads(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const { liboliphauntVersion } = await readTypeScriptPackageVersions();
  const extensionVersion = liboliphauntVersion;
  const basePackageName = '@oliphaunt/extension-contrib-pg18';
  const targetPackageName = `${basePackageName}-${target.id}`;
  const product = 'oliphaunt-extension-contrib-pg18';
  const createdPackageRoots: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-extension-install-'));
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  const installRuntime = join(root, 'runtime');
  let firstInstall: ResolvedNativeInstall | undefined;
  try {
    const members = contribBundleMembers();
    const memberContracts = members.map((sqlName) => {
      const extension = GENERATED_EXTENSION_METADATA.find(
        (candidate) => candidate.sqlName === sqlName,
      );
      if (extension === undefined)
        assert.fail(`missing generated extension metadata for ${sqlName}`);
      return fixtureExtensionContract(
        extension,
        sqlName === 'hstore'
          ? {
              dataFiles: ['oliphaunt-skew/frozen.dat'],
              extensionSqlFileNames: ['hstore_legacy.sql'],
            }
          : {},
      );
    });
    const memberContractsBySqlName = new Map(
      memberContracts.map((contract) => [contract.sqlName, contract]),
    );
    const memberRuntimeRelativePaths: Record<string, string> = {};
    const memberModuleRelativePaths: Record<string, string> = {};
    for (const sqlName of members) {
      const extension = GENERATED_EXTENSION_METADATA.find(
        (candidate) => candidate.sqlName === sqlName,
      );
      if (extension === undefined) {
        assert.fail(`missing generated extension metadata for ${sqlName}`);
      }
      memberRuntimeRelativePaths[sqlName] = `extensions/${sqlName}/runtime`;
      if (extension.nativeModuleStem !== null) {
        memberModuleRelativePaths[sqlName] = `extensions/${sqlName}/runtime/lib/modules`;
      }
    }
    await writeFixturePackage(basePackageName, createdPackageRoots, {
      name: basePackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension-bundle',
        members,
        liboliphauntVersion,
        targetPackageNames: { [target.id]: targetPackageName },
      },
    });
    const targetPackageJson = {
      name: targetPackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension-bundle-target',
        members,
        target: target.id,
        liboliphauntVersion,
        bundleManifest: 'bundle-manifest.json',
        extensionContract: 'extension-contract.json',
        memberRuntimeRelativePaths,
        memberModuleRelativePaths,
      },
    };
    const targetRoot = await writeFixturePackage(
      targetPackageName,
      createdPackageRoots,
      targetPackageJson,
    );
    const extensionContractManifest = fixtureExtensionContractManifest(
      product,
      extensionVersion,
      target.id,
      memberContracts,
    );
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify(extensionContractManifest),
    );
    const hstoreArchive = Buffer.from('qualified-hstore-inner-archive');
    const hstoreArchivePath = 'extensions/hstore/hstore.tar.gz';
    const bundleManifestMembers = [];
    for (const sqlName of members) {
      const extension = GENERATED_EXTENSION_METADATA.find(
        (candidate) => candidate.sqlName === sqlName,
      );
      if (extension === undefined) {
        assert.fail(`missing generated extension metadata for ${sqlName}`);
      }
      const contract = memberContractsBySqlName.get(sqlName);
      if (contract === undefined) assert.fail(`missing frozen extension contract for ${sqlName}`);
      const archive =
        sqlName === 'hstore' ? hstoreArchive : Buffer.from(`qualified-${sqlName}-inner-archive`);
      const archivePath = `extensions/${sqlName}/${sqlName}.tar.gz`;
      const runtimeRoot = join(targetRoot, `extensions/${sqlName}/runtime`);
      const extensionShare = join(runtimeRoot, 'share/postgresql/extension');
      await mkdir(extensionShare, { recursive: true });
      await writeFile(join(targetRoot, archivePath), archive);
      if (contract.createsExtension) {
        await writeFile(
          join(extensionShare, `${sqlName}.control`),
          sqlName === 'pg_trgm' ? 'must-not-be-staged' : 'extension',
        );
        await writeFile(
          join(extensionShare, `${sqlName}--1.0.sql`),
          sqlName === 'pg_trgm' ? 'must-not-be-staged' : 'install',
        );
      }
      for (const dataFile of contract.dataFiles) {
        const destination = join(runtimeRoot, 'share/postgresql', dataFile);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, `declared-data:${dataFile}`);
      }
      if (sqlName === 'pgtap') {
        await writeFile(join(extensionShare, 'uninstall_pgtap.sql'), 'owned exact SQL');
        await writeFile(join(extensionShare, 'pgtap-core--fixture.sql'), 'owned prefixed SQL');
      }
      for (const fileName of contract.extensionSqlFileNames) {
        if (sqlName !== 'pgtap') {
          await writeFile(join(extensionShare, fileName), `frozen-owned-sql:${fileName}`);
        }
      }
      if (contract.nativeModuleStem !== null) {
        const serverModuleRoot = join(runtimeRoot, 'lib/postgresql');
        const embeddedModuleRoot = join(runtimeRoot, 'lib/modules');
        await mkdir(serverModuleRoot, { recursive: true });
        await mkdir(embeddedModuleRoot, { recursive: true });
        await writeFile(
          join(
            serverModuleRoot,
            `${contract.nativeModuleStem}${nativeModuleSuffixForTarget(target.id)}`,
          ),
          sqlName === 'pg_trgm' ? 'must-not-be-staged' : `server-module:${sqlName}`,
        );
        await writeFile(
          join(
            embeddedModuleRoot,
            `${contract.nativeModuleStem}${nativeModuleSuffixForTarget(target.id)}`,
          ),
          sqlName === 'pg_trgm' ? 'must-not-be-staged' : `embedded-module:${sqlName}`,
        );
      }
      bundleManifestMembers.push({
        sqlName,
        kind: 'runtime',
        identity: null,
        path: archivePath,
        sha256: createHash('sha256').update(archive).digest('hex'),
        bytes: archive.byteLength,
        runtimeRelativePath: memberRuntimeRelativePaths[sqlName],
        ...(memberModuleRelativePaths[sqlName] === undefined
          ? {}
          : { moduleRelativePath: memberModuleRelativePaths[sqlName] }),
      });
    }
    const bundleManifest = {
      schema: 'oliphaunt-npm-extension-bundle-v1',
      product,
      version: extensionVersion,
      family: 'native',
      target: target.id,
      members: bundleManifestMembers,
    };
    await writeFile(join(targetRoot, 'bundle-manifest.json'), JSON.stringify(bundleManifest));
    const nativeModule = `hstore${nativeModuleSuffixForTarget(target.id)}`;
    await mkdir(installRuntime, { recursive: true });
    await mkdir(join(dirname(libraryPath), 'modules'), { recursive: true });
    await writeFile(join(installRuntime, 'base-runtime.txt'), 'base');
    await writeFile(join(dirname(libraryPath), 'modules/base-module.so'), 'base-module');

    firstInstall = await materializeNodeExtensionInstall(
      { libraryPath, runtimeDirectory: installRuntime },
      ['hstore'],
    );
    const runtimeDirectory = firstInstall.runtimeDirectory;
    const moduleDirectory = firstInstall.moduleDirectory;
    if (runtimeDirectory === undefined || moduleDirectory === undefined) {
      assert.fail('extension materialization should return runtime and module cache directories');
    }
    assert.ok(runtimeDirectory.includes('oliphaunt-js-runtime-cache'));
    assert.ok(moduleDirectory.includes('oliphaunt-js-runtime-cache'));
    assert.equal(await readFile(join(runtimeDirectory, 'base-runtime.txt'), 'utf8'), 'base');
    assert.equal(
      await readFile(join(runtimeDirectory, 'share/postgresql/extension/hstore.control'), 'utf8'),
      'extension',
    );
    assert.equal(
      await readFile(join(runtimeDirectory, 'share/postgresql/extension/hstore--1.0.sql'), 'utf8'),
      'install',
    );
    await assert.rejects(
      () => readFile(join(runtimeDirectory, 'share/postgresql/extension/pg_trgm.control')),
      /ENOENT/,
    );
    assert.equal(await readFile(join(moduleDirectory, 'base-module.so'), 'utf8'), 'base-module');
    assert.equal(
      await readFile(join(moduleDirectory, nativeModule), 'utf8'),
      'embedded-module:hstore',
    );
    assert.equal(
      await readFile(join(runtimeDirectory, 'lib/postgresql', nativeModule), 'utf8'),
      'server-module:hstore',
    );
    assert.equal(
      await readFile(join(runtimeDirectory, 'lib/modules', nativeModule), 'utf8'),
      'embedded-module:hstore',
    );
    assert.equal(
      await readFile(join(runtimeDirectory, 'share/postgresql/oliphaunt-skew/frozen.dat'), 'utf8'),
      'declared-data:oliphaunt-skew/frozen.dat',
    );
    assert.equal(
      await readFile(
        join(runtimeDirectory, 'share/postgresql/extension/hstore_legacy.sql'),
        'utf8',
      ),
      'frozen-owned-sql:hstore_legacy.sql',
    );

    const frozenSkewData = join(
      targetRoot,
      'extensions/hstore/runtime/share/postgresql/oliphaunt-skew/frozen.dat',
    );
    const frozenSkewDataBytes = await readFile(frozenSkewData);
    await rm(frozenSkewData);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /missing declared data file\(s\).*oliphaunt-skew\/frozen\.dat/,
    );
    await mkdir(dirname(frozenSkewData), { recursive: true });
    await writeFile(frozenSkewData, frozenSkewDataBytes);

    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify({ ...extensionContractManifest, unexpected: true }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /extension contract fields must be exactly/,
    );
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify({
        ...extensionContractManifest,
        members: memberContracts.map((contract) =>
          contract.sqlName === 'hstore'
            ? Object.fromEntries(
                Object.entries(contract).filter(([key]) => key !== 'extensionSqlFilePrefixes'),
              )
            : contract,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /extension contract members\[.*\] fields must be exactly/,
    );
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify({
        ...extensionContractManifest,
        members: memberContracts.map((contract) =>
          contract.sqlName === 'hstore' ? { ...contract, dependencies: ['cube'] } : contract,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /member hstore is incompatible with the SDK dependency contract/,
    );
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify(extensionContractManifest),
    );

    const cached = await materializeNodeExtensionInstall(
      { libraryPath, runtimeDirectory: installRuntime },
      ['hstore'],
    );
    assert.equal(cached.runtimeDirectory, firstInstall.runtimeDirectory);
    assert.equal(cached.moduleDirectory, firstInstall.moduleDirectory);
    await assertNoRuntimeCacheTemporarySiblings(dirname(runtimeDirectory));

    const recomputedArchive = Buffer.from('recomputed-qualified-hstore-inner-archive');
    const recomputedBundleManifest = {
      ...bundleManifest,
      members: bundleManifest.members.map((member) =>
        member.sqlName === 'hstore'
          ? {
              ...member,
              sha256: createHash('sha256').update(recomputedArchive).digest('hex'),
              bytes: recomputedArchive.byteLength,
            }
          : member,
      ),
    };
    await writeFile(join(targetRoot, hstoreArchivePath), recomputedArchive);
    await writeFile(
      join(targetRoot, 'extensions/hstore/runtime/share/postgresql/extension/foreign.control'),
      'undeclared',
    );
    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify(recomputedBundleManifest),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /undeclared extension SQL\/control file.*foreign\.control/,
    );
    await rm(
      join(targetRoot, 'extensions/hstore/runtime/share/postgresql/extension/foreign.control'),
    );
    await writeFile(join(targetRoot, hstoreArchivePath), hstoreArchive);
    await writeFile(join(targetRoot, 'bundle-manifest.json'), JSON.stringify(bundleManifest));

    for (const [relativePath, expected] of [
      [
        'extensions/auto_explain/runtime/share/postgresql/extension/auto_explain.control',
        /undeclared extension SQL\/control file.*auto_explain\.control/,
      ],
    ] as const) {
      await writeFile(join(targetRoot, relativePath), 'undeclared');
      await assert.rejects(
        () =>
          materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
            'hstore',
          ]),
        expected,
      );
      await rm(join(targetRoot, relativePath));
    }

    const hstoreInstall = join(
      targetRoot,
      'extensions/hstore/runtime/share/postgresql/extension/hstore--1.0.sql',
    );
    const hstoreTransition = join(
      targetRoot,
      'extensions/hstore/runtime/share/postgresql/extension/hstore--0.9--1.0.sql',
    );
    const hstoreInstallBytes = await readFile(hstoreInstall);
    await rm(hstoreInstall);
    await writeFile(hstoreTransition, 'owned transition is not a base install');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /hstore\.control and canonical base installation SQL/,
    );
    await rm(hstoreTransition);
    const hstoreLetterLeading = join(
      targetRoot,
      'extensions/hstore/runtime/share/postgresql/extension/hstore--release.sql',
    );
    await writeFile(hstoreLetterLeading, 'letter-leading version is not a base install');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /hstore\.control and canonical base installation SQL/,
    );
    await rm(hstoreLetterLeading);
    await writeFile(hstoreInstall, hstoreInstallBytes);

    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        schema: 'oliphaunt-extension-bundle-v1',
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /uses the physical carrier schema; expected oliphaunt-npm-extension-bundle-v1/,
    );

    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        members: bundleManifest.members.map((member) =>
          member.sqlName === 'hstore' ? { ...member, identity: `hstore-${target.id}` } : member,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /runtime member hstore must declare identity=null/,
    );

    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        members: bundleManifest.members.map((member) =>
          member.sqlName === 'hstore' ? { ...member, identity: undefined } : member,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /runtime member hstore must declare identity=null/,
    );

    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        members: bundleManifest.members.map((member, index) =>
          index === 1 ? { ...bundleManifest.members[0] } : member,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /repeats a canonical member or archive path/,
    );

    await writeFile(join(targetRoot, 'bundle-manifest.json'), JSON.stringify(bundleManifest));
    const redirectedRuntimePath = 'extensions/hstore/redirected-runtime';
    await writeFile(
      join(targetRoot, 'package.json'),
      JSON.stringify({
        ...targetPackageJson,
        oliphaunt: {
          ...targetPackageJson.oliphaunt,
          memberRuntimeRelativePaths: {
            ...memberRuntimeRelativePaths,
            hstore: redirectedRuntimePath,
          },
        },
      }),
    );
    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        members: bundleManifest.members.map((member) =>
          member.sqlName === 'hstore'
            ? { ...member, runtimeRelativePath: redirectedRuntimePath }
            : member,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /must declare one runtime path for every exact member/,
    );

    const redirectedModulePath = 'extensions/hstore/runtime/redirected-modules';
    await writeFile(
      join(targetRoot, 'package.json'),
      JSON.stringify({
        ...targetPackageJson,
        oliphaunt: {
          ...targetPackageJson.oliphaunt,
          memberModuleRelativePaths: {
            ...memberModuleRelativePaths,
            hstore: redirectedModulePath,
          },
        },
      }),
    );
    await writeFile(
      join(targetRoot, 'bundle-manifest.json'),
      JSON.stringify({
        ...bundleManifest,
        members: bundleManifest.members.map((member) =>
          member.sqlName === 'hstore'
            ? { ...member, moduleRelativePath: redirectedModulePath }
            : member,
        ),
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /invalid member module paths/,
    );

    await writeFile(join(targetRoot, 'package.json'), JSON.stringify(targetPackageJson));
    await writeFile(join(targetRoot, 'bundle-manifest.json'), JSON.stringify(bundleManifest));
    const manifestPath = join(targetRoot, 'bundle-manifest.json');
    const realManifestPath = join(targetRoot, 'real-bundle-manifest.json');
    await rename(manifestPath, realManifestPath);
    await symlink(realManifestPath, manifestPath);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /bundle manifest does not point to an existing file/,
    );
    await rm(manifestPath);
    await rename(realManifestPath, manifestPath);

    const contractPath = join(targetRoot, 'extension-contract.json');
    const realContractPath = join(targetRoot, 'real-extension-contract.json');
    await rename(contractPath, realContractPath);
    await symlink(realContractPath, contractPath);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /extension contract does not point to an existing file/,
    );
    await rm(contractPath);
    await rename(realContractPath, contractPath);

    const hstoreArchiveFile = join(targetRoot, hstoreArchivePath);
    const realHstoreArchiveFile = join(targetRoot, 'real-hstore.tar.gz');
    await rename(hstoreArchiveFile, realHstoreArchiveFile);
    await symlink(realHstoreArchiveFile, hstoreArchiveFile);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /bundle member hstore does not point to an existing file/,
    );
    await rm(hstoreArchiveFile);
    await rename(realHstoreArchiveFile, hstoreArchiveFile);

    const hstoreModuleDirectory = join(targetRoot, 'extensions/hstore/runtime/lib/postgresql');
    const realHstoreModuleDirectory = join(targetRoot, 'real-hstore-modules');
    await rename(hstoreModuleDirectory, realHstoreModuleDirectory);
    await symlink(realHstoreModuleDirectory, hstoreModuleDirectory, 'dir');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /contains symbolic link lib\/postgresql/,
    );
    await rm(hstoreModuleDirectory);
    await rename(realHstoreModuleDirectory, hstoreModuleDirectory);

    const pgTrgmArchivePath = 'extensions/pg_trgm/pg_trgm.tar.gz';
    await writeFile(join(targetRoot, pgTrgmArchivePath), 'tampered-unselected-inner-archive');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /bundle member pg_trgm does not match its exact bytes and sha256/,
    );
    await writeFile(
      join(targetRoot, pgTrgmArchivePath),
      Buffer.from('qualified-pg_trgm-inner-archive'),
    );
    await writeFile(join(targetRoot, hstoreArchivePath), 'tampered-inner-archive');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /does not match its exact bytes and sha256/,
    );
  } finally {
    if (firstInstall?.runtimeDirectory !== undefined) {
      await rm(dirname(firstInstall.runtimeDirectory), {
        recursive: true,
        force: true,
      });
    }
    await rm(root, { recursive: true, force: true });
    for (const packageRoot of createdPackageRoots.reverse()) {
      await rm(packageRoot, { recursive: true, force: true });
    }
    await removeEmptyParents(nativeResolverPackageScopeRoot(), [
      dirname(nativeResolverPackageScopeRoot()),
    ]);
  }
}

async function writePreparedHstoreRuntime(runtimeDirectory: string, target: string): Promise<void> {
  const moduleSuffix = nativeModuleSuffixForTarget(target);
  await mkdir(join(runtimeDirectory, 'share/postgresql/extension'), {
    recursive: true,
  });
  await mkdir(join(runtimeDirectory, 'lib/postgresql'), { recursive: true });
  await mkdir(join(runtimeDirectory, 'lib/modules'), { recursive: true });
  await writeFile(join(runtimeDirectory, 'share/postgresql/extension/hstore.control'), 'extension');
  await writeFile(join(runtimeDirectory, 'share/postgresql/extension/hstore--1.0.sql'), 'install');
  await writeFile(
    join(runtimeDirectory, 'lib/postgresql', `hstore${moduleSuffix}`),
    'server module',
  );
  await writeFile(
    join(runtimeDirectory, 'lib/modules', `hstore${moduleSuffix}`),
    'embedded module',
  );
  for (const moduleStem of ['dict_snowball', 'plpgsql']) {
    await writeFile(
      join(runtimeDirectory, 'lib/postgresql', `${moduleStem}${moduleSuffix}`),
      `server module:${moduleStem}`,
    );
    await writeFile(
      join(runtimeDirectory, 'lib/modules', `${moduleStem}${moduleSuffix}`),
      `embedded module:${moduleStem}`,
    );
  }
}

async function nodeExtensionMaterializationRejectsIncompletePackagePayloads(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const { liboliphauntVersion } = await readTypeScriptPackageVersions();
  const extensionVersion = '9.9.9';
  const basePackageName = '@oliphaunt/extension-vector';
  const targetPackageName = `${basePackageName}-${target.id}`;
  const product = 'oliphaunt-extension-vector';
  const vectorMetadata = GENERATED_EXTENSION_METADATA.find(
    (candidate) => candidate.sqlName === 'vector',
  );
  if (vectorMetadata === undefined) assert.fail('missing generated vector metadata');
  const vectorContract = fixtureExtensionContract(vectorMetadata, {
    licenseFiles: [
      fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', 'canonical vector license'),
    ],
  });
  const createdPackageRoots: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-extension-invalid-'));
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  const installRuntime = join(root, 'runtime');
  try {
    await writeFixturePackage(basePackageName, createdPackageRoots, {
      name: basePackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension',
        sqlName: 'vector',
        targetPackageNames: { [target.id]: targetPackageName },
      },
    });
    const targetRoot = await writeFixturePackage(targetPackageName, createdPackageRoots, {
      name: targetPackageName,
      version: extensionVersion,
      oliphaunt: {
        product,
        kind: 'exact-extension-target',
        sqlName: 'vector',
        target: target.id,
        liboliphauntVersion,
        extensionContract: 'extension-contract.json',
        runtimeRelativePath: 'redirected-runtime',
        moduleRelativePath: 'redirected-runtime/lib/postgresql',
      },
    });
    const vectorContractManifest = fixtureExtensionContractManifest(
      product,
      extensionVersion,
      target.id,
      [vectorContract],
    );
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify(vectorContractManifest),
    );
    await mkdir(installRuntime, { recursive: true });

    const redirectedRuntime = join(targetRoot, 'redirected-runtime');
    await mkdir(join(redirectedRuntime, 'share/postgresql/extension'), {
      recursive: true,
    });
    await mkdir(join(redirectedRuntime, 'lib/postgresql'), { recursive: true });
    await mkdir(join(redirectedRuntime, 'lib/modules'), { recursive: true });
    await writeFile(
      join(redirectedRuntime, 'share/postgresql/extension/vector.control'),
      'extension',
    );
    await writeFile(
      join(redirectedRuntime, 'share/postgresql/extension/vector--1.0.sql'),
      'install',
    );
    await writeFile(
      join(redirectedRuntime, 'lib/postgresql', `vector${nativeModuleSuffixForTarget(target.id)}`),
      'server module',
    );
    await writeFile(
      join(redirectedRuntime, 'lib/modules', `vector${nativeModuleSuffixForTarget(target.id)}`),
      'embedded module',
    );
    const vectorLicense = join(redirectedRuntime, 'share/licenses/vector/LICENSE');
    await mkdir(dirname(vectorLicense), { recursive: true });
    await writeFile(vectorLicense, 'canonical vector license');
    await chmod(vectorLicense, 0o644);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /extension runtime path must be exactly runtime/,
    );

    const canonicalRuntime = join(targetRoot, 'runtime');
    await rename(redirectedRuntime, canonicalRuntime);
    const independentlyVersionedContract = {
      ...vectorContract,
      dataFiles: ['oliphaunt-skew/new-version.dat'],
      extensionSqlFileNames: ['vector_legacy.sql'],
    };
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify(
        fixtureExtensionContractManifest(product, extensionVersion, target.id, [
          independentlyVersionedContract,
        ]),
      ),
    );
    const skewData = join(canonicalRuntime, 'share/postgresql/oliphaunt-skew/new-version.dat');
    await mkdir(dirname(skewData), { recursive: true });
    await writeFile(skewData, 'frozen newer data');
    await writeFile(
      join(canonicalRuntime, 'share/postgresql/extension/vector_legacy.sql'),
      'frozen ancillary SQL',
    );
    await writeFile(
      join(targetRoot, 'package.json'),
      JSON.stringify({
        name: targetPackageName,
        version: extensionVersion,
        oliphaunt: {
          product,
          kind: 'exact-extension-target',
          sqlName: 'vector',
          target: target.id,
          liboliphauntVersion,
          extensionContract: 'extension-contract.json',
          runtimeRelativePath: 'runtime',
          moduleRelativePath: 'runtime/lib/modules',
        },
      }),
    );
    const independentlyVersionedInstall = await materializeNodeExtensionInstall(
      { libraryPath, runtimeDirectory: installRuntime },
      ['vector'],
    );
    if (independentlyVersionedInstall.runtimeDirectory === undefined) {
      assert.fail('independently versioned vector contract should materialize a runtime');
    }
    assert.equal(
      await readFile(
        join(
          independentlyVersionedInstall.runtimeDirectory,
          'share/postgresql/oliphaunt-skew/new-version.dat',
        ),
        'utf8',
      ),
      'frozen newer data',
    );
    assert.equal(
      await readFile(
        join(independentlyVersionedInstall.runtimeDirectory, 'share/licenses/vector/LICENSE'),
        'utf8',
      ),
      'canonical vector license',
    );
    await rm(skewData);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /missing declared data file\(s\).*oliphaunt-skew\/new-version\.dat/,
    );
    await mkdir(dirname(skewData), { recursive: true });
    await writeFile(skewData, 'frozen newer data');

    const canonicalLicense = join(canonicalRuntime, 'share/licenses/vector/LICENSE');
    const canonicalLicenseBytes = await readFile(canonicalLicense);
    await rm(canonicalLicense);
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /missing declared license file\(s\).*share\/licenses\/vector\/LICENSE/,
    );
    await writeFile(canonicalLicense, canonicalLicenseBytes);
    await chmod(canonicalLicense, 0o644);

    await writeFile(canonicalLicense, 'tampered vector license');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /license file share\/licenses\/vector\/LICENSE does not match declared SHA-256/,
    );
    await writeFile(canonicalLicense, canonicalLicenseBytes);

    if (platform() !== 'win32') {
      for (const unsafeMode of [0o664, 0o4644]) {
        await chmod(canonicalLicense, unsafeMode);
        await assert.rejects(
          () =>
            materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
              'vector',
            ]),
          /license file share\/licenses\/vector\/LICENSE mode is not a safe installed representation of declared 0644/,
        );
      }
      await chmod(canonicalLicense, 0o600);
      await materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
        'vector',
      ]);
      await chmod(canonicalLicense, 0o644);
    }

    const extraLicense = join(canonicalRuntime, 'share/licenses/vector/EXTRA');
    await writeFile(extraLicense, 'undeclared legal material');
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /undeclared runtime file.*share\/licenses\/vector\/EXTRA/,
    );
    await rm(extraLicense);

    for (const [licenseFiles, expected] of [
      [[], /undeclared runtime file.*share\/licenses\/vector\/LICENSE/],
      [
        [fixtureExtensionLicenseFile('share/licenses/vector/NOTICE', 'notice')],
        /undeclared runtime file.*share\/licenses\/vector\/LICENSE/,
      ],
      [
        [fixtureExtensionLicenseFile('share/licenses/vector/../escape', 'escape')],
        /licenseFiles\[0\]\.path must be a portable path under share\/licenses\//,
      ],
      [
        [
          fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
          fixtureExtensionLicenseFile('share/licenses/vector/license', canonicalLicenseBytes),
        ],
        /licenseFiles contains case\/NFC-colliding paths/,
      ],
      [
        [fixtureExtensionLicenseFile('share/licenses/vector/%2e%2e/escape', 'escape')],
        /licenseFiles\[0\]\.path must be a portable path under share\/licenses\//,
      ],
      [
        [fixtureExtensionLicenseFile('share/licenses/con/LICENSE', 'reserved')],
        /licenseFiles\[0\]\.path must be a portable path under share\/licenses\//,
      ],
      [
        [
          fixtureExtensionLicenseFile('share/licenses/vector/NOTICE', 'notice'),
          fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
        ],
        /licenseFiles must be sorted by path with unique paths/,
      ],
      [
        [
          fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
          fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
        ],
        /licenseFiles must be sorted by path with unique paths/,
      ],
      [
        [
          {
            ...fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
            unexpected: true,
          },
        ],
        /licenseFiles\[0\] fields must be exactly mode, path, sha256/,
      ],
      [
        [
          {
            ...fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
            sha256: createHash('sha256').update(canonicalLicenseBytes).digest('hex').toUpperCase(),
          },
        ],
        /licenseFiles\[0\]\.sha256 must be a lowercase SHA-256 digest/,
      ],
      [
        [
          {
            ...fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
            sha256: '0'.repeat(64),
          },
        ],
        /license file share\/licenses\/vector\/LICENSE does not match declared SHA-256/,
      ],
      [
        [
          {
            ...fixtureExtensionLicenseFile('share/licenses/vector/LICENSE', canonicalLicenseBytes),
            mode: '0755',
          },
        ],
        /licenseFiles\[0\]\.mode must be 0644/,
      ],
    ] as const) {
      await writeFile(
        join(targetRoot, 'extension-contract.json'),
        JSON.stringify(
          fixtureExtensionContractManifest(product, extensionVersion, target.id, [
            {
              ...independentlyVersionedContract,
              licenseFiles: [...licenseFiles],
            },
          ]),
        ),
      );
      await assert.rejects(
        () =>
          materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
            'vector',
          ]),
        expected,
      );
    }
    await writeFile(
      join(targetRoot, 'extension-contract.json'),
      JSON.stringify(
        fixtureExtensionContractManifest(product, extensionVersion, target.id, [
          independentlyVersionedContract,
        ]),
      ),
    );
    await rm(dirname(independentlyVersionedInstall.runtimeDirectory), {
      recursive: true,
      force: true,
    });

    const canonicalModuleDirectory = join(canonicalRuntime, 'lib/modules');
    const realModuleDirectory = join(targetRoot, 'real-module-directory');
    await rename(canonicalModuleDirectory, realModuleDirectory);
    await symlink(realModuleDirectory, canonicalModuleDirectory, 'dir');
    await writeFile(
      join(targetRoot, 'package.json'),
      JSON.stringify({
        name: targetPackageName,
        version: extensionVersion,
        oliphaunt: {
          product,
          kind: 'exact-extension-target',
          sqlName: 'vector',
          target: target.id,
          liboliphauntVersion,
          extensionContract: 'extension-contract.json',
          runtimeRelativePath: 'runtime',
          moduleRelativePath: 'runtime/lib/modules',
        },
      }),
    );
    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'vector',
        ]),
      /contains symbolic link lib\/modules/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const packageRoot of createdPackageRoots.reverse()) {
      await rm(packageRoot, { recursive: true, force: true });
    }
    await removeEmptyParents(nativeResolverPackageScopeRoot(), [
      dirname(nativeResolverPackageScopeRoot()),
    ]);
  }
}

async function typeScriptPackageMetadataMatchesRuntimePackages(): Promise<void> {
  const packageJson = await readTypeScriptPackageJson();
  const liboliphauntVersion = packageMetadataVersion(packageJson, 'liboliphauntVersion');
  const brokerVersion = packageMetadataVersion(packageJson, 'brokerVersion');
  const nodeDirectVersion = packageMetadataVersion(packageJson, 'nodeDirectAddonVersion');
  const icuVersion = packageMetadataVersion(packageJson, 'icuVersion');
  assert.equal(packageJson.oliphaunt?.icuPackage, '@oliphaunt/icu');
  assert.equal(icuVersion, liboliphauntVersion);
  assert.equal(packageJson.oliphaunt?.nodeDirectAddon, 'oliphaunt-node-direct');
  assert.equal(packageJson.oliphaunt?.brokerHelper, 'oliphaunt-broker');
  assert.deepEqual(packageJson.dependencies, { '@oliphaunt/js-core': 'workspace:*' });
  assert.deepEqual(packageJson.bundledDependencies, ['@oliphaunt/js-core']);
  const optionalDependencyNames = [
    '@oliphaunt/broker-darwin-arm64',
    '@oliphaunt/broker-linux-arm64-gnu',
    '@oliphaunt/broker-linux-x64-gnu',
    '@oliphaunt/broker-win32-x64-msvc',
    '@oliphaunt/liboliphaunt-darwin-arm64',
    '@oliphaunt/liboliphaunt-linux-arm64-gnu',
    '@oliphaunt/liboliphaunt-linux-x64-gnu',
    '@oliphaunt/liboliphaunt-win32-x64-msvc',
    '@oliphaunt/node-direct-darwin-arm64',
    '@oliphaunt/node-direct-linux-arm64-gnu',
    '@oliphaunt/node-direct-linux-x64-gnu',
    '@oliphaunt/node-direct-win32-x64-msvc',
  ];
  assert.deepEqual(
    Object.keys(packageJson.optionalDependencies ?? {}).sort(),
    optionalDependencyNames,
  );
  for (const packageName of optionalDependencyNames.slice(0, 4)) {
    assert.equal(packageJson.optionalDependencies?.[packageName], 'workspace:*');
  }
  for (const packageName of optionalDependencyNames.slice(4, 8)) {
    assert.equal(packageJson.optionalDependencies?.[packageName], 'workspace:*');
  }
  for (const packageName of optionalDependencyNames.slice(8, 12)) {
    assert.equal(packageJson.optionalDependencies?.[packageName], 'workspace:*');
  }
  await assertPlatformPackageTarget(
    '../../../../runtimes/liboliphaunt/native/packages/linux-x64-gnu/package.json',
    '@oliphaunt/liboliphaunt-linux-x64-gnu',
    liboliphauntVersion,
    'linux-x64-gnu',
    'runtime',
  );
  await assertPlatformPackageTarget(
    '../../../../runtimes/broker/packages/linux-x64-gnu/package.json',
    '@oliphaunt/broker-linux-x64-gnu',
    brokerVersion,
    'linux-x64-gnu',
  );
  await assertPlatformPackageTarget(
    '../../../../runtimes/node-direct/packages/linux-x64-gnu/package.json',
    '@oliphaunt/node-direct-linux-x64-gnu',
    nodeDirectVersion,
    'linux-x64-gnu',
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const require = createRequire(import.meta.url);

function packageRoot(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

function contribBundleMembers(): string[] {
  return GENERATED_EXTENSION_METADATA.filter(
    (extension) => extension.artifactProduct === 'oliphaunt-extension-contrib-pg18',
  )
    .map((extension) => extension.sqlName)
    .sort();
}

function nativeResolverPackageScopeRoot(): string {
  return fileURLToPath(new URL('../native/node_modules/@oliphaunt/', import.meta.url));
}

function nativeResolverPackageRoot(packageName: string): string {
  const prefix = '@oliphaunt/';
  if (!packageName.startsWith(prefix)) {
    throw new Error(`test fixture package must use ${prefix}: ${packageName}`);
  }
  return join(nativeResolverPackageScopeRoot(), packageName.slice(prefix.length));
}

async function writeFixturePackage(
  packageName: string,
  createdPackageRoots: string[],
  packageJson: Record<string, unknown>,
): Promise<string> {
  const root = nativeResolverPackageRoot(packageName);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
  createdPackageRoots.push(root);
  return root;
}

async function writeFixtureFile(
  path: string,
  contents: string,
  createdFiles: string[],
): Promise<void> {
  try {
    await readFile(path);
    return;
  } catch {}
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
  createdFiles.push(path);
}

async function writeClusterSeedFixture(
  root: string,
  profile: 'standard' | 'icu',
  target: string,
  createdFiles: string[],
): Promise<void> {
  if (profile === 'standard') {
    await writeFixtureFile(
      join(dirname(root), 'manifest.properties'),
      `schema=oliphaunt-native-runtime-carrier-v1\nclusterSeedTarget=${target}\nclusterSeedRelativePath=cluster-seed\nicuClusterSeedRelativePath=cluster-seed-icu\n`,
      createdFiles,
    );
  }
  await writeFixtureFile(join(root, 'files', 'PG_VERSION'), '18\n', createdFiles);
  await writeFixtureFile(join(root, 'files', 'global', 'pg_control'), 'control', createdFiles);
  await writeFixtureFile(
    join(root, 'manifest.properties'),
    [
      'schema=oliphaunt-runtime-resources-v1',
      'layout=oliphaunt-cluster-seed-v1',
      `artifactRole=cluster-seed-${profile}`,
      `catalogProfile=${profile}`,
      `target=${target}`,
      'postgresMajor=18',
      'physicalFormat=native-pg18-v1',
      `compatibilityKey=native-pg18-${target}-v1`,
      'initialSuperuser=postgres',
      `icuDataVersion=${profile === 'icu' ? '76.1' : ''}`,
      `icuDataForm=${profile === 'icu' ? 'files-le' : ''}`,
      `icuDataTreeSha256=${profile === 'icu' ? 'a'.repeat(64) : ''}`,
      `runtimeFeatures=${profile === 'icu' ? 'icu' : ''}`,
      'cacheKey=fixture-seed',
      '',
    ].join('\n'),
    createdFiles,
  );
}

async function removeFixtureFiles(files: string[], stopRoots: string[]): Promise<void> {
  for (const file of files.reverse()) {
    await rm(file, { force: true });
    await removeEmptyParents(dirname(file), stopRoots);
  }
}

async function removeEmptyParents(directory: string, stopRoots: string[]): Promise<void> {
  const stops = new Set(stopRoots.map((root) => resolve(root)));
  let current = resolve(directory);
  while (!stops.has(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function assertNoRuntimeCacheTemporarySiblings(cacheRoot: string): Promise<void> {
  const parent = dirname(cacheRoot);
  const name = basename(cacheRoot);
  const entries = await readdir(parent);
  assert.deepEqual(
    entries
      .filter(
        (entry) =>
          entry.startsWith(`${name}.build-`) ||
          entry.startsWith(`${name}.old-`) ||
          entry === `${name}.lock`,
      )
      .sort(),
    [],
  );
}

function nativeRuntimeToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc'
    ? ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']
    : ['initdb', 'pg_ctl', 'postgres'];
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

async function assertPlatformPackageTarget(
  relativePath: string,
  expectedName: string,
  expectedVersion: string,
  expectedTarget: string,
  expectedRuntimeRelativePath?: string,
): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  ) as {
    name?: string;
    version?: string;
    oliphaunt?: { target?: string; runtimeRelativePath?: string };
  };
  assert.equal(packageJson.name, expectedName);
  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageJson.oliphaunt?.target, expectedTarget);
  if (expectedRuntimeRelativePath !== undefined) {
    assert.equal(packageJson.oliphaunt?.runtimeRelativePath, expectedRuntimeRelativePath);
  }
}

test('asset resolver', async () => {
  await main();
});
