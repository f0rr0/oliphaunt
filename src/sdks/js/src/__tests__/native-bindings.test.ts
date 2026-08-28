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
import { test, vi } from 'vitest';
import * as publicEntrypoint from '../index.js';
import Oliphaunt, { type OliphauntClient } from '../index.js';
import { resolveDenoNativeInstall } from '../native/assets-deno.js';
import {
  ABI_VERSION,
  liboliphauntPackageTarget,
  nativeRuntimeLibraryEnvironment,
} from '../native/common.js';
import { createDenoNativeBinding } from '../native/deno.js';
import { nativeModuleSuffixForTarget } from '../native/extension-runtime.js';
import {
  cString,
  errorCaptureBuffer,
  OLIPHAUNT_CONFIG_SIZE,
  OLIPHAUNT_ERROR_CAPTURE_CAPACITY,
  OLIPHAUNT_ERROR_CAPTURE_SIZE,
  OLIPHAUNT_RESPONSE_SIZE,
  packConfigPointers,
  packPointerArray,
  packRestoreOptionsPointers,
  readResponseLength,
  readResponsePointer,
  readErrorCapture,
  responseBuffer,
  writePointer,
} from '../native/ffi-layout.js';
import { createNodeNativeBinding } from '../native/node.js';
import { publishNativeDescriptor } from '../root-descriptor.js';
import { directRuntimeBinding } from '../runtime/direct.js';
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

  const emptyCapture = errorCaptureBuffer();
  assert.equal(emptyCapture.byteLength, OLIPHAUNT_ERROR_CAPTURE_SIZE);
  assert.equal(OLIPHAUNT_ERROR_CAPTURE_CAPACITY, 1024);
  assert.equal(readErrorCapture(emptyCapture), null);
  const capturedText = new TextEncoder().encode('operation-local failure');
  new DataView(emptyCapture.buffer).setUint32(0, capturedText.byteLength, true);
  emptyCapture.set(capturedText, 4);
  assert.equal(readErrorCapture(emptyCapture), 'operation-local failure');
  emptyCapture[4 + capturedText.byteLength] = 1;
  assert.match(readErrorCapture(emptyCapture) ?? '', /invalid error capture/);
  const invalidLengthCapture = errorCaptureBuffer();
  new DataView(invalidLengthCapture.buffer).setUint32(0, OLIPHAUNT_ERROR_CAPTURE_CAPACITY, true);
  assert.match(readErrorCapture(invalidLengthCapture) ?? '', /invalid error capture/);
  const embeddedNulCapture = errorCaptureBuffer();
  new DataView(embeddedNulCapture.buffer).setUint32(0, 3, true);
  embeddedNulCapture.set([0x61, 0, 0x62], 4);
  assert.match(readErrorCapture(embeddedNulCapture) ?? '', /invalid error capture/);
  assert.match(readErrorCapture(new Uint8Array(4)) ?? '', /invalid error capture/);

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
  assert.equal(configView.getUint32(0, true), ABI_VERSION);
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
  const previousFinalizationRegistry = globalThis.FinalizationRegistry;
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
    async open(config) {
      globalThis.__oliphauntNodeAddonCalls.push(['open', config]);
      nextHandle += 1n;
      return nextHandle;
    },
    execProtocolRaw(handle, request) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolRaw', handle, Array.from(request)]);
      return request.buffer.slice(request.byteOffset, request.byteOffset + request.byteLength);
    },
    async execProtocolRawStream(handle, request, onChunk) {
      globalThis.__oliphauntNodeAddonCalls.push(['execProtocolRawStream', handle, Array.from(request)]);
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
    async detach(handle) {
      globalThis.__oliphauntNodeAddonCalls.push(['detach', handle]);
    },
    createForgottenHandleRecoveryToken(handle) {
      const token = 'recovery-token:' + handle;
      globalThis.__oliphauntNodeAddonCalls.push(['createForgottenHandleRecoveryToken', handle, token]);
      return token;
    },
    queueForgottenHandleRecovery(token) {
      globalThis.__oliphauntNodeAddonCalls.push(['queueForgottenHandleRecovery', token]);
      return token !== 'stale-recovery-token';
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
  type NodeForgottenHandle = {
    readonly recoveryToken: unknown;
    readonly releaseOwnership: () => void;
  };
  let finalizer: ((held: NodeForgottenHandle) => void) | undefined;
  let registered: { target: object; held: NodeForgottenHandle; token?: object } | undefined;
  const unregistered: object[] = [];
  process.env.OLIPHAUNT_RUNTIME_DIR = runtimeDirectory;
  process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR = callerModuleDirectory;
  try {
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry = class {
      constructor(callback: (held: NodeForgottenHandle) => void) {
        finalizer = callback;
      }

      register(target: object, held: NodeForgottenHandle, token?: object): void {
        registered = { target, held, token };
      }

      unregister(token: object): boolean {
        unregistered.push(token);
        return true;
      }
    };
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
    await binding.cancel(handle);

    const forgottenOwner = {};
    let released = 0;
    binding.registerForgottenHandleCleanup?.(forgottenOwner, handle, () => {
      released += 1;
    });
    assert.equal(registered?.target, forgottenOwner);
    assert.equal(registered?.token, forgottenOwner);
    assert.equal(registered?.held.recoveryToken, 'recovery-token:41');
    finalizer?.(registered!.held);
    assert.equal(released, 1);
    let unsafeRelease = 0;
    finalizer?.({
      recoveryToken: 'stale-recovery-token',
      releaseOwnership: () => {
        unsafeRelease += 1;
      },
    });
    assert.equal(unsafeRelease, 0, 'native recovery rejection must keep admission closed');

    const explicitlyClosedOwner = {};
    binding.registerForgottenHandleCleanup?.(explicitlyClosedOwner, handle, () => {});
    await binding.detach(handle);
    binding.unregisterForgottenHandleCleanup?.(explicitlyClosedOwner);
    assert.deepEqual(unregistered, [explicitlyClosedOwner]);
    assert.deepEqual(
      calls.map((entry) => entry[0]),
      [
        'open',
        'execProtocolRaw',
        'execProtocolRawStream',
        'execSimpleQuery',
        'backup',
        'restore',
        'cancel',
        'createForgottenHandleRecoveryToken',
        'queueForgottenHandleRecovery',
        'queueForgottenHandleRecovery',
        'createForgottenHandleRecoveryToken',
        'detach',
      ],
    );
  } finally {
    if (previousRuntime === undefined) {
      delete process.env.OLIPHAUNT_RUNTIME_DIR;
    } else {
      process.env.OLIPHAUNT_RUNTIME_DIR = previousRuntime;
    }
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry =
      previousFinalizationRegistry;
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
        assert.deepEqual(definitions.oliphaunt_init_with_error, {
          parameters: ['buffer', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_exec_protocol_with_error, {
          parameters: ['pointer', 'buffer', 'usize', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_exec_simple_query_with_error, {
          parameters: ['pointer', 'buffer', 'usize', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_exec_protocol_raw_stream_with_error, {
          parameters: ['pointer', 'buffer', 'usize', 'function', 'pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_detach_with_error, {
          parameters: ['pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_logical_generation, {
          parameters: ['pointer'],
          result: 'u64',
        });
        assert.deepEqual(definitions.oliphaunt_close_if_generation, {
          parameters: ['u64'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_copy_last_error, {
          parameters: ['pointer', 'buffer', 'usize'],
          result: 'usize',
        });
        assert.deepEqual(definitions.oliphaunt_backup_with_error, {
          parameters: ['pointer', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_restore_with_error, {
          parameters: ['buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        return {
          symbols: {
            oliphaunt_init_with_error() {
              calls.push('init');
              return 0;
            },
            oliphaunt_exec_protocol_with_error() {
              return 0;
            },
            oliphaunt_exec_simple_query_with_error() {
              return 0;
            },
            oliphaunt_backup_with_error() {
              return 0;
            },
            oliphaunt_restore_with_error() {
              return 0;
            },
            oliphaunt_cancel() {
              return 0;
            },
            oliphaunt_detach_with_error() {
              return 0;
            },
            oliphaunt_logical_generation() {
              return 1n;
            },
            oliphaunt_close_if_generation() {
              return 1;
            },
            oliphaunt_copy_last_error(_handle: unknown, output: Uint8Array) {
              output.fill(0);
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
  const previousFinalizationRegistry = globalThis.FinalizationRegistry;
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
  let copyLastErrorCalls = 0;
  let restoreCallsStartedResolve: (() => void) | undefined;
  let releaseRestoreCalls: (() => void) | undefined;
  let restoreCallCount = 0;
  let rejectInit = false;
  let initFailure: unknown;
  let initStatus = 0;
  let initHandleAddress = 0x99n;
  let logicalGeneration = 23n;
  let rejectDetach = false;
  let detachFailure: unknown;
  let generationCleanupStatus = 1;
  const restoreCallsStarted = new Promise<void>((resolve) => {
    restoreCallsStartedResolve = resolve;
  });
  const restoreCallsMayFinish = new Promise<void>((resolve) => {
    releaseRestoreCalls = resolve;
  });
  let finalizer: ((held: { generation: bigint; releaseOwnership: () => void }) => void) | undefined;
  let registered:
    | {
        target: object;
        held: { generation: bigint; releaseOwnership: () => void };
        token?: object;
      }
    | undefined;
  const unregistered: object[] = [];
  try {
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry = class {
      constructor(callback: (held: { generation: bigint; releaseOwnership: () => void }) => void) {
        finalizer = callback;
      }

      register(
        target: object,
        held: { generation: bigint; releaseOwnership: () => void },
        token?: object,
      ): void {
        registered = { target, held, token };
      }

      unregister(token: object): boolean {
        unregistered.push(token);
        return true;
      }
    };
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
        assert.deepEqual(definitions.oliphaunt_init_with_error, {
          parameters: ['buffer', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_exec_protocol_raw_stream_with_error, {
          parameters: ['pointer', 'buffer', 'usize', 'function', 'pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_detach_with_error, {
          parameters: ['pointer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_logical_generation, {
          parameters: ['pointer'],
          result: 'u64',
        });
        assert.deepEqual(definitions.oliphaunt_close_if_generation, {
          parameters: ['u64'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_copy_last_error, {
          parameters: ['pointer', 'buffer', 'usize'],
          result: 'usize',
        });
        assert.deepEqual(definitions.oliphaunt_backup_with_error, {
          parameters: ['pointer', 'buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        assert.deepEqual(definitions.oliphaunt_restore_with_error, {
          parameters: ['buffer', 'buffer'],
          result: 'i32',
          nonblocking: true,
        });
        return {
          symbols: {
            async oliphaunt_init_with_error(config: Uint8Array, out: Uint8Array) {
              calls.push('init');
              if (rejectInit) throw initFailure;
              assert.equal(process.env.OLIPHAUNT_EMBEDDED_MODULE_DIR, undefined);
              const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
              assert.equal(view.getUint32(0, true), ABI_VERSION);
              assert.equal(pointerStrings.get(view.getBigUint64(24, true)), embeddedModules);
              new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
                0,
                initHandleAddress,
                true,
              );
              return initStatus;
            },
            oliphaunt_exec_protocol_with_error() {
              return 0;
            },
            oliphaunt_exec_protocol_raw_stream_with_error(
              _handle: unknown,
              request: Uint8Array,
              _requestLength: bigint,
              callback: (context: unknown, bytes: unknown, length: bigint) => number,
              context: unknown,
              captured: Uint8Array,
            ) {
              const callbackStatus = callback(context, null, 0n);
              if (request[0] === 4) {
                assert.equal(callbackStatus, 0);
                return 1;
              }
              assert.equal(callbackStatus, 1);
              if (request[0] === 3) return 0;
              if (request[0] === 1) {
                writeErrorCapture(captured, 'stream callback aborted after confirmed recovery');
                return 1;
              }
              writeErrorCapture(captured, 'stream transport recovery failed');
              return -1;
            },
            oliphaunt_exec_simple_query_with_error() {
              return 0;
            },
            oliphaunt_backup_with_error() {
              return 0;
            },
            async oliphaunt_restore_with_error(options: Uint8Array, captured: Uint8Array) {
              const view = new DataView(options.buffer, options.byteOffset, options.byteLength);
              const destination = pointerStrings.get(view.getBigUint64(8, true));
              assert.ok(destination);
              restoreCallCount += 1;
              if (restoreCallCount === 2) restoreCallsStartedResolve?.();
              await restoreCallsMayFinish;
              writeErrorCapture(captured, `${destination} failed on its native worker`);
              return -1;
            },
            oliphaunt_cancel() {
              return 0;
            },
            async oliphaunt_detach_with_error(_handle: unknown, _captured: Uint8Array) {
              calls.push('detach');
              if (rejectDetach) throw detachFailure;
              return 0;
            },
            oliphaunt_logical_generation() {
              calls.push('logical-generation');
              return logicalGeneration;
            },
            oliphaunt_close_if_generation(generation: bigint) {
              calls.push(`close-generation:${generation}`);
              return generationCleanupStatus;
            },
            oliphaunt_copy_last_error(_handle: unknown, output: Uint8Array) {
              copyLastErrorCalls += 1;
              output.fill(0);
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
      UnsafeCallback: {
        threadSafe(_definition: unknown, callback: unknown) {
          return {
            pointer: callback,
            close() {},
          };
        },
      },
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
    assert.deepEqual(calls, ['init', 'logical-generation']);

    await assert.rejects(
      () =>
        binding.execProtocolStream(handle, new Uint8Array([1]), () => {
          throw new Error('Deno stream callback failed');
        }),
      /Deno stream callback failed/,
    );
    const undefinedCallbackFailure = await binding
      .execProtocolStream(handle, new Uint8Array([1]), () => {
        throw undefined;
      })
      .then(
        () => ({ fulfilled: true as const, error: undefined }),
        (error: unknown) => ({ fulfilled: false as const, error }),
      );
    assert.equal(undefinedCallbackFailure.fulfilled, false);
    assert.equal(
      undefinedCallbackFailure.error,
      undefined,
      'a recovered Deno callback abort must preserve even an undefined rejection reason',
    );
    await assert.rejects(
      () =>
        binding.execProtocolStream(handle, new Uint8Array([3]), () => {
          throw undefined;
        }),
      /reported success after the callback failed/,
    );
    await assert.rejects(
      () => binding.execProtocolStream(handle, new Uint8Array([4]), () => undefined),
      /reported a recovered callback abort without a callback failure/,
    );
    await assert.rejects(
      () =>
        binding.execProtocolStream(handle, new Uint8Array([2]), () => {
          throw new Error('this callback failure must not mask native recovery');
        }),
      /stream transport recovery failed/,
    );

    const firstRestore = binding.restore({
      destination: '/tmp/first-restore',
      bytes: new Uint8Array([1]),
    });
    const secondRestore = binding.restore({
      destination: '/tmp/second-restore',
      bytes: new Uint8Array([2]),
    });
    await restoreCallsStarted;
    releaseRestoreCalls?.();
    const restoreResults = await Promise.allSettled([firstRestore, secondRestore]);
    assert.equal(restoreResults[0]?.status, 'rejected');
    assert.equal(restoreResults[1]?.status, 'rejected');
    assert.match(
      String((restoreResults[0] as PromiseRejectedResult).reason),
      /\/tmp\/first-restore failed on its native worker/,
    );
    assert.match(
      String((restoreResults[1] as PromiseRejectedResult).reason),
      /\/tmp\/second-restore failed on its native worker/,
    );
    assert.equal(
      copyLastErrorCalls,
      0,
      'nonblocking Deno failures must not read worker-local errors later on the JS thread',
    );

    const forgottenOwner = {};
    let released = 0;
    binding.registerForgottenHandleCleanup?.(forgottenOwner, handle, () => {
      released += 1;
    });
    assert.equal(registered?.target, forgottenOwner);
    assert.equal(registered?.token, forgottenOwner);
    assert.equal(registered?.held.generation, 23n);
    finalizer?.(registered!.held);
    assert.equal(released, 0, 'the finalizer must return before native cleanup settles');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, 1);
    assert.deepEqual(calls, ['init', 'logical-generation', 'close-generation:23']);

    const failedCleanupOwner = {};
    let releasedAfterFailedCleanup = 0;
    generationCleanupStatus = -1;
    binding.registerForgottenHandleCleanup?.(failedCleanupOwner, handle, () => {
      releasedAfterFailedCleanup += 1;
    });
    finalizer?.(registered!.held);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      releasedAfterFailedCleanup,
      0,
      'failed native generation cleanup must keep direct admission closed',
    );
    assert.equal(calls.at(-1), 'close-generation:23');

    const explicitlyClosedOwner = {};
    binding.registerForgottenHandleCleanup?.(explicitlyClosedOwner, handle, () => {});
    await binding.detach(handle);
    binding.unregisterForgottenHandleCleanup?.(explicitlyClosedOwner);
    assert.deepEqual(unregistered, [explicitlyClosedOwner]);
    assert.equal(calls.at(-1), 'detach');

    calls.length = 0;
    const openConfig = {
      pgdata: join(databaseRoot, 'pgdata'),
      runtimeDirectory: runtime,
      username: 'postgres',
      database: 'postgres',
      extensions: ['hstore'],
      startupArgs: [],
    };

    const uncertainHandle = await binding.open(openConfig);
    rejectDetach = true;
    detachFailure = new Error('Deno detach worker delivery rejected');
    const uncertainClose = await directRuntimeBinding(binding).close(uncertainHandle);
    assert.equal(uncertainClose.state, 'terminal');
    assert.match(
      String(uncertainClose.error),
      /detach delivery failed after its outcome became unknown/,
    );
    assert.equal((uncertainClose.error as Error).cause, detachFailure);
    await assert.rejects(
      () => binding.detach(uncertainHandle),
      (error: unknown) => error === uncertainClose.error,
    );
    await assert.rejects(
      () => binding.open(openConfig),
      /prior native lifecycle outcome left ownership unknown/,
    );
    assert.deepEqual(
      calls,
      ['init', 'logical-generation', 'detach'],
      'an outcome-unknown detach is terminal, cannot be retried, and closes admission before another init',
    );

    const createFreshBinding = async () => {
      vi.resetModules();
      const freshDeno = await import('../native/deno.js');
      return freshDeno.createDenoNativeBinding({
        libraryPath: join(root, 'liboliphaunt.so'),
      });
    };

    calls.length = 0;
    rejectInit = false;
    initStatus = -1;
    initHandleAddress = 0x99n;
    logicalGeneration = 23n;
    rejectDetach = false;
    detachFailure = undefined;
    let freshBinding = await createFreshBinding();
    await assert.rejects(() => freshBinding.open(openConfig), /native liboliphaunt init failed/);
    initStatus = 0;
    const retryHandle = await freshBinding.open(openConfig);
    await freshBinding.detach(retryHandle);
    assert.deepEqual(
      calls,
      ['init', 'init', 'logical-generation', 'detach'],
      'a confirmed nonzero init status remains retryable',
    );

    calls.length = 0;
    rejectInit = true;
    initStatus = 0;
    initFailure = new Error('Deno init worker delivery rejected');
    rejectDetach = false;
    detachFailure = undefined;
    initHandleAddress = 0x99n;
    logicalGeneration = 23n;
    freshBinding = await createFreshBinding();
    await assert.rejects(
      () => freshBinding.open(openConfig),
      (error) => error === initFailure,
    );
    await assert.rejects(
      () => freshBinding.open(openConfig),
      /prior native lifecycle outcome left ownership unknown/,
    );
    assert.deepEqual(calls, ['init'], 'a rejected init worker must close admission immediately');

    calls.length = 0;
    rejectInit = false;
    initHandleAddress = 0n;
    freshBinding = await createFreshBinding();
    await assert.rejects(() => freshBinding.open(openConfig), /init returned a null handle/);
    await assert.rejects(
      () => freshBinding.open(openConfig),
      /prior native lifecycle outcome left ownership unknown/,
    );
    assert.deepEqual(calls, ['init'], 'a null successful init must close admission immediately');

    calls.length = 0;
    initHandleAddress = 0x99n;
    logicalGeneration = 0n;
    freshBinding = await createFreshBinding();
    await assert.rejects(() => freshBinding.open(openConfig), /invalid logical generation/);
    await assert.rejects(
      () => freshBinding.open(openConfig),
      /prior native lifecycle outcome left ownership unknown/,
    );
    assert.deepEqual(
      calls,
      ['init', 'logical-generation'],
      'an invalid generation must close admission without dereferencing the handle',
    );
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry =
      previousFinalizationRegistry;
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

function writeErrorCapture(capture: Uint8Array, message: string): void {
  capture.fill(0);
  const bytes = new TextEncoder().encode(message);
  assert.ok(bytes.byteLength < OLIPHAUNT_ERROR_CAPTURE_CAPACITY);
  new DataView(capture.buffer, capture.byteOffset, capture.byteLength).setUint32(
    0,
    bytes.byteLength,
    true,
  );
  capture.set(bytes, 4);
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
