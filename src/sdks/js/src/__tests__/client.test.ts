import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { createOliphauntClient } from '../client.js';
import type {
  NativeBinding,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from '../native/types.js';

// OLIPHAUNT_DOCS_SNIPPET typescript-quickstart
test('exposes the minimal database lifecycle and byte backup contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-client-'));
  const binding = new FakeBinding();
  const client = createOliphauntClient(() => binding);
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
    const result = await db.query('SELECT value FROM things');
    assert.equal(result.commandTag, 'SELECT 1');
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]?.text(0), 'ok');
    assert.deepEqual(await db.backup(), new Uint8Array([1, 2, 3]));
    await db.checkpoint();
    await db.cancel();
    await db.close();
    assert.equal(binding.cancelCalls, 1);
    assert.equal(binding.detachCalls, 1);
    await assert.rejects(() => db.execute('SELECT 1'), /closed/);

    await client.restore(join(root, 'restored'), new Uint8Array([7, 8]));
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

class FakeBinding implements NativeBinding {
  readonly openCalls: NativeOpenConfig[] = [];
  readonly restoreCalls: NativeRestoreOptions[] = [];
  readonly sqlCalls: string[] = [];
  cancelCalls = 0;
  detachCalls = 0;
  failSql?: string;
  readonly tagForSql = new Map<string, string>();

  open(config: NativeOpenConfig): NativeHandle {
    this.openCalls.push(config);
    return { id: 1 };
  }

  execProtocolRaw(_handle: NativeHandle, request: Uint8Array): Uint8Array {
    return this.respond(decodeSimpleQuery(request) ?? 'SELECT value FROM things');
  }

  execSimpleQuery(_handle: NativeHandle, sql: string): Uint8Array {
    return this.respond(sql);
  }

  backup(_handle: NativeHandle): Uint8Array {
    return new Uint8Array([1, 2, 3]);
  }

  restore(options: NativeRestoreOptions): void {
    this.restoreCalls.push(options);
  }

  cancel(_handle: NativeHandle): void {
    this.cancelCalls += 1;
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
    return queryResponse('ok');
  }
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
