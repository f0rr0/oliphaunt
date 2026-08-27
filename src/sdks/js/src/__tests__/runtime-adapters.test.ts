import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createBrokerRuntimeBinding } from '../runtime/broker.js';
import { createForgottenRuntimeHandleCleanup } from '../runtime/forgotten-handle.js';
import { parseReadyEndpoint, randomHexToken, unixSocketPathsFit } from '../runtime/node-adapter.js';
import {
  encodeCancelRequest,
  encodeStartupMessage,
  parseBackendKeyData,
} from '../runtime/pgwire.js';
import { createServerRuntimeBinding } from '../runtime/server.js';

// liboliphaunt-doc-example:typescript-open-server
test('runtime adapters implement the shared internal operation boundary', async () => {
  const broker = createBrokerRuntimeBinding();
  assert.equal(typeof broker.open, 'function');
  assert.equal(typeof broker.execProtocolRaw, 'function');
  assert.equal(typeof broker.backup, 'function');
  assert.equal(typeof broker.cancel, 'function');
  assert.equal(typeof broker.close, 'function');
  assert.equal(typeof broker.registerForgottenHandleCleanup, 'function');
  assert.equal(typeof broker.unregisterForgottenHandleCleanup, 'function');

  const server = createServerRuntimeBinding();
  assert.equal(typeof server.open, 'function');
  assert.equal(typeof server.execProtocolRaw, 'function');
  assert.equal(server.backup, undefined);
  assert.equal(typeof server.connectionString, 'function');
  assert.equal(typeof server.registerForgottenHandleCleanup, 'function');
  assert.equal(typeof server.unregisterForgottenHandleCleanup, 'function');

  const brokerFailure = await broker.close({});
  assert.equal(brokerFailure.state, 'terminal');
  const serverFailure = await server.close({});
  assert.equal(serverFailure.state, 'terminal');
});

test('runtime finalizers carry only exact handles and ignore stale generations', async () => {
  const previousFinalizationRegistry = globalThis.FinalizationRegistry;
  type Handle = { readonly id: number };
  type Held = {
    readonly handle: Handle;
    readonly generation: { state: 'active' | 'claimed' | 'retired' };
  };
  let finalizer: ((held: Held) => void) | undefined;
  const registrations: Array<{ target: object; held: Held; token?: object }> = [];
  const unregistered: object[] = [];
  try {
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry = class {
      constructor(callback: (held: Held) => void) {
        finalizer = callback;
      }

      register(target: object, held: Held, token?: object): void {
        registrations.push({ target, held, token });
      }

      unregister(token: object): boolean {
        unregistered.push(token);
        return true;
      }
    };

    const cleaned: Handle[] = [];
    const cleanup = createForgottenRuntimeHandleCleanup<Handle>(async (handle) => {
      cleaned.push(handle);
    });
    const handle = { id: 7 };
    const forgottenOwner = {};
    cleanup.register(forgottenOwner, handle);
    const forgotten = registrations.at(-1);
    assert.ok(forgotten !== undefined);
    assert.equal(forgotten.target, forgottenOwner);
    assert.equal(forgotten.token, forgottenOwner);
    assert.deepEqual(Object.keys(forgotten.held).sort(), ['generation', 'handle']);
    assert.equal(forgotten.held.handle, handle);

    finalizer?.(forgotten.held);
    assert.deepEqual(cleaned, [], 'teardown must not run in the finalizer job');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleaned, [handle]);
    finalizer?.(forgotten.held);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleaned, [handle], 'one generation cleans up at most once');

    const explicitlyClosedOwner = {};
    cleanup.register(explicitlyClosedOwner, handle);
    const explicitlyClosed = registrations.at(-1);
    assert.ok(explicitlyClosed !== undefined);
    cleanup.unregister(explicitlyClosedOwner);
    finalizer?.(explicitlyClosed.held);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleaned, [handle], 'unregistered generations are stale');
    assert.deepEqual(unregistered, [explicitlyClosedOwner]);

    const supersededOwner = {};
    cleanup.register(supersededOwner, handle);
    const superseded = registrations.at(-1);
    assert.ok(superseded !== undefined);
    const currentOwner = {};
    cleanup.register(currentOwner, handle);
    const current = registrations.at(-1);
    assert.ok(current !== undefined);
    finalizer?.(superseded.held);
    finalizer?.(current.held);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cleaned, [handle, handle]);
  } finally {
    (globalThis as { FinalizationRegistry: unknown }).FinalizationRegistry =
      previousFinalizationRegistry;
  }
});

test('node adapter validates local endpoints and socket path limits', () => {
  assert.deepEqual(parseReadyEndpoint('tcp:127.0.0.1:15432'), {
    kind: 'tcp',
    host: '127.0.0.1',
    port: 15432,
  });
  assert.deepEqual(parseReadyEndpoint('unix:/tmp/oliphaunt.sock'), {
    kind: 'unix',
    path: '/tmp/oliphaunt.sock',
  });
  assert.throws(() => parseReadyEndpoint('http://localhost'), /endpoint/);
  assert.equal(unixSocketPathsFit('/tmp/oliphaunt.sock'), true);
  assert.equal(unixSocketPathsFit(`/tmp/${'x'.repeat(110)}`), false);
  assert.match(randomHexToken(), /^[0-9a-f]+$/u);
});

test('server wire uses PostgreSQL v3 startup and cancel packets', () => {
  const startup = encodeStartupMessage('app user', 'app/db');
  assert.equal(readI32(startup, 4), 196_608);
  const startupText = new TextDecoder().decode(startup);
  assert.match(startupText, /user\0app user\0/);
  assert.match(startupText, /database\0app\/db\0/);
  assert.match(startupText, /client_encoding\0UTF8\0/);

  const cancel = encodeCancelRequest({ processId: 7, secretKey: 11 });
  assert.equal(cancel.length, 16);
  assert.equal(readI32(cancel, 0), 16);
  assert.equal(readI32(cancel, 4), 80_877_102);
  assert.equal(readI32(cancel, 8), 7);
  assert.equal(readI32(cancel, 12), 11);
  assert.deepEqual(parseBackendKeyData(cancel.subarray(8)), {
    processId: 7,
    secretKey: 11,
  });
  assert.throws(() => parseBackendKeyData(new Uint8Array([1, 2])), /BackendKeyData/);
});

function readI32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}
