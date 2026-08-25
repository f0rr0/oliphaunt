import assert from 'node:assert/strict';
import {
  mkdir as fsMkdir,
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import * as publicEntrypoint from '../index.js';
import Oliphaunt, { type OliphauntClient } from '../index.js';
import { resolveDenoNativeInstall } from '../native/assets-deno.js';
import { liboliphauntPackageTarget, nativeRuntimeLibraryEnvironment } from '../native/common.js';
import { createDenoNativeBinding } from '../native/deno.js';
import { nativeModuleSuffixForTarget } from '../native/extension-runtime.js';
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
import { createNodeNativeBinding } from '../native/node.js';
import { publishNativeDescriptor } from '../root-descriptor.js';
import { readTypeScriptPackageVersions } from './package-metadata.js';

async function main(): Promise<void> {
  testIndexExportsDefaultClient();
  testFfiLayoutPackingAndBounds();
  testPackagedRuntimeLibraryEnvironment();
  await testNodeNativeBindingUsesExplicitAssetsAndAddon();
  await testDenoAssetResolverHonorsExplicitPaths();
  await testDenoPackageManagedResolverUsesStandardCarrierRuntime();
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
  assert.equal(typeof (Oliphaunt as OliphauntClient).openServer, 'function');
  assert.equal(typeof (Oliphaunt as OliphauntClient).restore, 'function');
  for (const internalName of [
    'createOliphauntClient',
    'OliphauntDatabase',
    'nativeDirectCapabilities',
    'createDefaultNativeBinding',
    'createNodeNativeBinding',
    'createDenoNativeBinding',
  ]) {
    assert.equal(internalName in publicEntrypoint, false, `${internalName} must remain internal`);
  }
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
      moduleDirectory: '/tmp/modules',
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
  assert.ok(seenStrings.includes('/tmp/modules'));
  assert.ok(seenStrings.includes('work_mem=8MB'));
  assert.equal(packed.keepAlive.length, 8);
  const configView = new DataView(packed.config.buffer);
  assert.equal(configView.getUint32(0, true), 8);
  assert.notEqual(configView.getBigUint64(24, true), 0n);

  const restore = packRestoreOptionsPointers(
    {
      destination: '/tmp/root',
      bytes: new Uint8Array([1, 2, 3]),
    },
    pointerOf,
  );
  assert.equal(restore.options.byteLength, 32);
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
  const databaseRoot = join(root, 'database');
  const runtimeDirectory = join(root, 'runtime');
  const moduleDirectory = join(runtimeDirectory, 'lib/modules');
  const extensionDirectory = join(runtimeDirectory, 'share/postgresql/extension');
  const target = liboliphauntPackageTarget(process.platform, process.arch);
  await fsMkdir(moduleDirectory, { recursive: true });
  await fsMkdir(extensionDirectory, { recursive: true });
  await fsMkdir(join(databaseRoot, 'pgdata', 'global'), { recursive: true });
  await fsMkdir(join(databaseRoot, 'pgdata', 'pg_wal'));
  await writeFile(join(databaseRoot, 'pgdata', 'PG_VERSION'), '18\n');
  await writeFile(join(databaseRoot, 'pgdata', 'global', 'pg_control'), 'control');
  await publishNativeDescriptor(databaseRoot);
  await writeFile(join(extensionDirectory, 'hstore.control'), "default_version = '1.0'\n");
  await writeFile(join(extensionDirectory, 'hstore--1.0.sql'), 'SELECT 1;\n');
  await writeFile(
    join(moduleDirectory, `hstore${nativeModuleSuffixForTarget(target.id)}`),
    'native-module',
  );
  await writeFile(
    join(moduleDirectory, `dict_snowball${nativeModuleSuffixForTarget(target.id)}`),
    'native-module',
  );
  await writeFile(
    join(moduleDirectory, `plpgsql${nativeModuleSuffixForTarget(target.id)}`),
    'native-module',
  );
  await writeFile(
    addonPath,
    `
let nextHandle = 40n;
module.exports = {
  default: {
    open(config) {
      globalThis.__oliphauntNodeAddonCalls.push(['open', config]);
      nextHandle += 1n;
      return nextHandle;
    },
    execProtocolRaw(handle, request) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolRaw', handle, Array.from(request)]);
      return request.buffer.slice(request.byteOffset, request.byteOffset + request.byteLength);
    },
    execProtocolStream(handle, request, onChunk) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolStream', handle, Array.from(request)]);
      onChunk(request.slice());
    },
    execSimpleQuery(handle, sql) {
      globalThis.__oliphauntNodeAddonCalls.push(['execSimpleQuery', handle, sql]);
      return new Uint8Array([90, 0, 0, 0, 5, 73]);
    },
    async backup(handle) {
      globalThis.__oliphauntNodeAddonCalls.push(['backup', handle]);
      return new Uint8Array([4, 5, 6]).buffer;
    },
    async restore(options) {
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
    const handle = await binding.open({
      pgdata: join(databaseRoot, 'pgdata'),
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
    const chunks: Uint8Array[] = [];
    await binding.execProtocolStream(handle, new Uint8Array([9, 10]), (chunk) =>
      chunks.push(chunk),
    );
    assert.deepEqual(
      chunks.map((chunk) => [...chunk]),
      [[9, 10]],
    );
    const execSimpleQuery = binding.execSimpleQuery;
    assert.ok(execSimpleQuery !== undefined);
    assert.deepEqual([...(await execSimpleQuery(handle, 'SELECT 1'))], [90, 0, 0, 0, 5, 73]);
    assert.deepEqual([...(await binding.backup(handle))], [4, 5, 6]);
    await binding.restore({
      destination: join(root, 'restore'),
      bytes: new Uint8Array([1]),
    });
    binding.cancel(handle);
    binding.detach(handle);
    assert.deepEqual(
      calls.map((entry) => entry[0]),
      [
        'open',
        'execProtocolRaw',
        'execProtocolStream',
        'execSimpleQuery',
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
      catalogProfile: 'standard',
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
        if (text.endsWith('/OliphauntICU.bundle/manifest.properties')) {
          return `schema=oliphaunt-icu-data-v1\nartifactRole=icu-data\nicuDataVersion=76.1\nicuDataForm=files-le\nicuDataTreeSha256=${'a'.repeat(64)}\n`;
        }
        if (text.includes('@oliphaunt/icu')) {
          return JSON.stringify({
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
      async stat(path: string | URL) {
        return String(path).endsWith('/manifest.properties')
          ? { isFile: true, isDirectory: false }
          : { isFile: false, isDirectory: true };
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
        assert.deepEqual(definitions.oliphaunt_backup, {
          parameters: ['pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_restore, {
          parameters: ['buffer'],
          result: 'i32',
          nonblocking: true,
        });
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
      /Deno direct execution does not automatically materialize extension packages/,
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
      /Deno direct explicit runtimeDirectory is missing hstore.control/,
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
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-config-'));
  const databaseRoot = join(root, 'database');
  const runtime = join(root, 'runtime');
  const embeddedModules = join(runtime, 'lib/modules');
  const pointerStrings = new Map<bigint, string>();
  let nextPointer = 0x1000n;
  const calls: string[] = [];
  try {
    delete process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR;
    delete process.env.OLIPHAUNT_RUNTIME_DIR;
    delete process.env.LIBOLIPHAUNT_PATH;
    await fsMkdir(join(databaseRoot, 'pgdata', 'global'), { recursive: true });
    await fsMkdir(join(databaseRoot, 'pgdata', 'pg_wal'));
    await writeFile(join(databaseRoot, 'pgdata', 'PG_VERSION'), '18\n');
    await writeFile(join(databaseRoot, 'pgdata', 'global', 'pg_control'), 'control');
    await publishNativeDescriptor(databaseRoot);
    await fsMkdir(join(runtime, 'share/postgresql/extension'), {
      recursive: true,
    });
    await fsMkdir(join(runtime, 'lib/postgresql'), { recursive: true });
    await fsMkdir(embeddedModules, { recursive: true });
    await writeFile(join(runtime, 'share/postgresql/extension/hstore.control'), 'extension');
    await writeFile(join(runtime, 'share/postgresql/extension/hstore--1.0.sql'), 'install');
    await writeFile(join(runtime, 'lib/postgresql/hstore.so'), 'subprocess hstore');
    await writeFile(join(runtime, 'lib/postgresql/dict_snowball.so'), 'subprocess dict_snowball');
    await writeFile(join(runtime, 'lib/postgresql/plpgsql.so'), 'subprocess plpgsql');
    await writeFile(join(embeddedModules, 'hstore.so'), 'embedded hstore');
    await writeFile(join(embeddedModules, 'dict_snowball.so'), 'embedded dict_snowball');
    await writeFile(join(embeddedModules, 'plpgsql.so'), 'embedded plpgsql');

    const deno = fsBackedDenoRuntime(root) as Record<string, unknown>;
    (globalThis as { Deno?: unknown }).Deno = {
      ...deno,
      dlopen(_path: string, definitions: Record<string, unknown>) {
        assert.deepEqual(definitions.oliphaunt_init, {
          parameters: ['buffer', 'buffer'],
          result: 'i32',
        });
        assert.deepEqual(definitions.oliphaunt_backup, {
          parameters: ['pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_restore, {
          parameters: ['buffer'],
          result: 'i32',
          nonblocking: true,
        });
        return {
          symbols: {
            oliphaunt_init(config: Uint8Array, out: Uint8Array) {
              calls.push('init');
              assert.equal(process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR, undefined);
              const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
              assert.equal(view.getUint32(0, true), 8);
              assert.equal(pointerStrings.get(view.getBigUint64(24, true)), embeddedModules);
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

    const binding = await createDenoNativeBinding({
      libraryPath: join(root, 'liboliphaunt.so'),
    });
    const handle = await binding.open({
      pgdata: join(databaseRoot, 'pgdata'),
      runtimeDirectory: runtime,
      username: 'postgres',
      database: 'postgres',
      extensions: ['hstore'],
      startupArgs: [],
    });
    assert.deepEqual(handle, { address: 0x99n });
    assert.deepEqual(calls, ['init']);
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

async function testDenoPackageManagedResolverUsesStandardCarrierRuntime(): Promise<void> {
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const previousLibraryPath = process.env.LIBOLIPHAUNT_PATH;
  const previousRuntimeDir = process.env.OLIPHAUNT_RUNTIME_DIR;
  const target = liboliphauntPackageTarget('linux', 'x86_64');
  const runtimePackageRoot = packageRoot(target.packageName);
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-runtime-'));
  const createdFiles: string[] = [];
  try {
    delete process.env.LIBOLIPHAUNT_PATH;
    delete process.env.OLIPHAUNT_RUNTIME_DIR;
    (globalThis as { Deno?: unknown }).Deno = fsBackedDenoRuntime(root);

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
    const install = await resolveDenoNativeInstall();
    assert.equal(install.libraryPath, join(runtimePackageRoot, target.libraryRelativePath));
    assert.equal(install.packageManaged, true);
    assert.equal(install.runtimeDirectory, join(runtimePackageRoot, target.runtimeRelativePath));
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    restoreEnv('LIBOLIPHAUNT_PATH', previousLibraryPath);
    restoreEnv('OLIPHAUNT_RUNTIME_DIR', previousRuntimeDir);
    await rm(root, { recursive: true, force: true });
    await removeFixtureFiles(createdFiles, [runtimePackageRoot]);
  }
}

function fsBackedDenoRuntime(tempRoot: string): unknown {
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
    async *readDir(path: string | URL) {
      for (const entry of await readdir(fsPath(path), {
        withFileTypes: true,
      })) {
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
      };
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
    `schema=oliphaunt-runtime-resources-v1\nlayout=oliphaunt-cluster-seed-v1\nartifactRole=cluster-seed-${profile}\ncatalogProfile=${profile}\ntarget=${target}\npostgresMajor=18\nphysicalFormat=native-pg18-v1\ncompatibilityKey=native-pg18-${target}-v1\ninitialSuperuser=postgres\nicuDataVersion=${profile === 'icu' ? '76.1' : ''}\nicuDataForm=${profile === 'icu' ? 'files-le' : ''}\nicuDataTreeSha256=${profile === 'icu' ? 'a'.repeat(64) : ''}\nruntimeFeatures=${profile === 'icu' ? 'icu' : ''}\ncacheKey=fixture-seed\n`,
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

function nativeRuntimeToolsForTarget(target: string): string[] {
  return target === 'windows-x64-msvc'
    ? ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']
    : ['initdb', 'pg_ctl', 'postgres'];
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
