import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
import type {
  OliphauntDatabase,
  OliphauntTransaction,
  OpenConfig,
  ServerOpenConfig,
} from '../types.js';
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
      notices: [],
    });
    assert.equal(binding.requestTags.at(-1), 'P');
    const result = await db.query('SELECT value FROM things');
    assert.equal(binding.requestTags.at(-1), 'P');
    assert.equal(result.commandTag, 'SELECT 1');
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.rows, [{ value: 'ok' }]);
    const streamed: Uint8Array[] = [];
    await db.execProtocolRawStream(new Uint8Array([0x51]), (chunk) => {
      streamed.push(chunk);
    });
    assert.equal(streamed.length, 1);
    assert.deepEqual(await db.backup(), new Uint8Array([1, 2, 3]));
    await db.execute('CHECKPOINT');
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

test('snapshots open configuration before asynchronous storage work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-open-snapshot-'));
  const direct = new FakeBinding();
  const broker = new FakeBinding();
  const brokerRuntime = broker as unknown as RuntimeBinding;
  brokerRuntime.close = async (handle) => {
    await broker.detach(handle);
    return { state: 'closed' };
  };
  const startupGUCs: Record<string, string> = { work_mem: '8MB' };
  const extensions: string[] = [];
  const config: OpenConfig = {
    topology: 'broker',
    storage: { kind: 'directory', path: root },
    startupGUCs,
    username: 'before',
    database: 'before',
    extensions,
  };
  const client = createOliphauntClient(() => direct, { broker: brokerRuntime });

  try {
    const opening = client.open(config);
    config.topology = 'direct';
    config.username = 'after';
    config.database = 'after';
    startupGUCs.work_mem = '64MB';
    extensions.push('vector');

    const database = await opening;
    assert.equal(direct.openCalls.length, 0);
    assert.equal(broker.openCalls.length, 1);
    assert.deepEqual(broker.openCalls[0], {
      topology: 'broker',
      instanceDirectory: root,
      pgdata: join(root, 'pgdata'),
      temporaryDirectory: false,
      startupArgs: ['-c', 'work_mem=8MB'],
      username: 'before',
      database: 'before',
      extensions: [],
      libraryPath: undefined,
      runtimeDirectory: undefined,
      brokerExecutable: undefined,
      serverExecutable: undefined,
      serverListen: undefined,
    });
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an unknown current topology before materializing storage', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-js-invalid-topology-'));
  const instanceDirectory = join(scratch, 'must-not-exist');
  const binding = new FakeBinding();
  const client = createOliphauntClient(() => binding);

  try {
    await assert.rejects(
      client.open({
        topology: 'worker',
        storage: { kind: 'directory', path: instanceDirectory },
      } as unknown as OpenConfig),
      /topology must be "direct" or "broker"/,
    );
    assert.equal(binding.openCalls.length, 0);
    await assert.rejects(stat(instanceDirectory), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('rejects storage-owned startup GUCs before materializing storage', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'oliphaunt-js-owned-guc-'));
  const instanceDirectory = join(scratch, 'must-not-exist');
  const binding = new FakeBinding();
  const client = createOliphauntClient(() => binding);

  try {
    await assert.rejects(
      client.open({
        storage: { kind: 'directory', path: instanceDirectory },
        startupGUCs: { CONFIG_FILE: '/tmp/redirect.conf' },
      }),
      /Oliphaunt owns PostgreSQL startup GUC 'config_file'/,
    );
    assert.equal(binding.openCalls.length, 0);
    await assert.rejects(stat(instanceDirectory), { code: 'ENOENT' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('snapshots server storage and nested configuration before asynchronous work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-server-snapshot-'));
  const movedRoot = join(root, 'mutated');
  const server = new FakeBinding();
  const serverRuntime = server as unknown as RuntimeBinding;
  serverRuntime.close = async (handle) => {
    await server.detach(handle);
    return { state: 'closed' };
  };
  serverRuntime.connectionString = () => 'postgresql://postgres@127.0.0.1:15432/postgres';
  const storage = { kind: 'directory' as const, path: root };
  const listen = { transport: 'tcp' as const, port: 15432 };
  const startupGUCs: Record<string, string> = { work_mem: '8MB' };
  const extensions: string[] = [];
  const config: ServerOpenConfig = { storage, listen, startupGUCs, extensions };
  const client = createOliphauntClient(() => new FakeBinding(), { server: serverRuntime });

  try {
    const opening = client.openServer(config);
    storage.path = movedRoot;
    listen.port = 25432;
    startupGUCs.work_mem = '64MB';
    extensions.push('vector');

    const database = await opening;
    assert.equal(database.connectionString, 'postgresql://postgres@127.0.0.1:15432/postgres');
    for (const operation of [
      'execute',
      'query',
      'queryRaw',
      'exec',
      'describe',
      'execProtocolRaw',
      'execProtocolRawStream',
      'backup',
      'cancel',
      'transaction',
    ]) {
      assert.equal(operation in database, false, `${operation} must not leak from server facade`);
    }
    assert.equal(server.openCalls.length, 1);
    assert.deepEqual(server.openCalls[0], {
      topology: 'server',
      instanceDirectory: root,
      pgdata: join(root, 'pgdata'),
      temporaryDirectory: false,
      startupArgs: ['-c', 'work_mem=8MB'],
      username: 'postgres',
      database: 'postgres',
      extensions: [],
      libraryPath: undefined,
      runtimeDirectory: undefined,
      brokerExecutable: undefined,
      serverExecutable: undefined,
      serverListen: { transport: 'tcp', port: 15432 },
    });
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server open preserves both a missing endpoint and handle cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-server-open-failure-'));
  const binding = new FakeBinding();
  const cleanupFailure = new Error('server handle cleanup failed');
  let closeCalls = 0;
  const runtime = binding as unknown as RuntimeBinding;
  runtime.close = async () => {
    closeCalls += 1;
    return { state: 'terminal', error: cleanupFailure };
  };
  const client = createOliphauntClient(() => new FakeBinding(), { server: runtime });

  try {
    const failure = await client
      .openServer({ storage: { kind: 'directory', path: root } })
      .catch((error: unknown) => error);
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors[0]?.message, 'native server did not expose its connection string');
    assert.equal(failure.errors[1], cleanupFailure);
    assert.equal(closeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copies restore bytes before asynchronous binding resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-restore-snapshot-'));
  const binding = new FakeBinding();
  const releaseBinding = deferred<void>();
  const client = createOliphauntClient(async () => {
    await releaseBinding.promise;
    return binding;
  });
  const backup = new Uint8Array([7, 8]);

  try {
    const restoring = client.restore(join(root, 'restored'), backup);
    backup.fill(0);
    releaseBinding.resolve();
    await restoring;
    assert.deepEqual(binding.restoreCalls, [
      { destination: join(root, 'restored'), bytes: new Uint8Array([7, 8]) },
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

    const poisonedCallback = new FakeBinding();
    poisonedCallback.failSql = 'UPDATE transport_unknown';
    const poisonedCallbackDb = await createOliphauntClient(() => poisonedCallback).open({
      storage: { kind: 'directory', path: join(root, 'poisoned-callback') },
    });
    const businessFailure = new Error('business callback failed');
    let databaseFailure: unknown;
    const combinedFailure = await poisonedCallbackDb
      .transaction(async (transaction) => {
        try {
          await transaction.execute('UPDATE transport_unknown');
        } catch (error) {
          databaseFailure = error;
        }
        throw businessFailure;
      })
      .catch((error: unknown) => error);
    assert.ok(combinedFailure instanceof AggregateError);
    assert.deepEqual(combinedFailure.errors, [businessFailure, databaseFailure]);
    assert.match(combinedFailure.message, /independent database failure/);
    assert.deepEqual(poisonedCallback.sqlCalls.slice(-2), ['BEGIN', 'UPDATE transport_unknown']);
    const poisonedRequestCount = poisonedCallback.requests.length;
    await assert.rejects(() => poisonedCallbackDb.execute('SELECT 1'), /state is unknown/);
    assert.equal(poisonedCallback.requests.length, poisonedRequestCount);
    await poisonedCallbackDb.close();

    const malformedCommit = new FakeBinding();
    malformedCommit.responseForSql.set('COMMIT', Uint8Array.from(backendMessage(0x5a, [0x49])));
    const malformed = await createOliphauntClient(() => malformedCommit).open({
      storage: { kind: 'directory', path: join(root, 'malformed-commit') },
    });
    await assert.rejects(
      () => malformed.transaction(() => 'done'),
      /omitted CommandComplete or EmptyQueryResponse/,
    );
    assert.deepEqual(malformedCommit.sqlCalls.slice(-2), ['BEGIN', 'COMMIT']);
    assert.equal(malformedCommit.sqlCalls.includes('ROLLBACK'), false);
    await assert.rejects(() => malformed.execute('SELECT 1'), /state is unknown/);
    await malformed.close();

    const rollbackFailure = new FakeBinding();
    rollbackFailure.failSql = 'ROLLBACK';
    const rollbackUncertain = await createOliphauntClient(() => rollbackFailure).open({
      storage: { kind: 'directory', path: join(root, 'rollback-failure') },
    });
    const bodyError = new Error('body and rollback failed');
    const aggregate = await rollbackUncertain
      .transaction(() => {
        throw bodyError;
      })
      .catch((error: unknown) => error);
    assert.ok(aggregate instanceof AggregateError);
    assert.equal(aggregate.errors[0], bodyError);
    assert.match(String(aggregate.errors[1]), /commit failed/);
    assert.deepEqual(rollbackFailure.sqlCalls.slice(-2), ['BEGIN', 'ROLLBACK']);
    await assert.rejects(() => rollbackUncertain.execute('SELECT 1'), /state is unknown/);
    await rollbackUncertain.close();

    const aborted = new FakeBinding();
    aborted.responseForSql.set(
      'UPDATE rejected',
      Uint8Array.from([
        ...backendMessage(0x45, diagnostic('ERROR', 'XX000', 'queued operation failed')),
        ...backendMessage(0x5a, [0x45]),
      ]),
    );
    aborted.tagForSql.set('COMMIT', 'ROLLBACK');
    const abortedDb = await createOliphauntClient(() => aborted).open({
      storage: { kind: 'directory', path: join(root, 'aborted-transaction') },
    });
    let ignored: Promise<CommandResult> | undefined;
    const originalFailure = await abortedDb
      .transaction((transaction) => {
        ignored = transaction.execute('UPDATE rejected');
        void ignored.catch(() => undefined);
        return 'done';
      })
      .catch((error: unknown) => error);
    assert.equal((originalFailure as { sqlstate?: string }).sqlstate, 'XX000');
    assert.equal((originalFailure as Error).message, 'queued operation failed');
    assert.ok(ignored);
    await assert.rejects(ignored, (error: unknown) => error === originalFailure);
    assert.deepEqual(aborted.sqlCalls.slice(-3), ['BEGIN', 'UPDATE rejected', 'COMMIT']);
    await abortedDb.close();

    const postgresRollback = new FakeBinding();
    postgresRollback.tagForSql.set('COMMIT', 'ROLLBACK');
    const idle = await createOliphauntClient(() => postgresRollback).open({
      storage: { kind: 'directory', path: join(root, 'postgres-rollback') },
    });
    await assert.rejects(() => idle.transaction(() => 'done'), /expected COMMIT, got ROLLBACK/);
    assert.deepEqual(await idle.execute('UPDATE things SET value = 3'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
      notices: [],
    });
    await idle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transaction Promise methods never leak admission or planning failures synchronously', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-transaction-promises-'));
  const binding = new FakeBinding();
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  let expired!: OliphauntTransaction;
  try {
    await db.transaction(async (transaction) => {
      expired = transaction;
      for (const call of [
        () => transaction.execute('SELECT\0invalid'),
        () => transaction.query('SELECT\0invalid'),
        () => transaction.queryRaw('SELECT\0invalid'),
        () => transaction.exec('SELECT\0invalid'),
        () => transaction.describe('SELECT\0invalid'),
      ]) {
        assert.match(String(await catchPromiseWithoutSynchronousThrow(call)), /NUL bytes/);
      }
      for (const call of [
        () => transaction.execute('ROLLBACK AND CHAIN'),
        () => transaction.query('ABORT WORK AND CHAIN'),
        () => transaction.queryRaw('ROLLBACK TRANSACTION /* keep ownership */ AND CHAIN'),
        () => transaction.exec('SELECT 1; RoLlBaCk AND /* nested /* comment */ */ CHAIN'),
      ]) {
        assert.match(
          String(await catchPromiseWithoutSynchronousThrow(call)),
          /do not support ROLLBACK\/ABORT .* AND CHAIN/,
        );
      }
      assert.deepEqual(binding.sqlCalls, ['BEGIN']);
      // Planning failures never enter the transaction queue or poison it.
      assert.deepEqual(await transaction.execute('UPDATE things SET value = 22'), {
        commandTag: 'UPDATE 3',
        rowCount: 3,
        notices: [],
      });
    });

    assert.match(
      String(
        await catchPromiseWithoutSynchronousThrow(() =>
          expired.execute('UPDATE things SET value = 23'),
        ),
      ),
      /transaction is no longer active/,
    );
    assert.match(
      String(await catchPromiseWithoutSynchronousThrow(() => expired.rollback())),
      /transaction is no longer active/,
    );
  } finally {
    await db.close();
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
    const checkpoint = db.execute('CHECKPOINT');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(binding.operationEvents, ['raw:UPDATE things SET value = 10']);

    binding.protocolGate = undefined;
    releaseFirst.resolve();
    await Promise.all([first, backup, checkpoint]);
    assert.deepEqual(binding.operationEvents, [
      'raw:UPDATE things SET value = 10',
      'backup',
      'raw:CHECKPOINT',
    ]);

    binding.queryValues.set("SELECT 'first'", 'first');
    binding.queryValues.set("SELECT 'second'", 'second');
    const [firstResult, secondResult] = await Promise.all([
      db.query("SELECT 'first'"),
      db.query("SELECT 'second'"),
    ]);
    assert.deepEqual(firstResult.rows, [{ value: 'first' }]);
    assert.deepEqual(secondResult.rows, [{ value: 'second' }]);

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
      /transaction is finishing|transaction is no longer active/,
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
        db.execProtocolRawStream(new Uint8Array([0x51]), () => {
          throw new Error('stream consumer failed');
        }),
      /stream consumer failed/,
    );
    const nanCallbackOutcome = await db
      .execProtocolRawStream(new Uint8Array([0x51]), () => {
        throw Number.NaN;
      })
      .then(
        () => ({ fulfilled: true as const, error: undefined }),
        (error: unknown) => ({ fulfilled: false as const, error }),
      );
    assert.equal(nanCallbackOutcome.fulfilled, false);
    assert.ok(Object.is(nanCallbackOutcome.error, Number.NaN));
    const dynamicallyTypedAsyncCallback: (chunk: Uint8Array) => unknown = async () => {};
    await assert.rejects(
      db.execProtocolRawStream(
        new Uint8Array([0x51]),
        dynamicallyTypedAsyncCallback as unknown as (chunk: Uint8Array) => undefined,
      ),
      /must complete synchronously.*Promise or thenable/,
    );
    assert.deepEqual(await db.execute('UPDATE things SET value = 14'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
      notices: [],
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
  const cancellationStarted = deferred<void>();
  const releaseCancellation = deferred<void>();
  const teardownStarted = deferred<void>();
  const releaseTeardown = deferred<void>();
  binding.protocolStarted = () => operationStarted.resolve();
  binding.protocolGate = releaseOperation.promise;
  binding.cancelStarted = () => cancellationStarted.resolve();
  binding.cancelGate = releaseCancellation.promise;
  binding.detachStarted = () => teardownStarted.resolve();
  binding.detachGate = releaseTeardown.promise;
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    // Deterministic query->immediate close->cancel admission regression.
    const operation = db.execute('UPDATE things SET value = 12');
    const firstClose = db.close();
    const secondClose = db.close();
    const cancellation = db.cancel();
    assert.equal(firstClose, secondClose);
    await Promise.all([operationStarted.promise, cancellationStarted.promise]);
    assert.deepEqual(binding.operationEvents, ['cancel', 'raw:UPDATE things SET value = 12']);
    await assert.rejects(() => db.backup(), /closing/);
    assert.equal(binding.detachCalls, 0);

    binding.protocolGate = undefined;
    releaseOperation.resolve();
    await operation;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      binding.detachCalls,
      0,
      'close must wait for the out-of-band cancellation it admitted',
    );
    binding.cancelGate = undefined;
    releaseCancellation.resolve();
    await cancellation;
    await teardownStarted.promise;
    await assert.rejects(() => db.cancel(), /closing/);
    binding.detachGate = undefined;
    releaseTeardown.resolve();
    await Promise.all([firstClose, secondClose]);
    assert.equal(binding.detachCalls, 1);
    assert.equal(db.close(), firstClose);
    await db.close();
    assert.equal(binding.detachCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps direct pre-deactivation close failures retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-retryable-close-'));
  const binding = new FakeBinding();
  const closeError = new Error('logical detach did not complete');
  binding.detachFailures.push(closeError);
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    const first = db.close();
    assert.equal(await first.catch((error: unknown) => error), closeError);
    assert.equal(db.closed, false);
    assert.deepEqual(await db.execute('UPDATE things SET value = 18'), {
      commandTag: 'UPDATE 3',
      rowCount: 3,
      notices: [],
    });

    const retry = db.close();
    assert.notEqual(retry, first);
    await retry;
    assert.equal(db.closed, true);
    assert.equal(db.close(), retry);
    assert.equal(binding.detachCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal broker and server close failures retire the facade and replay exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-terminal-close-'));
  try {
    for (const topology of ['broker', 'server'] as const) {
      const binding = new FakeBinding();
      const closeError = new Error(`${topology} teardown failed`);
      let closeCalls = 0;
      const runtime = binding as unknown as RuntimeBinding;
      runtime.close = async () => {
        closeCalls += 1;
        return { state: 'terminal', error: closeError };
      };
      runtime.connectionString = () => 'postgresql://postgres@127.0.0.1:5432/postgres';
      const client = createOliphauntClient(() => binding, {
        broker: runtime,
        server: runtime,
      });
      const database =
        topology === 'broker'
          ? await client.open({
              topology,
              storage: { kind: 'directory', path: join(root, topology) },
            })
          : await client.openServer({
              storage: { kind: 'directory', path: join(root, topology) },
            });

      const first = database.close();
      const concurrent = database.close();
      assert.equal(concurrent, first);
      assert.equal(await first.catch((error: unknown) => error), closeError);
      assert.equal(database.closed, true);
      assert.equal(closeCalls, 1);
      assert.equal(database.close(), first);
      assert.equal(await database.close().catch((error: unknown) => error), closeError);
      if (topology === 'broker') {
        const brokerDatabase = database as OliphauntDatabase;
        await assert.rejects(() => brokerDatabase.query('SELECT 1'), /closed/);
        await assert.rejects(() => brokerDatabase.cancel(), /closed/);
      } else {
        assert.equal('query' in database, false);
        assert.equal('cancel' in database, false);
      }
      assert.equal(closeCalls, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('database raw stream callbacks cannot queue same-handle work while cancel stays out of band', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-stream-reentry-'));
  const binding = new FakeBinding();
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    let databaseAttempts: Promise<unknown>[] = [];
    let cancellation!: Promise<void>;
    const beforeDatabaseStream = binding.requests.length;
    await db.execProtocolRawStream(new Uint8Array([0x51]), () => {
      databaseAttempts = [
        db.query('SELECT callback_reentry'),
        db.backup(),
        db.close(),
        db.execProtocolRawStream(new Uint8Array([0x51]), () => undefined),
      ];
      for (const attempt of databaseAttempts) void attempt.catch(() => undefined);
      cancellation = db.cancel();
      void cancellation.catch(() => undefined);
    });
    for (const attempt of databaseAttempts) {
      await assert.rejects(attempt, /must not re-enter the same Oliphaunt handle/);
    }
    await cancellation;
    assert.equal(binding.requests.length, beforeDatabaseStream + 1);
    assert.equal(binding.detachCalls, 0);
    assert.equal(binding.cancelCalls, 1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('raw stream native recovery failure outranks an earlier callback failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-stream-error-precedence-'));
  const binding = new FakeBinding();
  const nativeFailure = new Error('native protocol stream recovery failed');
  const callbackFailure = new Error('protocol stream callback failed');
  binding.streamCompletionFailure = nativeFailure;
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    await assert.rejects(
      () =>
        db.execProtocolRawStream(new Uint8Array([0x51]), () => {
          throw callbackFailure;
        }),
      (error) => error === nativeFailure,
    );
    const requestsAfterFailure = binding.requests.length;
    await assert.rejects(() => db.query('SELECT 1'), /session state is unknown/);
    assert.equal(binding.requests.length, requestsAfterFailure);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('registers forgotten direct cleanup and releases only the collected owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-finalizer-'));
  const binding = new FinalizingFakeBinding();
  const client = createOliphauntClient(() => binding);
  try {
    const explicit = await client.open({
      storage: { kind: 'directory', path: join(root, 'explicit') },
    });
    assert.equal(binding.registeredOwner, explicit);
    await explicit.close();
    assert.deepEqual(binding.unregisteredOwners, [explicit]);

    const current = await client.open({
      storage: { kind: 'directory', path: join(root, 'current') },
    });
    await binding.runStaleFinalizer(explicit);
    await assert.rejects(
      () =>
        client.open({
          storage: { kind: 'directory', path: join(root, 'stale-must-not-release-current') },
        }),
      /active process-wide instance/,
    );
    await current.close();

    const forgotten = await client.open({
      storage: { kind: 'directory', path: join(root, 'forgotten') },
    });
    assert.equal(binding.registeredOwner, forgotten);
    await binding.finalizeRegisteredOwner();
    assert.equal(binding.forgottenCleanupCalls, 1);

    // The cleanup record carries the exact direct-owner release callback. The
    // next open reaches the runtime instead of failing the stale JS ownership
    // guard; Deno's generation cleanup is terminal for this process lifetime.
    await assert.rejects(
      () =>
        client.open({
          storage: { kind: 'directory', path: join(root, 'after-finalizer') },
        }),
      /process lifetime has already been used/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans an opened owner before rejecting failed facade publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-publication-cleanup-'));
  try {
    for (const topology of ['direct', 'broker', 'server'] as const) {
      const binding = new PublicationFailingFakeBinding();
      const registrationError = new Error(`${topology} registry rejected owner`);
      binding.registrationFailure = registrationError;
      const runtime = binding as unknown as RuntimeBinding;
      runtime.close = async (handle) => {
        await binding.detach(handle);
        return { state: 'closed' };
      };
      runtime.connectionString = () => 'postgresql://postgres@127.0.0.1:5432/postgres';
      const client = createOliphauntClient(() => binding, {
        broker: runtime,
        server: runtime,
      });
      const config = {
        storage: { kind: 'directory' as const, path: join(root, topology) },
      };
      const firstOpen =
        topology === 'server'
          ? client.openServer(config)
          : client.open({
              ...config,
              topology,
            });
      assert.equal(await firstOpen.catch((error: unknown) => error), registrationError);
      assert.equal(binding.detachCalls, 1);
      assert.equal(binding.registeredOwners.length, 1);
      assert.deepEqual(binding.unregisteredOwners, binding.registeredOwners);

      // In particular, direct publication failure must release only its exact
      // process-wide JavaScript admission lease so a later owner can open.
      const database =
        topology === 'server'
          ? await client.openServer(config)
          : await client.open({ ...config, topology });
      await database.close();
      assert.equal(binding.detachCalls, 2);
      assert.equal(binding.registeredOwners.length, 2);
      assert.deepEqual(binding.unregisteredOwners, binding.registeredOwners);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('broker facade preserves FIFO session ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-runtime-queue-'));
  try {
    const binding = new FakeBinding();
    const started = deferred<void>();
    const release = deferred<void>();
    binding.protocolStarted = () => started.resolve();
    binding.protocolGate = release.promise;
    const runtime = binding as unknown as RuntimeBinding;
    runtime.close = async (handle) => {
      await binding.detach(handle);
      return { state: 'closed' };
    };
    const client = createOliphauntClient(() => binding, { broker: runtime });
    const database = await client.open({
      topology: 'broker',
      storage: { kind: 'directory', path: join(root, 'broker') },
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exposes decoded, raw, exec, describe, and immutable inferred-codec operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-structured-api-'));
  const binding = new FakeBinding();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  binding.protocolStarted = () => firstStarted.resolve();
  binding.protocolGate = releaseFirst.promise;
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  try {
    assert.equal(db.closed, false);
    const object = { version: 1 };
    const decoders: Record<number, (value: string) => unknown> = {
      3802: (value) => `first:${value}`,
    };
    const inferred = db.query<{ value: string }>('SELECT $1::jsonb AS value', [object], {
      decoders,
    });
    await firstStarted.promise;
    const queued = db.execute('UPDATE things SET value = 22');
    object.version = 2;
    decoders[3802] = (value) => `second:${value}`;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(binding.requestTags, ['P']);

    binding.protocolGate = undefined;
    releaseFirst.resolve();
    const [decoded] = await Promise.all([inferred, queued]);
    assert.deepEqual(decoded.rows, [{ value: 'first:{"version":1}' }]);
    assert.deepEqual(binding.requestTags.slice(0, 3), ['P', 'P', 'P']);
    const bindRequest = binding.requests.find((request) =>
      frontendMessageTags(request).includes('B'),
    );
    assert.ok(bindRequest);
    assert.equal(firstBindTextParameter(bindRequest), '{"version":1}');
    assert.equal(binding.maxConcurrentProtocolOperations, 1);

    const raw = await db.queryRaw('SELECT $1::text AS value', ['raw']);
    assert.equal(raw.getText(0, 'value'), 'raw');
    assert.equal(raw.kind, 'rows');

    const description = await db.describe('SELECT $1::int4 AS value');
    assert.deepEqual(description.parameterTypeOids, [23]);
    assert.equal(description.fields?.[0]?.typeOid, 23);

    const multiSql = 'UPDATE things SET value = 30; SELECT value FROM things';
    binding.responseForSql.set(multiSql, multiExecResponse());
    const execution = await db.exec(multiSql);
    assert.deepEqual(
      execution.statements.map((statement) => statement.kind),
      ['command', 'rows'],
    );
    assert.deepEqual(execution.statements[1]?.rows, [{ value: 'multi' }]);

    const requestCount = binding.requests.length;
    await assert.rejects(() => db.exec('COPY things FROM STDIN'), /does not support COPY/);
    assert.equal(binding.requests.length, requestCount);
  } finally {
    await db.close();
    assert.equal(db.closed, true);
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers database-level transaction leakage and poisons unknown wire boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-recovery-'));
  try {
    const recoverableBinding = new FakeBinding();
    const recoverable = await createOliphauntClient(() => recoverableBinding).open({
      storage: { kind: 'directory', path: join(root, 'recoverable') },
    });
    await assert.rejects(
      () => recoverable.execute('BEGIN'),
      /ended with PostgreSQL transaction status transaction/,
    );
    assert.deepEqual(recoverableBinding.sqlCalls.slice(-2), ['BEGIN', 'ROLLBACK']);
    await assert.doesNotReject(() => recoverable.execute('UPDATE things SET value = 31'));
    await recoverable.close();

    const malformedBinding = new FakeBinding();
    malformedBinding.responseForSql.set(
      'SELECT malformed',
      Uint8Array.from(backendMessage(0x43, cstring('SELECT 0'))),
    );
    const malformed = await createOliphauntClient(() => malformedBinding).open({
      storage: { kind: 'directory', path: join(root, 'malformed') },
    });
    await assert.rejects(() => malformed.query('SELECT malformed'), /before ReadyForQuery/);
    await assert.rejects(() => malformed.query('SELECT 1'), /session state is unknown/);
    await malformed.close();

    const rawFailureBinding = new FakeBinding();
    const rawTransportFailure = new Error('raw transport failed');
    rawFailureBinding.protocolFailure = rawTransportFailure;
    const rawFailure = await createOliphauntClient(() => rawFailureBinding).open({
      storage: { kind: 'directory', path: join(root, 'raw-failure') },
    });
    await assert.rejects(
      () => rawFailure.execProtocolRaw(new Uint8Array([0x51])),
      (error) => error === rawTransportFailure,
    );
    const requestsAfterFailure = rawFailureBinding.requests.length;
    await assert.rejects(() => rawFailure.query('SELECT 1'), /session state is unknown/);
    assert.equal(rawFailureBinding.requests.length, requestsAfterFailure);
    await rawFailure.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supports one-shot explicit transaction rollback and expires the handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-explicit-rollback-'));
  const binding = new FakeBinding();
  const db = await createOliphauntClient(() => binding).open({
    storage: { kind: 'directory', path: root },
  });
  let completed!: OliphauntTransaction;
  try {
    const value = await db.transaction(async (transaction) => {
      completed = transaction;
      assert.equal(transaction.closed, false);
      assert.equal('execProtocolRaw' in transaction, false);
      assert.equal('execProtocolRawStream' in transaction, false);
      await transaction.execute('UPDATE things SET value = 40');
      await transaction.rollback();
      assert.equal(transaction.closed, true);
      await assert.rejects(() => transaction.rollback(), /no longer active/);
      await assert.rejects(() => transaction.query('SELECT 1'), /no longer active/);
      return 40;
    });
    assert.equal(value, 40);
    assert.equal(completed.closed, true);
    assert.deepEqual(binding.sqlCalls.slice(-3), [
      'BEGIN',
      'UPDATE things SET value = 40',
      'ROLLBACK',
    ]);
    assert.equal(binding.sqlCalls.includes('COMMIT'), false);
    await assert.doesNotReject(() => db.execute('UPDATE things SET value = 41'));
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transaction ownership is enforced from complete protocol responses before parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-transaction-ownership-'));
  try {
    const escapedResponses = [
      {
        sql: 'SELECT hidden_commit_then_begin',
        response: Uint8Array.from([
          ...backendMessage(0x43, cstring('COMMIT')),
          ...backendMessage(0x43, cstring('BEGIN')),
          ...backendMessage(0x45, diagnostic('ERROR', 'XX000', 'later failure')),
          ...backendMessage(0x5a, [0x54]),
        ]),
        expected: /command tag COMMIT/,
      },
      {
        sql: 'SELECT hidden_rollback_then_begin',
        response: Uint8Array.from([
          ...backendMessage(0x43, cstring('ROLLBACK')),
          ...backendMessage(0x43, cstring('BEGIN')),
          ...backendMessage(0x5a, [0x54]),
        ]),
        expected: /command tag BEGIN/,
      },
    ];

    for (const [index, escaped] of escapedResponses.entries()) {
      const binding = new FakeBinding();
      binding.responseForSql.set(escaped.sql, escaped.response);
      const db = await createOliphauntClient(() => binding).open({
        storage: { kind: 'directory', path: join(root, `escaped-${index}`) },
      });
      const failure = await db
        .transaction((transaction) => {
          const ignored = transaction.exec(escaped.sql);
          void ignored.catch(() => undefined);
        })
        .catch((error: unknown) => error);
      assert.match(String(failure), escaped.expected);
      assert.deepEqual(binding.sqlCalls, ['BEGIN', escaped.sql]);
      const requestCount = binding.requests.length;
      await assert.rejects(() => db.query('SELECT 1'), /session state is unknown/);
      assert.equal(binding.requests.length, requestCount);
      await db.close();
    }

    const savepointBinding = new FakeBinding();
    const rollbackToSavepoint = 'ROLLBACK TO SAVEPOINT nested';
    savepointBinding.responseForSql.set(rollbackToSavepoint, commandResponse('ROLLBACK', 0x54));
    const reusable = await createOliphauntClient(() => savepointBinding).open({
      storage: { kind: 'directory', path: join(root, 'savepoint') },
    });
    await reusable.transaction(async (transaction) => {
      await transaction.exec(rollbackToSavepoint);
    });
    assert.deepEqual(savepointBinding.sqlCalls.slice(-3), ['BEGIN', rollbackToSavepoint, 'COMMIT']);
    await reusable.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeBinding implements NativeBinding {
  readonly openCalls: NativeOpenConfig[] = [];
  readonly restoreCalls: NativeRestoreOptions[] = [];
  readonly sqlCalls: string[] = [];
  readonly requestTags: string[] = [];
  readonly requests: Uint8Array[] = [];
  readonly operationEvents: string[] = [];
  cancelCalls = 0;
  detachCalls = 0;
  readonly detachFailures: unknown[] = [];
  failSql?: string;
  protocolGate?: Promise<void>;
  protocolStarted?: () => void;
  protocolFailure?: unknown;
  streamCompletionFailure?: unknown;
  cancelGate?: Promise<void>;
  cancelStarted?: () => void;
  detachGate?: Promise<void>;
  detachStarted?: () => void;
  activeProtocolOperations = 0;
  maxConcurrentProtocolOperations = 0;
  readonly tagForSql = new Map<string, string>();
  readonly queryValues = new Map<string, string>();
  readonly responseForSql = new Map<string, Uint8Array>();
  #transactionStatus = 0x49;
  #pendingSql?: string;

  async open(config: NativeOpenConfig): Promise<NativeHandle> {
    this.openCalls.push(config);
    return { id: 1 };
  }

  async execProtocolRaw(_handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
    this.requestTags.push(String.fromCharCode(request[0] ?? 0));
    this.requests.push(request.slice());
    const tags = frontendMessageTags(request);
    const parsedSql = decodeSimpleQuery(request) ?? decodeExtendedQuery(request);
    const describeOnly = tags.includes('P') && tags.includes('D') && !tags.includes('B');
    if (describeOnly && parsedSql !== undefined) this.#pendingSql = parsedSql;
    const sql =
      parsedSql ?? (tags[0] === 'B' ? this.#pendingSql : undefined) ?? 'SELECT value FROM things';
    this.operationEvents.push(`raw:${sql}`);
    this.protocolStarted?.();
    this.activeProtocolOperations += 1;
    this.maxConcurrentProtocolOperations = Math.max(
      this.maxConcurrentProtocolOperations,
      this.activeProtocolOperations,
    );
    try {
      await this.protocolGate;
      if (this.protocolFailure !== undefined) throw this.protocolFailure;
      if (describeOnly) {
        return describeResponse(sql, inferredParameterOids(sql), this.#transactionStatus);
      }
      if (tags.includes('B')) this.#pendingSql = undefined;
      return this.respond(
        sql,
        tags.includes('B') ? firstBindTextParameter(request) : undefined,
        tags.includes('B'),
      );
    } finally {
      this.activeProtocolOperations -= 1;
    }
  }

  async execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    try {
      onChunk(await this.execProtocolRaw(handle, request));
    } catch (callbackError) {
      if (this.streamCompletionFailure !== undefined) {
        throw this.streamCompletionFailure;
      }
      throw callbackError;
    }
    if (this.streamCompletionFailure !== undefined) {
      throw this.streamCompletionFailure;
    }
  }

  async execSimpleQuery(_handle: NativeHandle, sql: string): Promise<Uint8Array> {
    this.operationEvents.push(`simple:${sql}`);
    return this.respond(sql);
  }

  async backup(_handle: NativeHandle): Promise<Uint8Array> {
    this.operationEvents.push('backup');
    return new Uint8Array([1, 2, 3]);
  }

  async restore(options: NativeRestoreOptions): Promise<void> {
    this.restoreCalls.push(options);
  }

  async cancel(_handle: NativeHandle): Promise<void> {
    this.cancelCalls += 1;
    this.operationEvents.push('cancel');
    this.cancelStarted?.();
    await this.cancelGate;
  }

  async detach(_handle: NativeHandle): Promise<void> {
    this.detachCalls += 1;
    this.detachStarted?.();
    await this.detachGate;
    if (this.detachFailures.length > 0) {
      throw this.detachFailures.shift();
    }
  }

  private respond(sql: string, boundValue?: string, extended = false): Uint8Array {
    this.sqlCalls.push(sql);
    if (sql === this.failSql) throw new Error('commit failed');
    const configured = this.responseForSql.get(sql);
    if (configured !== undefined) return configured;
    if (sql === 'BEGIN') {
      this.#transactionStatus = 0x54;
      return commandResponse(this.tagForSql.get(sql) ?? sql, this.#transactionStatus, extended);
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.#transactionStatus = 0x49;
      return commandResponse(this.tagForSql.get(sql) ?? sql, this.#transactionStatus, extended);
    }
    if (sql === 'CHECKPOINT') return commandResponse(sql, this.#transactionStatus, extended);
    if (sql.startsWith('UPDATE'))
      return commandResponse('UPDATE 3', this.#transactionStatus, extended);
    return queryResponse(
      this.queryValues.get(sql) ?? boundValue ?? 'ok',
      this.#transactionStatus,
      inferredResultOid(sql),
      extended,
    );
  }
}

class FinalizingFakeBinding extends FakeBinding {
  registeredOwner?: object;
  readonly unregisteredOwners: object[] = [];
  forgottenCleanupCalls = 0;
  terminallyClosed = false;
  #releaseOwnership?: () => void;
  readonly #releaseByOwner = new WeakMap<object, () => void>();

  override async open(config: NativeOpenConfig): Promise<NativeHandle> {
    if (this.terminallyClosed) {
      throw new Error('native process lifetime has already been used');
    }
    return super.open(config);
  }

  registerForgottenHandleCleanup(
    owner: object,
    _handle: NativeHandle,
    releaseOwnership: () => void,
  ): void {
    this.registeredOwner = owner;
    this.#releaseOwnership = releaseOwnership;
    this.#releaseByOwner.set(owner, releaseOwnership);
  }

  unregisterForgottenHandleCleanup(owner: object): void {
    this.unregisteredOwners.push(owner);
    if (this.registeredOwner === owner) {
      this.registeredOwner = undefined;
      this.#releaseOwnership = undefined;
    }
  }

  async finalizeRegisteredOwner(): Promise<void> {
    const releaseOwnership = this.#releaseOwnership;
    assert.ok(releaseOwnership);
    this.forgottenCleanupCalls += 1;
    await Promise.resolve();
    this.terminallyClosed = true;
    releaseOwnership();
    this.registeredOwner = undefined;
    this.#releaseOwnership = undefined;
  }

  async runStaleFinalizer(owner: object): Promise<void> {
    const releaseOwnership = this.#releaseByOwner.get(owner);
    assert.ok(releaseOwnership);
    await Promise.resolve();
    releaseOwnership();
  }
}

class PublicationFailingFakeBinding extends FakeBinding {
  registrationFailure?: Error;
  readonly registeredOwners: object[] = [];
  readonly unregisteredOwners: object[] = [];

  registerForgottenHandleCleanup(
    owner: object,
    _handle: NativeHandle,
    _releaseOwnership: () => void,
  ): void {
    this.registeredOwners.push(owner);
    const error = this.registrationFailure;
    this.registrationFailure = undefined;
    if (error !== undefined) throw error;
  }

  unregisterForgottenHandleCleanup(owner: object): void {
    this.unregisteredOwners.push(owner);
  }
}

async function catchPromiseWithoutSynchronousThrow(call: () => Promise<unknown>): Promise<unknown> {
  let caught!: Promise<unknown>;
  assert.doesNotThrow(() => {
    caught = call().catch((error: unknown) => error);
  });
  return caught;
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

function commandResponse(tag: string, status = 0x49, extended = false): Uint8Array {
  return Uint8Array.from([
    ...(extended
      ? [...backendMessage(0x31, []), ...backendMessage(0x32, []), ...backendMessage(0x6e, [])]
      : []),
    ...backendMessage(0x43, cstring(tag)),
    ...backendMessage(0x5a, [status]),
  ]);
}

function queryResponse(value: string, status = 0x49, typeOid = 25, extended = false): Uint8Array {
  const bytes = [...new TextEncoder().encode(value)];
  return Uint8Array.from([
    ...(extended ? [...backendMessage(0x31, []), ...backendMessage(0x32, [])] : []),
    ...backendMessage(0x54, rowDescriptionBody(typeOid)),
    ...backendMessage(0x44, [...i16(1), ...i32(bytes.length), ...bytes]),
    ...backendMessage(0x43, cstring('SELECT 1')),
    ...backendMessage(0x5a, [status]),
  ]);
}

function multiExecResponse(): Uint8Array {
  const value = [...new TextEncoder().encode('multi')];
  return Uint8Array.from([
    ...backendMessage(0x43, cstring('UPDATE 2')),
    ...backendMessage(0x54, rowDescriptionBody(25)),
    ...backendMessage(0x44, [...i16(1), ...i32(value.length), ...value]),
    ...backendMessage(0x43, cstring('SELECT 1')),
    ...backendMessage(0x5a, [0x49]),
  ]);
}

function describeResponse(sql: string, parameterTypeOids: number[], status: number): Uint8Array {
  return Uint8Array.from([
    ...backendMessage(0x31, []),
    ...backendMessage(0x74, [...i16(parameterTypeOids.length), ...parameterTypeOids.flatMap(i32)]),
    ...(sql.trimStart().toUpperCase().startsWith('SELECT')
      ? backendMessage(0x54, rowDescriptionBody(inferredResultOid(sql)))
      : backendMessage(0x6e, [])),
    ...backendMessage(0x5a, [status]),
  ]);
}

function rowDescriptionBody(typeOid: number): number[] {
  return [
    ...i16(1),
    ...cstring('value'),
    ...i32(0),
    ...i16(0),
    ...i32(typeOid),
    ...i16(-1),
    ...i32(-1),
    ...i16(0),
  ];
}

function inferredParameterOids(sql: string): number[] {
  const indexes = [...sql.matchAll(/\$([1-9][0-9]*)/g)].map((match) => Number(match[1]));
  const count = Math.max(0, ...indexes);
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const cast = new RegExp(`\\$${index}\\s*::\\s*([a-z0-9_]+)`, 'i').exec(sql)?.[1]?.toLowerCase();
    if (cast === 'jsonb') return 3802;
    if (cast === 'json') return 114;
    if (cast === 'int4' || cast === 'integer') return 23;
    return 25;
  });
}

function inferredResultOid(sql: string): number {
  if (/::\s*jsonb\b/i.test(sql)) return 3802;
  if (/::\s*json\b/i.test(sql)) return 114;
  if (/::\s*(?:int4|integer)\b/i.test(sql)) return 23;
  return 25;
}

function backendMessage(tag: number, body: number[]): number[] {
  return [tag, ...i32(body.length + 4), ...body];
}

function cstring(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

function diagnostic(severity: string, sqlstate: string, message: string): number[] {
  return [0x53, ...cstring(severity), 0x43, ...cstring(sqlstate), 0x4d, ...cstring(message), 0];
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

function frontendMessageTags(request: Uint8Array): string[] {
  const tags: string[] = [];
  let offset = 0;
  while (offset + 5 <= request.length) {
    const length = readU32(request, offset + 1);
    if (length < 4 || offset + length + 1 > request.length) break;
    tags.push(String.fromCharCode(request[offset]!));
    offset += length + 1;
  }
  if (tags.length === 0 && request.length > 0) tags.push(String.fromCharCode(request[0]!));
  return tags;
}

function firstBindTextParameter(request: Uint8Array): string | undefined {
  let messageOffset = 0;
  while (messageOffset + 5 <= request.length && request[messageOffset] !== 0x42) {
    messageOffset += readU32(request, messageOffset + 1) + 1;
  }
  if (request[messageOffset] !== 0x42) return undefined;
  let offset = messageOffset + 5;
  while (offset < request.length && request[offset] !== 0) offset += 1;
  offset += 1;
  while (offset < request.length && request[offset] !== 0) offset += 1;
  offset += 1;
  const formatCount = readU16(request, offset);
  offset += 2 + formatCount * 2;
  const parameterCount = readU16(request, offset);
  offset += 2;
  if (parameterCount === 0) return undefined;
  const length = readU32(request, offset);
  if (length === 0xffffffff) return undefined;
  offset += 4;
  return new TextDecoder().decode(request.subarray(offset, offset + length));
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
