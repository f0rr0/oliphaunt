import assert from 'node:assert/strict';
import {
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  rename as fsRename,
  stat as fsStat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import Oliphaunt, { createNodeNativeBinding, type OliphauntClient, simpleQuery } from '../index.js';
import { resolveDenoNativeInstall } from '../native/assets-deno.js';
import { liboliphauntPackageTarget } from '../native/common.js';
import { createDenoNativeBinding } from '../native/deno.js';
import {
  cString,
  OLIPHAUNT_CONFIG_SIZE,
  OLIPHAUNT_RESPONSE_SIZE,
  packConfigPointers,
  packPointerArray,
  packRestoreOptionsPointers,
  readResponseLength,
  readResponsePointer,
  responseBuffer,
  writePointer,
} from '../native/ffi-layout.js';

async function main(): Promise<void> {
  testIndexExportsDefaultClient();
  testFfiLayoutPackingAndBounds();
  await testNodeNativeBindingUsesExplicitAssetsAndAddon();
  await testDenoAssetResolverHonorsExplicitPaths();
  await testDenoPackageManagedResolverPublishesRuntimeCacheAtomically();
  await testDenoNativeBindingRejectsPackageManagedExtensions();
}

function testIndexExportsDefaultClient(): void {
  assert.equal(typeof (Oliphaunt as OliphauntClient).open, 'function');
  assert.equal(typeof (Oliphaunt as OliphauntClient).supportedModes, 'function');
  assert.equal(simpleQuery('SELECT 1')[0], 0x51);
}

function testFfiLayoutPackingAndBounds(): void {
  assert.deepEqual([...cString('pgdata')], [112, 103, 100, 97, 116, 97, 0]);
  assert.throws(() => cString('bad\0value'), /NUL bytes/);

  const pointers = packPointerArray([1n, 2n, 3n]);
  const pointerView = new DataView(pointers.buffer);
  assert.equal(pointerView.getBigUint64(0, true), 1n);
  assert.equal(pointerView.getBigUint64(8, true), 2n);
  assert.equal(pointerView.getBigUint64(16, true), 3n);
  assert.equal(packPointerArray([]).byteLength, 8);

  let nextPointer = 16n;
  const seenStrings: string[] = [];
  const pointerOf = (value: Uint8Array): bigint => {
    const decoded = new TextDecoder().decode(value.slice(0, Math.max(0, value.byteLength - 1)));
    seenStrings.push(decoded);
    nextPointer += 16n;
    return nextPointer;
  };
  const packed = packConfigPointers(
    {
      pgdata: '/tmp/pgdata',
      runtimeDirectory: '/tmp/runtime',
      username: 'postgres',
      database: 'app',
      extensions: [],
      startupArgs: ['-c', 'work_mem=8MB'],
    },
    pointerOf,
  );
  assert.equal(packed.config.byteLength, OLIPHAUNT_CONFIG_SIZE);
  assert.ok(seenStrings.includes('/tmp/pgdata'));
  assert.ok(seenStrings.includes('/tmp/runtime'));
  assert.ok(seenStrings.includes('work_mem=8MB'));
  assert.equal(packed.keepAlive.length, 7);

  const restore = packRestoreOptionsPointers(
    {
      root: '/tmp/root',
      format: 'physicalArchive',
      bytes: new Uint8Array([1, 2, 3]),
      replaceExisting: true,
    },
    pointerOf,
  );
  assert.equal(restore.options.byteLength, 48);
  assert.equal(restore.keepAlive.length, 2);

  const response = responseBuffer();
  assert.equal(response.byteLength, OLIPHAUNT_RESPONSE_SIZE);
  const responseView = new DataView(response.buffer);
  writePointer(responseView, 0, 0x1234n);
  writePointer(responseView, 8, 3n);
  assert.equal(readResponsePointer(response), 0x1234n);
  assert.equal(readResponseLength(response), 3);
  writePointer(responseView, 8, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  assert.throws(() => readResponseLength(response), /safe integer/);
}

async function testNodeNativeBindingUsesExplicitAssetsAndAddon(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-node-binding-'));
  const addonPath = join(root, 'mock-addon.cjs');
  await writeFile(
    addonPath,
    `
let nextHandle = 40n;
module.exports = {
  default: {
    version(libraryPath) {
      globalThis.__oliphauntNodeAddonCalls.push(['version', libraryPath]);
      return '18.4-test';
    },
    capabilities(libraryPath) {
      globalThis.__oliphauntNodeAddonCalls.push(['capabilities', libraryPath]);
      return 195n;
    },
    open(config) {
      globalThis.__oliphauntNodeAddonCalls.push(['open', config]);
      nextHandle += 1n;
      return nextHandle;
    },
    execProtocolRaw(handle, request) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolRaw', handle, Array.from(request)]);
      return request.buffer.slice(request.byteOffset, request.byteOffset + request.byteLength);
    },
    execSimpleQuery(handle, sql) {
      globalThis.__oliphauntNodeAddonCalls.push(['execSimpleQuery', handle, sql]);
      return new Uint8Array([90, 0, 0, 0, 5, 73]);
    },
    execProtocolStream(handle, request, onChunk) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolStream', handle, Array.from(request)]);
      onChunk(new Uint8Array([1, 2]));
      onChunk(new Uint8Array([3]).buffer);
    },
    backup(handle, format) {
      globalThis.__oliphauntNodeAddonCalls.push(['backup', handle, format]);
      return new Uint8Array([4, 5, 6]).buffer;
    },
    restore(options) {
      globalThis.__oliphauntNodeAddonCalls.push(['restore', options]);
    },
    cancel(handle) {
      globalThis.__oliphauntNodeAddonCalls.push(['cancel', handle]);
    },
    detach(handle) {
      globalThis.__oliphauntNodeAddonCalls.push(['detach', handle]);
    },
  },
};
`,
    'utf8',
  );
  const calls: unknown[][] = [];
  (globalThis as { __oliphauntNodeAddonCalls?: unknown[][] }).__oliphauntNodeAddonCalls = calls;
  const previousRuntime = process.env.OLIPHAUNT_RUNTIME_DIR;
  process.env.OLIPHAUNT_RUNTIME_DIR = join(root, 'runtime');
  try {
    const binding = await createNodeNativeBinding({
      libraryPath: join(root, 'liboliphaunt.dylib'),
      nodeAddonPath: addonPath,
    });
    assert.equal(binding.runtime, 'node');
    assert.equal(binding.rawProtocolTransport, 'node-addon');
    assert.equal(binding.protocolStream, true);
    assert.equal(binding.defaultRuntimeDirectory, join(root, 'runtime'));
    assert.equal(binding.version(), '18.4-test');
    assert.equal(binding.capabilities(), 195n);

    const handle = await binding.open({
      pgdata: join(root, 'pgdata'),
      username: 'postgres',
      database: 'postgres',
      extensions: [],
      startupArgs: [],
    });
    assert.equal(handle, 41n);
    assert.deepEqual([...(await binding.execProtocolRaw(handle, new Uint8Array([7, 8])))], [7, 8]);
    const execSimpleQuery = binding.execSimpleQuery;
    assert.ok(execSimpleQuery !== undefined);
    assert.deepEqual([...(await execSimpleQuery(handle, 'SELECT 1'))], [90, 0, 0, 0, 5, 73]);
    const chunks: number[][] = [];
    const execProtocolStream = binding.execProtocolStream;
    assert.ok(execProtocolStream !== undefined);
    execProtocolStream(handle, new Uint8Array([9]), (chunk) => chunks.push([...chunk]));
    assert.deepEqual(chunks, [[1, 2], [3]]);
    assert.deepEqual([...(await binding.backup(handle, 'physicalArchive'))], [4, 5, 6]);
    assert.throws(() => binding.backup(handle, 'sql'), /not supported by nativeDirect/);
    binding.restore({
      root: join(root, 'restore'),
      format: 'physicalArchive',
      bytes: new Uint8Array([1]),
      replaceExisting: false,
    });
    assert.throws(
      () =>
        binding.restore({
          root: join(root, 'restore'),
          format: 'sql',
          bytes: new Uint8Array(),
          replaceExisting: false,
        }),
      /physicalArchive/,
    );
    binding.cancel(handle);
    binding.detach(handle);
    assert.deepEqual(
      calls.map((entry) => entry[0]),
      [
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
      ],
    );
  } finally {
    if (previousRuntime === undefined) {
      delete process.env.OLIPHAUNT_RUNTIME_DIR;
    } else {
      process.env.OLIPHAUNT_RUNTIME_DIR = previousRuntime;
    }
    delete (globalThis as { __oliphauntNodeAddonCalls?: unknown[][] }).__oliphauntNodeAddonCalls;
    await rm(root, { recursive: true, force: true });
  }
}

async function testDenoAssetResolverHonorsExplicitPaths(): Promise<void> {
  const previousRuntime = process.env.OLIPHAUNT_RUNTIME_DIR;
  process.env.OLIPHAUNT_RUNTIME_DIR = '/tmp/oliphaunt-deno-runtime';
  try {
    assert.deepEqual(await resolveDenoNativeInstall('/tmp/liboliphaunt.dylib'), {
      libraryPath: '/tmp/liboliphaunt.dylib',
      runtimeDirectory: '/tmp/oliphaunt-deno-runtime',
      icuDataDirectory: undefined,
      packageManaged: false,
    });
    await assert.rejects(async () => resolveDenoNativeInstall(), /only be used inside Deno/);
  } finally {
    if (previousRuntime === undefined) {
      delete process.env.OLIPHAUNT_RUNTIME_DIR;
    } else {
      process.env.OLIPHAUNT_RUNTIME_DIR = previousRuntime;
    }
  }
}

async function testDenoNativeBindingRejectsPackageManagedExtensions(): Promise<void> {
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const previousLibrary = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntime = process.env.OLIPHAUNT_RUNTIME_DIR;
  const calls: string[] = [];
  try {
    process.env.LIBOLIPHAUNT_PATH = '/tmp/liboliphaunt-deno-test.so';
    delete process.env.OLIPHAUNT_RUNTIME_DIR;
    (globalThis as { Deno?: unknown }).Deno = {
      build: { os: 'linux', arch: 'x86_64' },
      async readTextFile(path: string | URL) {
        const text = String(path);
        if (text.includes('@oliphaunt/icu')) {
          return JSON.stringify({
            name: '@oliphaunt/icu',
            version: '0.1.0',
            oliphaunt: {
              product: 'oliphaunt-icu',
              kind: 'icu-data',
              target: 'portable',
              dataRelativePath: 'share/icu',
            },
          });
        }
        return JSON.stringify({
          name: '@oliphaunt/ts',
          oliphaunt: {
            liboliphauntVersion: '0.1.0',
            icuPackage: '@oliphaunt/icu',
            icuVersion: '0.1.0',
          },
        });
      },
      async stat() {
        return { isDirectory: true };
      },
      async *readDir() {
        yield { name: 'icudt76l.dat', isFile: true };
      },
      dlopen(path: string) {
        calls.push(`dlopen:${path}`);
        return {
          symbols: {
            oliphaunt_init() {
              calls.push('init');
              return 0;
            },
            oliphaunt_exec_protocol() {
              return 0;
            },
            oliphaunt_exec_simple_query() {
              return 0;
            },
            oliphaunt_backup() {
              return 0;
            },
            oliphaunt_restore() {
              return 0;
            },
            oliphaunt_cancel() {
              return 0;
            },
            oliphaunt_detach() {
              return 0;
            },
            oliphaunt_last_error() {
              return null;
            },
            oliphaunt_version() {
              return null;
            },
            oliphaunt_capabilities() {
              return 0n;
            },
            oliphaunt_free_response() {},
          },
        };
      },
      UnsafePointer: {
        of() {
          throw new Error('Deno extension guard should run before pointer packing');
        },
        value() {
          return 0n;
        },
        create() {
          return null;
        },
      },
      UnsafePointerView: class {},
    };

    const binding = await createDenoNativeBinding();
    assert.throws(
      () =>
        binding.open({
          pgdata: '/tmp/deno-pgdata',
          runtimeDirectory: undefined,
          username: 'postgres',
          database: 'postgres',
          extensions: ['hstore'],
          startupArgs: [],
        }),
      /Deno nativeDirect does not automatically materialize extension packages/,
    );
    assert.deepEqual(calls, ['dlopen:/tmp/liboliphaunt-deno-test.so']);
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    if (previousLibrary === undefined) {
      delete process.env.LIBOLIPHAUNT_PATH;
    } else {
      process.env.LIBOLIPHAUNT_PATH = previousLibrary;
    }
    if (previousRuntime === undefined) {
      delete process.env.OLIPHAUNT_RUNTIME_DIR;
    } else {
      process.env.OLIPHAUNT_RUNTIME_DIR = previousRuntime;
    }
  }
}

async function testDenoPackageManagedResolverPublishesRuntimeCacheAtomically(): Promise<void> {
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  const target = liboliphauntPackageTarget('linux', 'x86_64');
  const runtimePackageRoot = packageRoot(target.packageName);
  const toolsPackageRoot = packageRoot(target.toolsPackageName);
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-cache-'));
  const createdFiles: string[] = [];
  let failCopyTo: ((path: string) => boolean) | undefined;
  try {
    delete process.env.LIBOLIPHAUNT_PATH;
    delete process.env.OLIPHAUNT_RUNTIME_DIR;
    (globalThis as { Deno?: unknown }).Deno = fsBackedDenoRuntime(root, (path) =>
      failCopyTo?.(path),
    );

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

    const install = await resolveDenoNativeInstall();
    assert.equal(install.libraryPath, join(runtimePackageRoot, target.libraryRelativePath));
    assert.equal(install.packageManaged, true);
    const runtimeDirectory = install.runtimeDirectory;
    if (runtimeDirectory === undefined) {
      assert.fail('Deno resolver should materialize a package-managed runtime cache');
    }
    assert.ok(runtimeDirectory.startsWith(root));
    for (const tool of [
      ...nativeRuntimeToolsForTarget(target.id),
      ...nativeClientToolsForTarget(target.id),
    ]) {
      assert.ok((await readFile(join(runtimeDirectory, 'bin', tool))).byteLength > 0);
    }
    const cacheRoot = dirname(runtimeDirectory);
    await assertNoRuntimeCacheTemporarySiblings(cacheRoot);

    const previousMarker = 'previous-valid-manifest';
    await writeFile(join(cacheRoot, 'manifest.json'), previousMarker, 'utf8');
    await writeFile(join(runtimeDirectory, 'bin/previous-only'), 'old-runtime', 'utf8');
    failCopyTo = (path) => path.endsWith('/runtime/bin/psql');
    await assert.rejects(() => resolveDenoNativeInstall(), /injected Deno copy failure/);
    assert.equal(await readFile(join(cacheRoot, 'manifest.json'), 'utf8'), previousMarker);
    assert.equal(
      await readFile(join(runtimeDirectory, 'bin/previous-only'), 'utf8'),
      'old-runtime',
    );
    await assertNoRuntimeCacheTemporarySiblings(cacheRoot);
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
    await rm(root, { recursive: true, force: true });
    await removeFixtureFiles(createdFiles, [runtimePackageRoot, toolsPackageRoot]);
  }
}

function fsBackedDenoRuntime(
  tempRoot: string,
  shouldFailCopy: (path: string) => boolean | undefined,
): unknown {
  return {
    build: { os: 'linux', arch: 'x86_64' },
    env: {
      get(name: string) {
        return name === 'TMPDIR' ? tempRoot : undefined;
      },
    },
    async readTextFile(path: string | URL) {
      return readFile(fsPath(path), 'utf8');
    },
    async writeTextFile(path: string | URL, data: string) {
      await writeFile(fsPath(path), data, 'utf8');
    },
    async *readDir(path: string | URL) {
      for (const entry of await readdir(fsPath(path), { withFileTypes: true })) {
        yield {
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        };
      }
    },
    async stat(path: string | URL) {
      const metadata = await fsStat(fsPath(path));
      return {
        isFile: metadata.isFile(),
        isDirectory: metadata.isDirectory(),
        mtime: metadata.mtime,
      };
    },
    async mkdir(path: string | URL, options?: { recursive?: boolean }) {
      await fsMkdir(fsPath(path), options);
    },
    async remove(path: string | URL, options?: { recursive?: boolean }) {
      await rm(fsPath(path), { recursive: options?.recursive === true });
    },
    async copyFile(from: string | URL, to: string | URL) {
      const destination = fsPath(to);
      if (shouldFailCopy(destination) === true) {
        throw new Error(`injected Deno copy failure for ${destination}`);
      }
      await fsCopyFile(fsPath(from), destination);
    },
    async rename(from: string | URL, to: string | URL) {
      await fsRename(fsPath(from), fsPath(to));
    },
  };
}

function fsPath(path: string | URL): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

const require = createRequire(import.meta.url);

function packageRoot(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
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
  await fsMkdir(dirname(path), { recursive: true });
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
  const stops = new Set(stopRoots.map((stopRoot) => resolve(stopRoot)));
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('native bindings', async () => {
  await main();
});
