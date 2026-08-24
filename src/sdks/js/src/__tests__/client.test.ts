import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { createOliphauntClient } from '../client.js';
import type {
  NativeBinding,
  NativeBindingOptions,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from '../native/types.js';
import type { CommandResult } from '../query.js';
import type { OliphauntTransaction } from '../types.js';
import type { RuntimeBinding } from '../runtime/types.js';

// OLIPHAUNT_DOCS_SNIPPET typescript-quickstart
// liboliphaunt-doc-example:typescript-open-query
// liboliphaunt-doc-example:typescript-backup-restore
test('exposes the minimal database lifecycle and byte backup contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-client-'));
  const binding = new FakeBinding();
  const bindingOptions: NativeBindingOptions[] = [];
  const client = createOliphauntClient((options = {}) => {
    bindingOptions.push(options);
    return binding;
  });
  try {
    const db = await client.open({
      storage: { kind: 'directory', path: root },
      startupGUCs: { work_mem: '16MB' },
      username: 'app',
      database: 'appdb',
    });
    assert.deepEqual(binding.openCalls[0], {
      pgdata: join(root, 'pgdata'),
      runtimeDirectory: undefined,
      username: 'app',
      database: 'appdb',
      extensions: [],
      startupArgs: ['-c', 'work_mem=16MB'],
    });
    assert.deepEqual(await db.execute('UPDATE things SET value = 1'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
    });
    assert.equal(binding.requestTags.at(-1), 'P');
    const result = await db.query('SELECT value FROM things');
    assert.equal(binding.requestTags.at(-1), 'P');
    assert.equal(result.commandTag, 'SELECT 1');
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]?.text(0), 'ok');
    const streamed: Uint8Array[] = [];
    await db.execProtocolStream(new Uint8Array([0x51]), (chunk) => streamed.push(chunk));
    assert.equal(streamed.length, 1);
    assert.deepEqual(await db.backup(), new Uint8Array([1, 2, 3]));
    await db.checkpoint();
    await db.cancel();
    await db.close();
    assert.equal(binding.cancelCalls, 1);
    assert.equal(binding.detachCalls, 1);
    await assert.rejects(() => db.execute('SELECT 1'), /closed/);

    await client.restore(join(root, 'restored'), new Uint8Array([7, 8]), {
      libraryPath: '/opt/oliphaunt/liboliphaunt.so',
    });
    assert.deepEqual(binding.restoreCalls, [
      { destination: join(root, 'restored'), bytes: new Uint8Array([7, 8]) },
    ]);
    assert.deepEqual(bindingOptions, [
      { libraryPath: undefined },
      { libraryPath: '/opt/oliphaunt/liboliphaunt.so' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transactions commit, roll back body failures, and never roll back a failed commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-transaction-'));
  try {
    const successful = new FakeBinding();
    const db = await createOliphauntClient(() => successful).open({
      storage: { kind: 'directory', path: join(root, 'success') },
    });
    const value = await db.transaction(async (transaction) => {
      await transaction.execute('UPDATE things SET value = 2');
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(successful.sqlCalls.slice(-3), [
      'BEGIN',
      'UPDATE things SET value = 2',
      'COMMIT',
    ]);
    await db.close();

    const bodyFailure = new FakeBinding();
    const rollingBack = await createOliphauntClient(() => bodyFailure).open({
      storage: { kind: 'directory', path: join(root, 'rollback') },
    });
    await assert.rejects(
      () =>
        rollingBack.transaction(() => {
          throw new Error('body failed');
        }),
      /body failed/,
    );
    assert.deepEqual(bodyFailure.sqlCalls.slice(-2), ['BEGIN', 'ROLLBACK']);
    await rollingBack.close();

    const commitFailure = new FakeBinding();
    commitFailure.failSql = 'COMMIT';
    const uncertain = await createOliphauntClient(() => commitFailure).open({
      storage: { kind: 'directory', path: join(root, 'commit') },
    });
    await assert.rejects(() => uncertain.transaction(() => 'done'), /commit failed/);
    assert.deepEqual(commitFailure.sqlCalls.slice(-2), ['BEGIN', 'COMMIT']);
    assert.equal(commitFailure.sqlCalls.includes('ROLLBACK'), false);
    await assert.rejects(() => uncertain.execute('SELECT 1'), /state is unknown/);
    await uncertain.close();

    const postgresRollback = new FakeBinding();
    postgresRollback.tagForSql.set('COMMIT', 'ROLLBACK');
    const idle = await createOliphauntClient(() => postgresRollback).open({
      storage: { kind: 'directory', path: join(root, 'postgres-rollback') },
    });
    await assert.rejects(() => idle.transaction(() => 'done'), /expected COMMIT, got ROLLBACK/);
    assert.deepEqual(await idle.execute('UPDATE things SET value = 3'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
    });
    await idle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes physical-session work in FIFO order and pins transactions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-session-queue-'));
  const binding = new FakeBinding();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  binding.protocolStarted = () => firstStarted.resolve();
  binding.protocolGate = releaseFirst.promise;
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    const first = db.execute('UPDATE things SET value = 10');
    await firstStarted.promise;
    const backup = db.backup();
    const checkpoint = db.checkpoint();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(binding.operationEvents, ['raw:UPDATE things SET value = 10']);

    binding.protocolGate = undefined;
    releaseFirst.resolve();
    await Promise.all([first, backup, checkpoint]);
    assert.deepEqual(binding.operationEvents, [
      'raw:UPDATE things SET value = 10',
      'backup',
      'simple:CHECKPOINT',
    ]);

    binding.queryValues.set("SELECT 'first'", 'first');
    binding.queryValues.set("SELECT 'second'", 'second');
    const [firstResult, secondResult] = await Promise.all([
      db.query("SELECT 'first'"),
      db.query("SELECT 'second'"),
    ]);
    assert.equal(firstResult.rows[0]?.text(0), 'first');
    assert.equal(secondResult.rows[0]?.text(0), 'second');

    const transactionBodyStarted = deferred<void>();
    const releaseTransactionBody = deferred<void>();
    let completedTransactionHandle!: OliphauntTransaction;
    const transaction = db.transaction(async (owned) => {
      completedTransactionHandle = owned;
      await owned.execute('UPDATE things SET value = 11');
      transactionBodyStarted.resolve();
      await releaseTransactionBody.promise;
      await Promise.all([
        owned.execute('UPDATE things SET value = 12'),
        owned.execute('UPDATE things SET value = 13'),
      ]);
    });
    await transactionBodyStarted.promise;
    await assert.rejects(() => db.query('SELECT 1'), /physical session is pinned/);
    releaseTransactionBody.resolve();
    await transaction;
    assert.deepEqual(binding.sqlCalls.slice(-5), [
      'BEGIN',
      'UPDATE things SET value = 11',
      'UPDATE things SET value = 12',
      'UPDATE things SET value = 13',
      'COMMIT',
    ]);
    assert.equal(binding.maxConcurrentProtocolOperations, 1);
    await assert.rejects(
      () => completedTransactionHandle.execute('SELECT 1'),
      /transaction is no longer active/,
    );

    const acceptedOperationStarted = deferred<void>();
    const releaseAcceptedOperation = deferred<void>();
    let acceptedOperation!: Promise<CommandResult>;
    let sealedTransactionHandle!: OliphauntTransaction;
    const drainingTransaction = db.transaction(async (owned) => {
      sealedTransactionHandle = owned;
      binding.protocolStarted = () => acceptedOperationStarted.resolve();
      binding.protocolGate = releaseAcceptedOperation.promise;
      acceptedOperation = owned.execute('UPDATE things SET value = 15');
      await acceptedOperationStarted.promise;
    });
    await acceptedOperationStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(binding.sqlCalls.at(-1), 'COMMIT');
    await assert.rejects(
      () => sealedTransactionHandle.execute('UPDATE things SET value = 16'),
      /transaction is no longer active/,
    );
    binding.protocolGate = undefined;
    releaseAcceptedOperation.resolve();
    await acceptedOperation;
    await drainingTransaction;
    assert.deepEqual(binding.sqlCalls.slice(-3), [
      'BEGIN',
      'UPDATE things SET value = 15',
      'COMMIT',
    ]);

    await assert.rejects(
      () =>
        db.execProtocolStream(new Uint8Array([0x51]), () => {
          throw new Error('stream consumer failed');
        }),
      /stream consumer failed/,
    );
    assert.deepEqual(await db.execute('UPDATE things SET value = 14'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
    });
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps cancellation out of band and close drains accepted work exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-session-close-'));
  const binding = new FakeBinding();
  const operationStarted = deferred<void>();
  const releaseOperation = deferred<void>();
  binding.protocolStarted = () => operationStarted.resolve();
  binding.protocolGate = releaseOperation.promise;
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    const operation = db.execute('UPDATE things SET value = 12');
    await operationStarted.promise;
    await db.cancel();
    assert.deepEqual(binding.operationEvents, ['raw:UPDATE things SET value = 12', 'cancel']);

    const firstClose = db.close();
    const secondClose = db.close();
    assert.equal(firstClose, secondClose);
    await assert.rejects(() => db.backup(), /closing/);
    assert.equal(binding.detachCalls, 0);

    binding.protocolGate = undefined;
    releaseOperation.resolve();
    await operation;
    await Promise.all([firstClose, secondClose]);
    assert.equal(binding.detachCalls, 1);
    await db.close();
    assert.equal(binding.detachCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('broker and server facades inherit the same FIFO session ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-runtime-queue-'));
  try {
    for (const execution of ['broker', 'server'] as const) {
      const binding = new FakeBinding();
      const started = deferred<void>();
      const release = deferred<void>();
      binding.protocolStarted = () => started.resolve();
      binding.protocolGate = release.promise;
      const runtime = binding as unknown as RuntimeBinding;
      runtime.connectionString = () => 'postgresql://postgres@127.0.0.1:5432/postgres';
      const client = createOliphauntClient(() => binding, {
        broker: runtime,
        server: runtime,
      });
      const database =
        execution === 'broker'
          ? await client.open({
              execution,
              storage: { kind: 'directory', path: join(root, execution) },
            })
          : await client.openServer({
              storage: { kind: 'directory', path: join(root, execution) },
            });
      const first = database.execute('UPDATE things SET value = 20');
      await started.promise;
      const second = database.execute('UPDATE things SET value = 21');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(binding.operationEvents, ['raw:UPDATE things SET value = 20']);
      binding.protocolGate = undefined;
      release.resolve();
      await Promise.all([first, second]);
      assert.deepEqual(binding.operationEvents, [
        'raw:UPDATE things SET value = 20',
        'raw:UPDATE things SET value = 21',
      ]);
      await database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeBinding implements NativeBinding {
  readonly openCalls: NativeOpenConfig[] = [];
  readonly restoreCalls: NativeRestoreOptions[] = [];
  readonly sqlCalls: string[] = [];
  readonly requestTags: string[] = [];
  readonly operationEvents: string[] = [];
  cancelCalls = 0;
  detachCalls = 0;
  failSql?: string;
  protocolGate?: Promise<void>;
  protocolStarted?: () => void;
  activeProtocolOperations = 0;
  maxConcurrentProtocolOperations = 0;
  readonly tagForSql = new Map<string, string>();
  readonly queryValues = new Map<string, string>();

  open(config: NativeOpenConfig): NativeHandle {
    this.openCalls.push(config);
    return { id: 1 };
  }

  async execProtocolRaw(_handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
    this.requestTags.push(String.fromCharCode(request[0] ?? 0));
    const sql =
      decodeSimpleQuery(request) ?? decodeExtendedQuery(request) ?? 'SELECT value FROM things';
    this.operationEvents.push(`raw:${sql}`);
    this.protocolStarted?.();
    this.activeProtocolOperations += 1;
    this.maxConcurrentProtocolOperations = Math.max(
      this.maxConcurrentProtocolOperations,
      this.activeProtocolOperations,
    );
    try {
      await this.protocolGate;
      return this.respond(sql);
    } finally {
      this.activeProtocolOperations -= 1;
    }
  }

  async execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    onChunk(await this.execProtocolRaw(handle, request));
  }

  async execSimpleQuery(_handle: NativeHandle, sql: string): Promise<Uint8Array> {
    this.operationEvents.push(`simple:${sql}`);
    return this.respond(sql);
  }

  async backup(_handle: NativeHandle): Promise<Uint8Array> {
    this.operationEvents.push('backup');
    return new Uint8Array([1, 2, 3]);
  }

  restore(options: NativeRestoreOptions): void {
    this.restoreCalls.push(options);
  }

  cancel(_handle: NativeHandle): void {
    this.cancelCalls += 1;
    this.operationEvents.push('cancel');
  }

  detach(_handle: NativeHandle): void {
    this.detachCalls += 1;
  }

  private respond(sql: string): Uint8Array {
    this.sqlCalls.push(sql);
    if (sql === this.failSql) throw new Error('commit failed');
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql === 'CHECKPOINT') {
      return commandResponse(this.tagForSql.get(sql) ?? sql);
    }
    if (sql.startsWith('UPDATE')) return commandResponse('UPDATE 3');
    return queryResponse(this.queryValues.get(sql) ?? 'ok');
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
  };
}

function commandResponse(tag: string): Uint8Array {
  return Uint8Array.from([...backendMessage(0x43, cstring(tag)), ...backendMessage(0x5a, [0x49])]);
}

function queryResponse(value: string): Uint8Array {
  const bytes = [...new TextEncoder().encode(value)];
  return Uint8Array.from([
    ...backendMessage(0x54, [
      ...i16(1),
      ...cstring('value'),
      ...i32(0),
      ...i16(0),
      ...i32(25),
      ...i16(-1),
      ...i32(-1),
      ...i16(0),
    ]),
    ...backendMessage(0x44, [...i16(1), ...i32(bytes.length), ...bytes]),
    ...backendMessage(0x43, cstring('SELECT 1')),
    ...backendMessage(0x5a, [0x49]),
  ]);
}

function backendMessage(tag: number, body: number[]): number[] {
  return [tag, ...i32(body.length + 4), ...body];
}

function cstring(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

function i16(value: number): number[] {
  const bits = value & 0xffff;
  return [(bits >>> 8) & 0xff, bits & 0xff];
}

function i32(value: number): number[] {
  const bits = value >>> 0;
  return [(bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff];
}

function decodeSimpleQuery(request: Uint8Array): string | undefined {
  return request[0] === 0x51
    ? new TextDecoder().decode(request.subarray(5, request.length - 1))
    : undefined;
}

function decodeExtendedQuery(request: Uint8Array): string | undefined {
  if (request[0] !== 0x50 || request[5] !== 0) return undefined;
  const terminator = request.indexOf(0, 6);
  return terminator < 0 ? undefined : new TextDecoder().decode(request.subarray(6, terminator));
}
