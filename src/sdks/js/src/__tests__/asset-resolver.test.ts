import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { test } from 'vitest';
import { resolvePackageRelativeUrl } from '../native/assets-deno.js';
import {
  materializeNodeExtensionInstall,
  type ResolvedNativeInstall,
  resolveNodeIcuDataDirectory,
  resolveNodeNativeInstall,
  resolvePackageRelativePath,
} from '../native/assets-node.js';
import { liboliphauntPackageTarget } from '../native/common.js';
import { extractTarArchive } from '../native/tar.js';
import { extractZipArchive } from '../native/zip.js';
import { brokerModeSupport } from '../runtime/broker.js';

type TypeScriptPackageMetadata = {
  oliphaunt?: {
    liboliphauntVersion?: string;
    icuPackage?: string;
    icuVersion?: string;
    brokerVersion?: string;
    nodeDirectAddon?: string;
    nodeDirectAddonVersion?: string;
    brokerHelper?: string;
  };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function main(): Promise<void> {
  packageTargetsMatchLiboliphauntPackages();
  await tarExtractionRejectsTraversal();
  await zipExtractionWritesFilesAndRejectsTraversal();
  packageMetadataPathsAreConfinedToPackageRoot();
  await nodeResolverUsesInstalledPackages();
  await nodeResolverMergesPackageManagedRuntimeAndSplitTools();
  await nodeIcuResolverAcceptsValidPortablePackage();
  await nodeExtensionMaterializationValidatesSelections();
  await nodeExtensionMaterializationCopiesPackagePayloads();
  await nodeExtensionMaterializationRejectsIncompletePackagePayloads();
  await typeScriptPackageMetadataMatchesRuntimePackages();
  await brokerSupportUsesInstalledPackages();
}

async function zipExtractionWritesFilesAndRejectsTraversal(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-zip-'));
  const host = {
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
  try {
    await extractZipArchive(
      zipArchive([{ path: 'bin/oliphaunt.dll', mode: 0o755, bytes: utf8('dll') }]),
      root,
      host,
      (bytes) => Uint8Array.from(inflateRawSync(bytes)),
    );
    assert.equal(await readFile(join(root, 'bin/oliphaunt.dll'), 'utf8'), 'dll');
    await assert.rejects(
      () =>
        extractZipArchive(
          zipArchive([{ path: '../evil', mode: 0o644, bytes: utf8('bad') }]),
          root,
          host,
          (bytes) => Uint8Array.from(inflateRawSync(bytes)),
        ),
      /unsafe ZIP entry path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function packageTargetsMatchLiboliphauntPackages(): void {
  const target = liboliphauntPackageTarget('darwin', 'aarch64');
  assert.equal(target.id, 'macos-arm64');
  assert.equal(target.packageName, '@oliphaunt/liboliphaunt-darwin-arm64');
  assert.equal(target.libraryRelativePath, 'lib/liboliphaunt.dylib');
  assert.equal(target.runtimeRelativePath, 'runtime');
  assert.equal(target.toolsPackageName, '@oliphaunt/tools-darwin-arm64');
  assert.equal(target.toolsRuntimeRelativePath, 'runtime');
  const linuxTarget = liboliphauntPackageTarget('linux', 'x64');
  assert.equal(linuxTarget.id, 'linux-x64-gnu');
  assert.equal(linuxTarget.packageName, '@oliphaunt/liboliphaunt-linux-x64-gnu');
  assert.equal(linuxTarget.libraryRelativePath, 'lib/liboliphaunt.so');
  assert.equal(linuxTarget.runtimeRelativePath, 'runtime');
  assert.equal(linuxTarget.toolsPackageName, '@oliphaunt/tools-linux-x64-gnu');
  assert.equal(linuxTarget.toolsRuntimeRelativePath, 'runtime');
  const linuxArmTarget = liboliphauntPackageTarget('linux', 'arm64');
  assert.equal(linuxArmTarget.id, 'linux-arm64-gnu');
  assert.equal(linuxArmTarget.packageName, '@oliphaunt/liboliphaunt-linux-arm64-gnu');
  assert.equal(linuxArmTarget.libraryRelativePath, 'lib/liboliphaunt.so');
  assert.equal(linuxArmTarget.runtimeRelativePath, 'runtime');
  assert.equal(linuxArmTarget.toolsPackageName, '@oliphaunt/tools-linux-arm64-gnu');
  assert.equal(linuxArmTarget.toolsRuntimeRelativePath, 'runtime');
  const windowsTarget = liboliphauntPackageTarget('win32', 'x64');
  assert.equal(windowsTarget.id, 'windows-x64-msvc');
  assert.equal(windowsTarget.packageName, '@oliphaunt/liboliphaunt-win32-x64-msvc');
  assert.equal(windowsTarget.libraryRelativePath, 'bin/oliphaunt.dll');
  assert.equal(windowsTarget.runtimeRelativePath, 'runtime');
  assert.equal(windowsTarget.toolsPackageName, '@oliphaunt/tools-win32-x64-msvc');
  assert.equal(windowsTarget.toolsRuntimeRelativePath, 'runtime');
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

async function tarExtractionRejectsTraversal(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-tar-'));
  try {
    await assert.rejects(
      () =>
        extractTarArchive(
          tarArchive([{ path: '../evil', mode: 0o644, bytes: utf8('bad') }]),
          root,
          {
            join,
            dirname,
            async mkdir(path) {
              await mkdir(path, { recursive: true });
            },
            async writeFile(file) {
              await writeFile(file.path, file.bytes, { mode: file.mode });
              await chmod(file.path, file.mode);
            },
          },
        ),
      /escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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

async function nodeResolverMergesPackageManagedRuntimeAndSplitTools(): Promise<void> {
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  delete process.env.LIBOLIPHAUNT_PATH;
  delete process.env.OLIPHAUNT_RUNTIME_DIR;

  const target = liboliphauntPackageTarget(platform(), arch());
  const runtimePackageRoot = packageRoot(target.packageName);
  const toolsPackageRoot = packageRoot(target.toolsPackageName);
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
    const toolsBin = join(toolsPackageRoot, target.toolsRuntimeRelativePath, 'bin');
    for (const tool of nativeClientToolsForTarget(target.id)) {
      await writeFixtureFile(join(toolsBin, tool), `tools:${tool}`, createdFiles);
    }

    const install = await resolveNodeNativeInstall();
    assert.equal(install.libraryPath, join(runtimePackageRoot, target.libraryRelativePath));
    const runtimeDirectory = install.runtimeDirectory;
    if (runtimeDirectory === undefined) {
      assert.fail('node resolver should materialize a package-managed runtime cache');
    }
    assert.ok(runtimeDirectory.includes('oliphaunt-js-runtime-cache'));
    assert.equal(install.icuDataDirectory, undefined);
    for (const tool of [
      ...nativeRuntimeToolsForTarget(target.id),
      ...nativeClientToolsForTarget(target.id),
    ]) {
      const bytes = await readFile(join(runtimeDirectory, 'bin', tool));
      assert.ok(bytes.byteLength > 0, `${tool} should be materialized into the runtime cache`);
    }
    await assertNoRuntimeCacheTemporarySiblings(dirname(runtimeDirectory));
    await rm(dirname(runtimeDirectory), { recursive: true, force: true });
  } finally {
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
    await removeFixtureFiles(createdFiles, [runtimePackageRoot, toolsPackageRoot]);
  }
}

async function nodeIcuResolverAcceptsValidPortablePackage(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-icu-'));
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: root,
        version: '9.9.9',
        oliphaunt: {
          product: 'oliphaunt-icu',
          kind: 'icu-data',
          target: 'portable',
          dataRelativePath: 'share/icu',
        },
      }),
      'utf8',
    );
    await mkdir(join(root, 'share/icu'), { recursive: true });
    await writeFile(join(root, 'share/icu/icudt76l.dat'), 'icu');
    assert.equal(await resolveNodeIcuDataDirectory('9.9.9', root), join(root, 'share/icu'));
    await assert.rejects(
      () => resolveNodeIcuDataDirectory('9.9.8', root),
      /does not match @oliphaunt\/ts icuVersion/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function nodeExtensionMaterializationValidatesSelections(): Promise<void> {
  const install: ResolvedNativeInstall = { libraryPath: '/tmp/liboliphaunt-test.so' };
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

async function nodeExtensionMaterializationCopiesPackagePayloads(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const basePackageName = '@oliphaunt/extension-hstore';
  const targetPackageName = `${basePackageName}-${target.id}`;
  const payloadPackageName = `${basePackageName}-payload-${target.id}`;
  const product = 'oliphaunt-extension-hstore';
  const createdPackageRoots: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-extension-install-'));
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  const installRuntime = join(root, 'runtime');
  let firstInstall: ResolvedNativeInstall | undefined;
  try {
    await writeFixturePackage(basePackageName, createdPackageRoots, {
      name: basePackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension',
        sqlName: 'hstore',
        targetPackageNames: { [target.id]: targetPackageName },
      },
    });
    await writeFixturePackage(targetPackageName, createdPackageRoots, {
      name: targetPackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension-target',
        sqlName: 'hstore',
        target: target.id,
        liboliphauntVersion: '0.1.0',
        payloadPackageNames: [payloadPackageName],
      },
    });
    const payloadRoot = await writeFixturePackage(payloadPackageName, createdPackageRoots, {
      name: payloadPackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension-payload',
        sqlName: 'hstore',
        target: target.id,
        liboliphauntVersion: '0.1.0',
        runtimeRelativePath: 'runtime',
        moduleRelativePath: 'runtime/lib/postgresql',
      },
    });
    await mkdir(join(payloadRoot, 'runtime/share/postgresql/extension'), { recursive: true });
    await mkdir(join(payloadRoot, 'runtime/lib/postgresql'), { recursive: true });
    await writeFile(
      join(payloadRoot, 'runtime/share/postgresql/extension/hstore.control'),
      'extension',
    );
    await writeFile(
      join(payloadRoot, 'runtime/share/postgresql/extension/hstore--1.0.sql'),
      'install',
    );
    const nativeModule = `hstore${nativeModuleSuffixForTarget(target.id)}`;
    await writeFile(join(payloadRoot, 'runtime/lib/postgresql', nativeModule), 'module');
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
    assert.equal(await readFile(join(moduleDirectory, 'base-module.so'), 'utf8'), 'base-module');
    assert.equal(await readFile(join(moduleDirectory, nativeModule), 'utf8'), 'module');

    const cached = await materializeNodeExtensionInstall(
      { libraryPath, runtimeDirectory: installRuntime },
      ['hstore'],
    );
    assert.equal(cached.runtimeDirectory, firstInstall.runtimeDirectory);
    assert.equal(cached.moduleDirectory, firstInstall.moduleDirectory);
    await assertNoRuntimeCacheTemporarySiblings(dirname(runtimeDirectory));
  } finally {
    if (firstInstall?.runtimeDirectory !== undefined) {
      await rm(dirname(firstInstall.runtimeDirectory), { recursive: true, force: true });
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

async function nodeExtensionMaterializationRejectsIncompletePackagePayloads(): Promise<void> {
  const target = liboliphauntPackageTarget(platform(), arch());
  const basePackageName = '@oliphaunt/extension-hstore';
  const targetPackageName = `${basePackageName}-${target.id}`;
  const payloadPackageName = `${basePackageName}-payload-${target.id}`;
  const product = 'oliphaunt-extension-hstore';
  const createdPackageRoots: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-extension-invalid-'));
  const libraryPath = join(root, 'lib/liboliphaunt.so');
  const installRuntime = join(root, 'runtime');
  try {
    await writeFixturePackage(basePackageName, createdPackageRoots, {
      name: basePackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension',
        sqlName: 'hstore',
        targetPackageNames: { [target.id]: targetPackageName },
      },
    });
    await writeFixturePackage(targetPackageName, createdPackageRoots, {
      name: targetPackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension-target',
        sqlName: 'hstore',
        target: target.id,
        liboliphauntVersion: '0.1.0',
        payloadPackageNames: [payloadPackageName],
      },
    });
    const payloadRoot = await writeFixturePackage(payloadPackageName, createdPackageRoots, {
      name: payloadPackageName,
      version: '0.1.0',
      oliphaunt: {
        product,
        kind: 'exact-extension-payload',
        sqlName: 'hstore',
        target: target.id,
        liboliphauntVersion: '0.1.0',
        runtimeRelativePath: 'runtime',
        moduleRelativePath: 'runtime/lib/postgresql',
      },
    });
    await mkdir(join(payloadRoot, 'runtime/share/postgresql/extension'), { recursive: true });
    await mkdir(join(payloadRoot, 'runtime/lib/postgresql'), { recursive: true });
    await writeFile(
      join(payloadRoot, 'runtime/share/postgresql/extension/hstore.control'),
      'extension',
    );
    await writeFile(
      join(
        payloadRoot,
        'runtime/lib/postgresql',
        `hstore${nativeModuleSuffixForTarget(target.id)}`,
      ),
      'module',
    );
    await mkdir(installRuntime, { recursive: true });

    await assert.rejects(
      () =>
        materializeNodeExtensionInstall({ libraryPath, runtimeDirectory: installRuntime }, [
          'hstore',
        ]),
      /missing SQL install files for hstore/,
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
  assert.deepEqual(packageJson.dependencies ?? {}, {});
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
    '@oliphaunt/tools-darwin-arm64',
    '@oliphaunt/tools-linux-arm64-gnu',
    '@oliphaunt/tools-linux-x64-gnu',
    '@oliphaunt/tools-win32-x64-msvc',
  ];
  assert.deepEqual(
    Object.keys(packageJson.optionalDependencies ?? {}).sort(),
    optionalDependencyNames,
  );
  for (const packageName of optionalDependencyNames.slice(0, 4)) {
    assert.equal(packageJson.optionalDependencies?.[packageName], `workspace:${brokerVersion}`);
  }
  for (const packageName of optionalDependencyNames.slice(4, 8)) {
    assert.equal(
      packageJson.optionalDependencies?.[packageName],
      `workspace:${liboliphauntVersion}`,
    );
  }
  for (const packageName of optionalDependencyNames.slice(8, 12)) {
    assert.equal(packageJson.optionalDependencies?.[packageName], `workspace:${nodeDirectVersion}`);
  }
  for (const packageName of optionalDependencyNames.slice(12)) {
    assert.equal(
      packageJson.optionalDependencies?.[packageName],
      `workspace:${liboliphauntVersion}`,
    );
  }
  await assertPlatformPackageTarget(
    '../../../../runtimes/liboliphaunt/native/packages/linux-x64-gnu/package.json',
    '@oliphaunt/liboliphaunt-linux-x64-gnu',
    liboliphauntVersion,
    'linux-x64-gnu',
    'runtime',
  );
  await assertPlatformPackageTarget(
    '../../../../runtimes/liboliphaunt/native/tools-packages/linux-x64-gnu/package.json',
    '@oliphaunt/tools-linux-x64-gnu',
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

async function brokerSupportUsesInstalledPackages(): Promise<void> {
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  const previousBroker = process.env.OLIPHAUNT_BROKER;
  delete process.env.LIBOLIPHAUNT_PATH;
  delete process.env.OLIPHAUNT_RUNTIME_DIR;
  delete process.env.OLIPHAUNT_BROKER;
  try {
    const support = await brokerModeSupport({});
    assert.equal(support.available, false);
    assert.match(support.unavailableReason ?? '', /@oliphaunt\/broker-|@oliphaunt\/liboliphaunt-/);
  } finally {
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
    restoreEnv('OLIPHAUNT_BROKER', previousBroker);
  }
}

type TarEntry = {
  path: string;
  mode: number;
  bytes?: Uint8Array;
  directory?: boolean;
};

type ZipEntry = {
  path: string;
  mode: number;
  bytes: Uint8Array;
};

function zipArchive(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = utf8(entry.path);
    const compressed = Uint8Array.from(deflateRawSync(entry.bytes));
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    writeUInt32LE(local, 0, 0x04034b50);
    writeUInt16LE(local, 4, 20);
    writeUInt16LE(local, 8, 8);
    writeUInt32LE(local, 14, crc);
    writeUInt32LE(local, 18, compressed.length);
    writeUInt32LE(local, 22, entry.bytes.length);
    writeUInt16LE(local, 26, name.length);
    local.set(name, 30);
    chunks.push(local, compressed);

    const header = new Uint8Array(46 + name.length);
    writeUInt32LE(header, 0, 0x02014b50);
    writeUInt16LE(header, 4, 20);
    writeUInt16LE(header, 6, 20);
    writeUInt16LE(header, 10, 8);
    writeUInt32LE(header, 16, crc);
    writeUInt32LE(header, 20, compressed.length);
    writeUInt32LE(header, 24, entry.bytes.length);
    writeUInt16LE(header, 28, name.length);
    writeUInt32LE(header, 38, (entry.mode & 0o777) << 16);
    writeUInt32LE(header, 42, offset);
    header.set(name, 46);
    central.push(header);
    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const eocd = new Uint8Array(22);
  writeUInt32LE(eocd, 0, 0x06054b50);
  writeUInt16LE(eocd, 8, entries.length);
  writeUInt16LE(eocd, 10, entries.length);
  writeUInt32LE(eocd, 12, centralSize);
  writeUInt32LE(eocd, 16, centralOffset);
  return concatBytes([...chunks, ...central, eocd]);
}

function tarArchive(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array();
    blocks.push(
      tarHeader(entry.path, entry.directory === true ? '5' : '0', entry.mode, bytes.length),
    );
    if (entry.directory !== true) {
      blocks.push(bytes);
      const padding = (512 - (bytes.length % 512)) % 512;
      if (padding > 0) {
        blocks.push(new Uint8Array(padding));
      }
    }
  }
  blocks.push(new Uint8Array(1024));
  const length = blocks.reduce((total, block) => total + block.byteLength, 0);
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
}

function tarHeader(path: string, type: '0' | '5', mode: number, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, type);
  writeAscii(header, 257, 6, 'ustar');
  writeAscii(header, 263, 2, '00');
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encoded = checksum.toString(8).padStart(6, '0');
  writeAscii(header, 148, 8, `${encoded}\0 `);
  return header;
}

function writeAscii(buffer: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = utf8(value);
  if (encoded.byteLength > length) {
    throw new Error(`tar test value is too long: ${value}`);
  }
  buffer.set(encoded, offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
  writeAscii(buffer, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function writeUInt16LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

async function readTypeScriptPackageJson(): Promise<TypeScriptPackageMetadata> {
  return JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as TypeScriptPackageMetadata;
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

function packageMetadataVersion(
  packageJson: TypeScriptPackageMetadata,
  key: 'liboliphauntVersion' | 'icuVersion' | 'brokerVersion' | 'nodeDirectAddonVersion',
): string {
  const version = packageJson.oliphaunt?.[key];
  if (typeof version !== 'string' || version.length === 0) {
    assert.fail(`package.json oliphaunt.${key} must be set`);
  }
  return version;
}

test('asset resolver', async () => {
  await main();
});
