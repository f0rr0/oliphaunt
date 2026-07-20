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
import { liboliphauntPackageTarget, nativeRuntimeLibraryEnvironment } from '../native/common.js';
import { nativeModuleSuffixForTarget } from '../native/extension-runtime.js';
import { createDenoNativeBinding, invokeDenoInit } from '../native/deno.js';
import { invokeBunInit } from '../native/bun.js';
import {
  cString,
  OLIPHAUNT_CONFIG_SIZE,
  OLIPHAUNT_INIT_OPTIONS_SIZE,
  OLIPHAUNT_RESPONSE_SIZE,
  packConfigPointers,
  packInitOptionsPointers,
  packPointerArray,
  packRestoreOptionsPointers,
  readResponseLength,
  readResponsePointer,
  responseBuffer,
  writePointer,
} from '../native/ffi-layout.js';
import { readTypeScriptPackageVersions } from './package-metadata.js';

async function main(): Promise<void> {
  testIndexExportsDefaultClient();
  testFfiLayoutPackingAndBounds();
  testBunNativeInitUsesPerHandleModuleDirectory();
  testDenoNativeInitUsesPerHandleModuleDirectory();
  testPackagedRuntimeLibraryEnvironment();
  await testNodeNativeBindingUsesExplicitAssetsAndAddon();
  await testDenoAssetResolverHonorsExplicitPaths();
  await testDenoPackageManagedResolverPublishesRuntimeCacheAtomically();
  await testDenoNativeBindingRejectsPackageManagedExtensions();
  await testDenoNativeBindingUsesSeparateModuleDirectoryWithoutAmbientMutation();
}

function testPackagedRuntimeLibraryEnvironment(): void {
  const previous = Object.fromEntries(
    ['LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'PATH'].map((name) => [name, process.env[name]]),
  );
  try {
    process.env.LD_LIBRARY_PATH = '/existing/lib';
    assert.deepEqual(nativeRuntimeLibraryEnvironment('/candidate/runtime', 'linux'), {
      LD_LIBRARY_PATH: '/candidate/runtime/lib:/existing/lib',
    });
    process.env.LD_LIBRARY_PATH = '/candidate/runtime/lib:/existing/lib';
    assert.deepEqual(nativeRuntimeLibraryEnvironment('/candidate/runtime', 'linux'), {
      LD_LIBRARY_PATH: '/candidate/runtime/lib:/existing/lib',
    });

    process.env.DYLD_LIBRARY_PATH = '/candidate/runtime/lib:/existing/macos/lib';
    assert.deepEqual(nativeRuntimeLibraryEnvironment('/candidate/runtime', 'darwin'), {
      DYLD_LIBRARY_PATH: '/candidate/runtime/lib:/existing/macos/lib',
    });

    process.env.PATH = 'C:\\candidate\\runtime\\lib;C:\\existing\\bin;C:\\candidate\\runtime\\bin';
    assert.deepEqual(nativeRuntimeLibraryEnvironment('C:\\candidate\\runtime', 'win32'), {
      PATH: 'C:\\candidate\\runtime\\bin;C:\\candidate\\runtime\\lib;C:\\existing\\bin',
    });

    assert.deepEqual(nativeRuntimeLibraryEnvironment('   ', 'linux'), {});
    assert.throws(
      () => nativeRuntimeLibraryEnvironment('/candidate\0runtime', 'linux'),
      /NUL bytes/,
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

  const initOptions = packInitOptionsPointers('/tmp/modules', pointerOf);
  assert.equal(initOptions.options.byteLength, OLIPHAUNT_INIT_OPTIONS_SIZE);
  const initOptionsView = new DataView(initOptions.options.buffer);
  assert.equal(initOptionsView.getUint32(0, true), 1);
  assert.notEqual(initOptionsView.getBigUint64(8, true), 0n);
  assert.equal(initOptionsView.getBigUint64(16, true), 0n);
  assert.equal(initOptions.keepAlive.length, 1);
  assert.ok(seenStrings.includes('/tmp/modules'));
  assert.throws(() => packInitOptionsPointers('', pointerOf), /must not be empty/);

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

function testBunNativeInitUsesPerHandleModuleDirectory(): void {
  const calls: string[] = [];
  const symbols = {
    oliphaunt_init() {
      calls.push('init');
      return 0;
    },
    oliphaunt_init_ex(
      _config: Uint8Array,
      options: Uint8Array,
      _out: Uint8Array,
    ) {
      calls.push('init-ex');
      const view = new DataView(options.buffer, options.byteOffset, options.byteLength);
      assert.equal(view.getUint32(0, true), 1);
      assert.equal(view.getBigUint64(8, true), 0x1234n);
      assert.equal(view.getBigUint64(16, true), 0n);
      return 0;
    },
  };
  const config = new Uint8Array(OLIPHAUNT_CONFIG_SIZE);
  const out = new Uint8Array(8);
  const explicit = invokeBunInit({
    symbols,
    config,
    moduleDirectory: '/tmp/package-managed-modules',
    out,
    pointerOf: () => 0x1234n,
  });
  assert.equal(explicit.status, 0);
  assert.equal(explicit.keepAlive.length, 1);
  assert.deepEqual(calls, ['init-ex']);

  const legacy = invokeBunInit({
    symbols,
    config,
    out,
    pointerOf: () => 0x1234n,
  });
  assert.equal(legacy.status, 0);
  assert.deepEqual(legacy.keepAlive, []);
  assert.deepEqual(calls, ['init-ex', 'init']);
}

function testDenoNativeInitUsesPerHandleModuleDirectory(): void {
  const calls: string[] = [];
  const symbols = {
    oliphaunt_init() {
      calls.push('init');
      return 0;
    },
    oliphaunt_init_ex(
      _config: Uint8Array,
      options: Uint8Array,
      _out: Uint8Array,
    ) {
      calls.push('init-ex');
      const view = new DataView(options.buffer, options.byteOffset, options.byteLength);
      assert.equal(view.getUint32(0, true), 1);
      assert.equal(view.getBigUint64(8, true), 0x5678n);
      assert.equal(view.getBigUint64(16, true), 0n);
      return 0;
    },
  };
  const config = new Uint8Array(OLIPHAUNT_CONFIG_SIZE);
  const out = new Uint8Array(8);
  const explicit = invokeDenoInit({
    symbols,
    config,
    moduleDirectory: '/tmp/deno-prepared-runtime/lib/modules',
    out,
    pointerOf: () => 0x5678n,
  });
  assert.equal(explicit.status, 0);
  assert.equal(explicit.keepAlive.length, 1);
  assert.deepEqual(calls, ['init-ex']);

  const legacy = invokeDenoInit({
    symbols,
    config,
    out,
    pointerOf: () => 0x5678n,
  });
  assert.equal(legacy.status, 0);
  assert.deepEqual(legacy.keepAlive, []);
  assert.deepEqual(calls, ['init-ex', 'init']);
}

async function testNodeNativeBindingUsesExplicitAssetsAndAddon(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-node-binding-'));
  const addonPath = join(root, 'mock-addon.cjs');
  const runtimeDirectory = join(root, 'runtime');
  const moduleDirectory = join(runtimeDirectory, 'lib/postgresql');
  const extensionDirectory = join(runtimeDirectory, 'share/postgresql/extension');
  const target = liboliphauntPackageTarget(process.platform, process.arch);
  await fsMkdir(moduleDirectory, { recursive: true });
  await fsMkdir(extensionDirectory, { recursive: true });
  await writeFile(join(extensionDirectory, 'hstore.control'), "default_version = '1.0'\n");
  await writeFile(join(extensionDirectory, 'hstore--1.0.sql'), 'SELECT 1;\n');
  await writeFile(
    join(moduleDirectory, `hstore${nativeModuleSuffixForTarget(target.id)}`),
    'native-module',
  );
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
  const previousModuleDirectory = process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR;
  const callerModuleDirectory = join(root, 'caller-owned-modules');
  process.env.OLIPHAUNT_RUNTIME_DIR = runtimeDirectory;
  process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR = callerModuleDirectory;
  try {
    const binding = await createNodeNativeBinding({
      libraryPath: join(root, 'liboliphaunt.dylib'),
      nodeAddonPath: addonPath,
    });
    assert.equal(binding.runtime, 'node');
    assert.equal(binding.rawProtocolTransport, 'node-addon');
    assert.equal(binding.protocolStream, true);
    assert.equal(binding.defaultRuntimeDirectory, runtimeDirectory);
    assert.equal(binding.version(), '18.4-test');
    assert.equal(binding.capabilities(), 195n);

    const handle = await binding.open({
      pgdata: join(root, 'pgdata'),
      username: 'postgres',
      database: 'postgres',
      extensions: ['hstore'],
      startupArgs: [],
    });
    assert.equal(handle, 41n);
    const openConfig = calls.find(([name]) => name === 'open')?.[1] as
      | { moduleDirectory?: string; runtimeDirectory?: string }
      | undefined;
    assert.equal(openConfig?.runtimeDirectory, runtimeDirectory);
    assert.equal(openConfig?.moduleDirectory, moduleDirectory);
    assert.equal(process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR, callerModuleDirectory);
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
    restoreEnv('OLIPHAUNT_EMBEDDED_MODULE_DIR', previousModuleDirectory);
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
  const { liboliphauntVersion, icuVersion } = await readTypeScriptPackageVersions();
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
            version: icuVersion,
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
            liboliphauntVersion,
            icuPackage: '@oliphaunt/icu',
            icuVersion,
          },
        });
      },
      async stat() {
        return { isDirectory: true };
      },
      async *readDir() {
        yield { name: 'icudt76l.dat', isFile: true };
      },
      dlopen(path: string, definitions: Record<string, unknown>) {
        calls.push(`dlopen:${path}`);
        assert.deepEqual(definitions.oliphaunt_init, {
          parameters: ['buffer', 'buffer'],
          result: 'i32',
        });
        assert.deepEqual(definitions.oliphaunt_init_ex, {
          parameters: ['buffer', 'buffer', 'buffer'],
          result: 'i32',
        });
        return {
          symbols: {
            oliphaunt_init() {
              calls.push('init');
              return 0;
            },
            oliphaunt_init_ex() {
              calls.push('init-ex');
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
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open({
            pgdata: '/tmp/deno-pgdata',
            runtimeDirectory: undefined,
            username: 'postgres',
            database: 'postgres',
            extensions: ['hstore'],
            startupArgs: [],
          }),
        ),
      /Deno nativeDirect does not automatically materialize extension packages/,
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open({
            pgdata: '/tmp/deno-pgdata',
            runtimeDirectory: '/tmp/deno-prepared-runtime',
            username: 'postgres',
            database: 'postgres',
            extensions: ['hstore'],
            startupArgs: [],
          }),
        ),
      /Deno nativeDirect explicit runtimeDirectory is missing hstore.control/,
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

async function testDenoNativeBindingUsesSeparateModuleDirectoryWithoutAmbientMutation(): Promise<void> {
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const previousModuleDirectory = process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR;
  const previousRuntime = process.env.OLIPHAUNT_RUNTIME_DIR;
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousLibrarySearchPath = process.env.LD_LIBRARY_PATH;
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-init-ex-'));
  const runtime = join(root, 'runtime');
  const embeddedModules = join(runtime, 'lib/modules');
  const pointerStrings = new Map<bigint, string>();
  let nextPointer = 0x1000n;
  const calls: string[] = [];
  try {
    delete process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR;
    delete process.env.OLIPHAUNT_RUNTIME_DIR;
    delete process.env.LIBOLIPHAUNT_PATH;
    await fsMkdir(join(runtime, 'share/postgresql/extension'), { recursive: true });
    await fsMkdir(join(runtime, 'lib/postgresql'), { recursive: true });
    await fsMkdir(embeddedModules, { recursive: true });
    await writeFile(join(runtime, 'share/postgresql/extension/hstore.control'), 'extension');
    await writeFile(join(runtime, 'share/postgresql/extension/hstore--1.0.sql'), 'install');
    await writeFile(join(runtime, 'lib/postgresql/hstore.so'), 'subprocess hstore');
    await writeFile(join(runtime, 'lib/postgresql/plpgsql.so'), 'subprocess plpgsql');
    await writeFile(join(embeddedModules, 'hstore.so'), 'embedded hstore');
    await writeFile(join(embeddedModules, 'plpgsql.so'), 'embedded plpgsql');

    const deno = fsBackedDenoRuntime(root, () => false) as Record<string, unknown>;
    (globalThis as { Deno?: unknown }).Deno = {
      ...deno,
      dlopen(_path: string, definitions: Record<string, unknown>) {
        assert.deepEqual(definitions.oliphaunt_init_ex, {
          parameters: ['buffer', 'buffer', 'buffer'],
          result: 'i32',
        });
        return {
          symbols: {
            oliphaunt_init() {
              calls.push('init');
              return 0;
            },
            oliphaunt_init_ex(
              _config: Uint8Array,
              options: Uint8Array,
              out: Uint8Array,
            ) {
              calls.push('init-ex');
              assert.equal(process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR, undefined);
              const view = new DataView(options.buffer, options.byteOffset, options.byteLength);
              assert.equal(view.getUint32(0, true), 1);
              assert.equal(pointerStrings.get(view.getBigUint64(8, true)), embeddedModules);
              assert.equal(view.getBigUint64(16, true), 0n);
              new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(0, 0x99n, true);
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
        of(value: Uint8Array) {
          nextPointer += 0x10n;
          pointerStrings.set(
            nextPointer,
            new TextDecoder().decode(value.subarray(0, Math.max(0, value.byteLength - 1))),
          );
          return { address: nextPointer };
        },
        value(pointer: { address: bigint }) {
          return pointer.address;
        },
        create(address: bigint) {
          return { address };
        },
      },
      UnsafePointerView: class {},
    };

    const binding = await createDenoNativeBinding({ libraryPath: join(root, 'liboliphaunt.so') });
    const handle = await binding.open({
      pgdata: join(root, 'pgdata'),
      runtimeDirectory: runtime,
      username: 'postgres',
      database: 'postgres',
      extensions: ['hstore'],
      startupArgs: [],
    });
    assert.deepEqual(handle, { address: 0x99n });
    assert.deepEqual(calls, ['init-ex']);
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    restoreEnv('OLIPHAUNT_EMBEDDED_MODULE_DIR', previousModuleDirectory);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntime);
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('LD_LIBRARY_PATH', previousLibrarySearchPath);
    await rm(root, { recursive: true, force: true });
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
