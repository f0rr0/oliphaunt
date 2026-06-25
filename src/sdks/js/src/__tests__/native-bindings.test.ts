import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Oliphaunt, { createNodeNativeBinding, simpleQuery, type OliphauntClient } from '../index.js';
import { resolveDenoNativeInstall } from '../native/assets-deno.js';
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
    assert.deepEqual(
      [...(await binding.execSimpleQuery!(handle, 'SELECT 1'))],
      [90, 0, 0, 0, 5, 73],
    );
    const chunks: number[][] = [];
    binding.execProtocolStream!(handle, new Uint8Array([9]), (chunk) => chunks.push([...chunk]));
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

test('native bindings', async () => {
  await main();
});
