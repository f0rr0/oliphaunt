import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'vitest';

import { normalizeOpenConfig } from '../config.js';
import { MemoryDuplexStream } from '../runtime/byte-stream.js';
import { BrokerHandle, createBrokerRuntimeBinding } from '../runtime/broker.js';
import { encodeBrokerResponse } from '../runtime/broker-frames.js';
import { createForgottenRuntimeHandleCleanup } from '../runtime/forgotten-handle.js';
import {
  cleanupFailedManagedLaunch,
  parseReadyEndpoint,
  randomHexToken,
  readReadyLine,
  unixSocketPathsFit,
} from '../runtime/node-adapter.js';
import {
  encodeStartupMessage,
  PostgresWireClient,
} from '../runtime/pgwire.js';
import { createServerRuntimeBinding, ServerHandle } from '../runtime/server.js';

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

test('failed broker handles never relaunch and retain cleanup ownership for close', async () => {
  if (process.platform === 'win32') return;

  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-broker-failure-'));
  const ipcDir = join(scratch, 'ipc');
  await mkdir(ipcDir);
  let streamCloseAttempts = 0;
  let childWaitAttempts = 0;
  let childKillAttempts = 0;
  const stream = {
    async readExactly(): Promise<Uint8Array> {
      throw new Error('failed broker stream must not be read');
    },
    async writeAll(): Promise<void> {
      throw new Error('failed broker stream must not receive a close request');
    },
    async close(): Promise<void> {
      streamCloseAttempts += 1;
      if (streamCloseAttempts === 1) throw new Error('fixture stream close failed');
    },
  };
  const child = {
    stdout: Readable.from([]),
    kill(): void {
      childKillAttempts += 1;
    },
    async wait(): Promise<number> {
      childWaitAttempts += 1;
      if (childWaitAttempts === 1) throw new Error('fixture child wait failed');
      return 23;
    },
    async exited(): Promise<number> {
      return 23;
    },
  };
  const config = normalizeOpenConfig(
    { topology: 'broker' },
    { instanceDirectory: join(scratch, 'database'), temporaryDirectory: false },
  );
  const handle = new BrokerHandle(
    config,
    { child, stream, cancelEndpoint: 'tcp:127.0.0.1:1', ipcDir },
    'fixture-token',
  );
  const firstFailure = new Error('fixture broker transport failed');

  try {
    // Make the IPC parent non-writable so the best-effort failure path cannot
    // discard its cleanup path before explicit close retries it.
    await chmod(scratch, 0o500);
    await handle.markFailed(firstFailure);
    assert.equal(streamCloseAttempts, 1);
    assert.equal(childKillAttempts, 1);
    assert.equal(childWaitAttempts, 1);
    await assert.rejects(handle.request({ kind: 'backup' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /close and reopen/);
      assert.equal(error.cause, firstFailure);
      return true;
    });

    await chmod(scratch, 0o700);
    await handle.detach();
    assert.equal(streamCloseAttempts, 2, 'explicit close retries stream cleanup');
    assert.equal(childWaitAttempts, 2, 'explicit close retries child reaping');
    await assert.rejects(stat(ipcDir), { code: 'ENOENT' });
  } finally {
    await chmod(scratch, 0o700).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
});

test('terminal broker detach retains each cleanup owner until that resource is released', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-broker-detach-'));
  const ipcDir = join(scratch, 'ipc');
  await mkdir(ipcDir);
  const wire = new MemoryDuplexStream([
    encodeBrokerResponse({ kind: 'ok', bytes: new Uint8Array() }),
  ]);
  let writes = 0;
  let streamCloseAttempts = 0;
  let childWaitAttempts = 0;
  const stream = {
    readExactly: (length: number) => wire.readExactly(length),
    async writeAll(bytes: Uint8Array): Promise<void> {
      writes += 1;
      await wire.writeAll(bytes);
    },
    async close(): Promise<void> {
      streamCloseAttempts += 1;
      if (streamCloseAttempts === 1) throw new Error('fixture terminal stream close failed');
    },
  };
  const child = {
    stdout: Readable.from([]),
    kill(): void {
      throw new Error('an already-exited fixture must not be killed');
    },
    async wait(): Promise<number> {
      childWaitAttempts += 1;
      if (childWaitAttempts === 1) throw new Error('fixture terminal child reap failed');
      return 0;
    },
    async exited(): Promise<number> {
      return 0;
    },
  };
  const config = normalizeOpenConfig(
    { topology: 'broker' },
    { instanceDirectory: join(scratch, 'database'), temporaryDirectory: false },
  );
  const handle = new BrokerHandle(
    config,
    { child, stream, cancelEndpoint: 'tcp:127.0.0.1:1', ipcDir },
    'fixture-token',
  );

  try {
    await assert.rejects(handle.detach(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    });
    assert.equal(writes, 1, 'the destructive close request is sent once');
    assert.equal(streamCloseAttempts, 1);
    assert.equal(childWaitAttempts, 1);
    assert.ok(
      (await stat(ipcDir)).isDirectory(),
      'IPC storage remains intact while the broker reap is unconfirmed',
    );

    await handle.detach();
    assert.equal(writes, 1, 'cleanup retry never resends a terminal close request');
    assert.equal(streamCloseAttempts, 2, 'the exact stream cleanup is retried');
    assert.equal(childWaitAttempts, 2, 'the exact child reap is retried');
    await assert.rejects(stat(ipcDir), { code: 'ENOENT' });

    await handle.detach();
    assert.equal(streamCloseAttempts, 2, 'released resources are forgotten exactly once');
    assert.equal(childWaitAttempts, 2, 'a confirmed reap is not retried');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Postgres wire termination closes after a failed Terminate write and retains both failures', async () => {
  let writeAttempts = 0;
  let closeAttempts = 0;
  const stream = {
    async readExactly(): Promise<Uint8Array> {
      throw new Error('termination fixture does not read');
    },
    async writeAll(): Promise<void> {
      writeAttempts += 1;
      throw new Error('fixture Terminate write failed');
    },
    async close(): Promise<void> {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('fixture client stream close failed');
    },
  };
  type InternalWireClientConstructor = new (wireStream: typeof stream) => PostgresWireClient;
  const InternalWireClient = PostgresWireClient as unknown as InternalWireClientConstructor;
  const client = new InternalWireClient(stream);

  await assert.rejects(client.terminate(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map(String),
      ['Error: fixture Terminate write failed', 'Error: fixture client stream close failed'],
    );
    return true;
  });
  assert.equal(client.isTerminated, false);

  await client.terminate();
  assert.equal(writeAttempts, 1, 'a cleanup retry never resends Terminate');
  assert.equal(closeAttempts, 2, 'the exact stream close is retried');
  assert.equal(client.isTerminated, true);
  await client.terminate();
  assert.equal(closeAttempts, 2, 'confirmed stream close is idempotent');
});

test('terminal server detach retains child and path ownership for internal cleanup retry', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-server-detach-'));
  const socketDir = join(scratch, 'socket');
  await mkdir(socketDir);
  let childWaitAttempts = 0;
  const child = {
    stdout: Readable.from([]),
    kill(): void {
      throw new Error('an already-exited fixture server must not be killed');
    },
    async wait(): Promise<number> {
      childWaitAttempts += 1;
      if (childWaitAttempts === 1) throw new Error('fixture server child reap failed');
      return 0;
    },
    async exited(): Promise<number> {
      return 0;
    },
  };
  let shutdownAttempts = 0;
  const handle = new ServerHandle(
    child,
    join(scratch, 'database'),
    join(scratch, 'database', 'pgdata'),
    'fixture-pg-ctl',
    {},
    socketDir,
    'postgresql://fixture',
    false,
    async () => {
      shutdownAttempts += 1;
    },
  );

  try {
    await assert.rejects(handle.detach(), (error: unknown) => {
      return String(error).includes('fixture server child reap failed');
    });
    assert.equal(childWaitAttempts, 1);
    assert.equal(shutdownAttempts, 1);
    assert.ok(
      (await stat(socketDir)).isDirectory(),
      'socket storage remains intact while the server reap is unconfirmed',
    );

    await handle.detach();
    assert.equal(childWaitAttempts, 2, 'the exact child reap is retried');
    assert.equal(shutdownAttempts, 1, 'server shutdown control is never resent');
    await assert.rejects(stat(socketDir), { code: 'ENOENT' });

    await handle.detach();
    assert.equal(childWaitAttempts, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('failed unpublished launches retain storage until their child is conclusively reaped', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-unpublished-launch-'));
  const socketDir = join(scratch, 'socket');
  const databaseDir = join(scratch, 'database');
  await mkdir(socketDir);
  await mkdir(databaseDir);
  let streamCloseAttempts = 0;
  let childWaitAttempts = 0;
  const launch = {
    stream: {
      async readExactly(): Promise<Uint8Array> {
        throw new Error('failed launch fixture does not read');
      },
      async writeAll(): Promise<void> {
        throw new Error('failed launch fixture does not write');
      },
      async close(): Promise<void> {
        streamCloseAttempts += 1;
        if (streamCloseAttempts === 1) throw new Error('fixture launch stream close failed');
      },
    },
    child: {
      stdout: Readable.from([]),
      kill(): void {},
      async wait(): Promise<number> {
        childWaitAttempts += 1;
        if (childWaitAttempts === 1) throw new Error('fixture launch reap failed');
        return 0;
      },
      async exited(): Promise<number> {
        return 0;
      },
    },
    paths: [socketDir, databaseDir],
  };

  try {
    const first = await cleanupFailedManagedLaunch(launch, 1, 'fixture launch');
    assert.equal(first.length, 2);
    assert.ok((await stat(socketDir)).isDirectory());
    assert.ok((await stat(databaseDir)).isDirectory());

    const second = await cleanupFailedManagedLaunch(launch, 1, 'fixture launch');
    assert.deepEqual(second, []);
    assert.equal(streamCloseAttempts, 2);
    assert.equal(childWaitAttempts, 2);
    await assert.rejects(stat(socketDir), { code: 'ENOENT' });
    await assert.rejects(stat(databaseDir), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('cancelled readiness waits release their stream listeners immediately', async () => {
  const stream = new Readable({
    read(): void {},
  });
  const abort = new AbortController();
  const readiness = readReadyLine(stream, 60_000, 'fixture broker', abort.signal);
  assert.equal(stream.listenerCount('data'), 1);
  assert.equal(stream.listenerCount('error'), 1);
  assert.equal(stream.listenerCount('end'), 1);

  abort.abort();
  await assert.rejects(readiness, /readiness wait was cancelled/);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('end'), 0);
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

test('server readiness wire uses a PostgreSQL v3 startup packet', () => {
  const startup = encodeStartupMessage('app user', 'app/db');
  assert.equal(readI32(startup, 4), 196_608);
  const startupText = new TextDecoder().decode(startup);
  assert.match(startupText, /user\0app user\0/);
  assert.match(startupText, /database\0app\/db\0/);
  assert.match(startupText, /client_encoding\0UTF8\0/);
});

function readI32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}
