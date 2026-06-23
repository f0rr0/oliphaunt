import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  CAP_BACKUP_RESTORE,
  CAP_EXTENSIONS,
  CAP_LOGICAL_REOPEN,
  CAP_MULTI_INSTANCE,
  CAP_PROTOCOL_RAW,
  CAP_PROTOCOL_STREAM,
  CAP_QUERY_CANCEL,
  CAP_SIMPLE_QUERY,
} from '../native/common.js';
import type {
  NativeBinding,
  NativeBindingOptions,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from '../native/types.js';
import { simpleQuery } from '../protocol.js';
import {
  createOliphauntClient,
  defaultEngineForRuntime,
  supportsBackupFormat,
  supportsRestoreFormat,
} from '../client.js';
import type { BackupFormat, RawProtocolTransport } from '../types.js';

async function main(): Promise<void> {
  testDefaultEngineKeepsNodeInstallScriptFree();
  await testSupportedModesExposeNativeDirectContract();
  await testSupportedModesReportsNativeLoaderFailure();
  await testOpenNormalizesNativeConfigAndUsesLibraryOverride();
  await testOpenRejectsUnsupportedModesAndInvalidInputs();
  await testExecuteQueryStreamingAndClose();
  await testTransactionCommitsRollsBackAndPinsSession();
  await testBackupAndRestoreUsePhysicalArchiveShape();
  await testBackgroundPreparationCancelsActiveWorkAndSkipsCheckpoint();
  await testExecutionAfterCloseFailsBeforeNativeCall();
}

function testDefaultEngineKeepsNodeInstallScriptFree(): void {
  assert.equal(defaultEngineForRuntime('node'), 'nativeDirect');
  assert.equal(defaultEngineForRuntime('bun'), 'nativeDirect');
  assert.equal(defaultEngineForRuntime('deno'), 'nativeDirect');
}

async function testSupportedModesExposeNativeDirectContract(): Promise<void> {
  const binding = new MockNativeBinding({
    flags:
      CAP_PROTOCOL_RAW |
      CAP_PROTOCOL_STREAM |
      CAP_MULTI_INSTANCE |
      CAP_EXTENSIONS |
      CAP_QUERY_CANCEL |
      CAP_BACKUP_RESTORE |
      CAP_SIMPLE_QUERY |
      CAP_LOGICAL_REOPEN,
    protocolStream: true,
  });
  const client = createOliphauntClient((options) => {
    binding.factoryOptions.push(options ?? {});
    return binding;
  });

  const support = await client.supportedModes({ libraryPath: '/tmp/liboliphaunt.dylib' });

  assert.deepEqual(
    support.map((entry) => entry.engine),
    ['nativeDirect', 'nativeBroker', 'nativeServer'],
  );
  assert.equal(support[0]?.available, true);
  assert.equal(support[0]?.capabilities.rawProtocolTransport, 'node-addon');
  assert.equal(support[0]?.capabilities.maxClientSessions, 1);
  assert.equal(support[0]?.capabilities.multiRoot, true);
  assert.equal(support[0]?.capabilities.protocolStream, true);
  assert.deepEqual(support[0]?.capabilities.backupFormats, ['physicalArchive']);
  assert.equal(supportsBackupFormat(support[0]!.capabilities, 'physicalArchive'), true);
  assert.equal(supportsBackupFormat(support[0]!.capabilities, 'sql'), false);
  assert.equal(supportsRestoreFormat(support[0]!.capabilities, 'physicalArchive'), true);
  assert.equal(support[1]?.available, false);
  assert.equal(support[1]?.capabilities.processIsolated, true);
  assert.equal(support[1]?.capabilities.rootSwitchable, true);
  assert.match(support[1]?.unavailableReason ?? '', /broker/);
  assert.equal(support[2]?.available, false);
  assert.equal(support[2]?.capabilities.independentSessions, true);
  assert.deepEqual(support[2]?.capabilities.backupFormats, ['sql', 'physicalArchive']);
  assert.match(support[2]?.unavailableReason ?? '', /server/);
  assert.deepEqual(binding.factoryOptions, [{ libraryPath: '/tmp/liboliphaunt.dylib' }]);
}

async function testSupportedModesReportsNativeLoaderFailure(): Promise<void> {
  const client = createOliphauntClient(() => {
    throw new Error('missing dylib');
  });

  const support = await client.supportedModes();

  assert.equal(support.length, 3);
  assert.equal(support[0]?.available, false);
  assert.match(support[0]?.unavailableReason ?? '', /missing dylib/);
  assert.equal(support[0]?.capabilities.reopenable, true);
}

async function testOpenNormalizesNativeConfigAndUsesLibraryOverride(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient((options) => {
    binding.factoryOptions.push(options ?? {});
    return binding;
  });

  const db = await client.open({
    engine: 'nativeDirect',
    root: '/tmp/oliphaunt-js-root',
    libraryPath: '/tmp/liboliphaunt.so',
    runtimeDirectory: '/tmp/postgres-runtime',
    startupGUCs: ['work_mem=4MB', { name: 'app.custom', value: 'enabled' }],
    extensions: ['postgis', ' hstore '],
  });

  assert.equal(db.root, '/tmp/oliphaunt-js-root');
  assert.deepEqual(binding.factoryOptions, [{ libraryPath: '/tmp/liboliphaunt.so' }]);
  assert.deepEqual(binding.openCalls, [
    {
      pgdata: '/tmp/oliphaunt-js-root/pgdata',
      runtimeDirectory: '/tmp/postgres-runtime',
      username: 'postgres',
      database: 'postgres',
      startupArgs: [
        '-c',
        'shared_buffers=128MB',
        '-c',
        'wal_buffers=4MB',
        '-c',
        'min_wal_size=80MB',
        '-c',
        'fsync=on',
        '-c',
        'full_page_writes=on',
        '-c',
        'synchronous_commit=on',
        '-c',
        'work_mem=4MB',
        '-c',
        'app.custom=enabled',
      ],
    },
  ]);
}

async function testOpenRejectsUnsupportedModesAndInvalidInputs(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient(() => binding);

  await assert.rejects(
    async () => client.open({ engine: 'nativeServer', root: '/tmp/oliphaunt-js-root' }),
    /serverExecutable|OLIPHAUNT_POSTGRES/,
  );
  await assert.rejects(
    async () => client.open({ root: '/tmp/root', temporary: true }),
    /root and temporary are mutually exclusive/,
  );
  await assert.rejects(async () => client.open({ root: ' \n' }), /database root must not be empty/);
  await assert.rejects(
    async () => client.open({ root: '/tmp/root', username: '\0' }),
    /username must not contain NUL bytes/,
  );
  await assert.rejects(
    async () => client.open({ root: '/tmp/root', startupGUCs: ['bad-name=value'] }),
    /startup GUC name/,
  );
  await assert.rejects(
    async () => client.open({ root: '/tmp/root', extensions: ['bad/value'] }),
    /extension id/,
  );
  await assert.rejects(
    async () => client.open({ temporary: false }),
    /database root is not configured/,
  );
  assert.deepEqual(binding.openCalls, []);
}

async function testExecuteQueryStreamingAndClose(): Promise<void> {
  const binding = new MockNativeBinding({ protocolStream: false });
  const client = createOliphauntClient(() => binding);
  const db = await client.open({ engine: 'nativeDirect', root: '/tmp/oliphaunt-js-root' });

  // OLIPHAUNT_DOCS_SNIPPET typescript-quickstart
  const executeBytes = await db.execute('SELECT 1');
  assert.ok(executeBytes.includes(0x5a));
  assert.deepEqual(binding.simpleQueryCalls, ['SELECT 1']);

  const query = await db.query('SELECT $1::text AS value', ['typed']);
  assert.equal(query.rowCount, 1);
  assert.equal(query.getText(0, 'value'), 'typed');
  assert.equal(binding.protocolCalls.length, 1);
  assert.equal(binding.protocolCalls[0]?.[0], 0x50);

  const chunks: Uint8Array[] = [];
  await db.execProtocolStream(simpleQuery('SELECT fallback'), (chunk) => chunks.push(chunk));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]?.includes(0x5a));

  await db.close();
  await db.close();
  assert.deepEqual(binding.detachCalls, [1]);
}

async function testTransactionCommitsRollsBackAndPinsSession(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient(() => binding);
  const db = await client.open({ engine: 'nativeDirect', root: '/tmp/oliphaunt-js-root' });

  await db.transaction(async (tx) => {
    await tx.execute('SELECT 1');
    await assert.rejects(async () => db.execute('SELECT 2'), /physical session is pinned/);
  });
  assert.deepEqual(binding.simpleQueryCalls, []);
  assert.deepEqual(binding.protocolSqlCalls.slice(0, 3), ['BEGIN', 'SELECT 1', 'COMMIT']);

  await assert.rejects(
    async () =>
      db.transaction(async (tx) => {
        await tx.execute('SELECT before fail');
        throw new Error('body failed');
      }),
    /body failed/,
  );
  assert.equal(binding.protocolSqlCalls.includes('ROLLBACK'), true);
}

async function testBackupAndRestoreUsePhysicalArchiveShape(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient((options) => {
    binding.factoryOptions.push(options ?? {});
    return binding;
  });
  const db = await client.open({ engine: 'nativeDirect', root: '/tmp/oliphaunt-js-root' });
  assert.equal(binding.openCalls[0]?.pgdata, '/tmp/oliphaunt-js-root/pgdata');

  await assert.rejects(async () => db.backup('sql'), /sql backup is not supported/);
  const backup = await db.backup();
  assert.equal(backup.format, 'physicalArchive');
  assert.deepEqual(Array.from(backup.bytes), [0x70, 0x68, 0x79, 0x73]);
  assert.deepEqual(binding.backupCalls, [{ handle: 1, format: 'physicalArchive' }]);

  const restored = await client.restore({
    engine: 'nativeDirect',
    root: '/tmp/oliphaunt-js-restore',
    libraryPath: '/tmp/liboliphaunt.dylib',
    artifact: backup,
    replaceExisting: true,
  });

  assert.equal(restored, '/tmp/oliphaunt-js-restore');
  assert.deepEqual(binding.restoreCalls, [
    {
      root: '/tmp/oliphaunt-js-restore',
      format: 'physicalArchive',
      bytes: backup.bytes,
      replaceExisting: true,
    },
  ]);
  const restoredDb = await client.open({
    engine: 'nativeDirect',
    root: restored,
    libraryPath: '/tmp/liboliphaunt.dylib',
  });
  assert.equal(restoredDb.root, '/tmp/oliphaunt-js-restore');
  assert.equal(
    binding.openCalls[binding.openCalls.length - 1]?.pgdata,
    '/tmp/oliphaunt-js-restore/pgdata',
  );
  await restoredDb.close();
  await assert.rejects(
    async () =>
      client.restore({
        engine: 'nativeDirect',
        root: '/tmp/root',
        artifact: { format: 'sql', bytes: new Uint8Array() },
      }),
    /physicalArchive/,
  );
  await assert.rejects(
    async () =>
      client.restore({
        engine: 'nativeServer',
        root: '/tmp/root',
        artifact: backup,
      }),
    /nativeServer restore is not supported/,
  );
}

async function testBackgroundPreparationCancelsActiveWorkAndSkipsCheckpoint(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient(() => binding);
  const db = await client.open({ engine: 'nativeDirect', root: '/tmp/oliphaunt-js-root' });
  binding.holdNextProtocolCall = true;

  const active = db.execProtocolRaw(simpleQuery('SELECT slow'));
  await Promise.resolve();
  const prepared = await db.prepareForBackground();
  binding.releaseHeldProtocolCall();
  await active;

  assert.deepEqual(prepared, {
    cancelledActiveWork: true,
    checkpointed: false,
    skippedCheckpointReason: 'activeWork',
  });
  assert.deepEqual(binding.cancelCalls, [1]);
}

async function testExecutionAfterCloseFailsBeforeNativeCall(): Promise<void> {
  const binding = new MockNativeBinding();
  const client = createOliphauntClient(() => binding);
  const db = await client.open({ engine: 'nativeDirect', root: '/tmp/oliphaunt-js-root' });

  await db.close();
  await assert.rejects(async () => db.execute('SELECT 1'), /database is closed/);
  assert.deepEqual(binding.simpleQueryCalls, []);
}

class MockNativeBinding implements NativeBinding {
  runtime = 'node' as const;
  rawProtocolTransport: RawProtocolTransport = 'node-addon';
  protocolStream: boolean;
  flags: bigint;
  factoryOptions: NativeBindingOptions[] = [];
  openCalls: NativeOpenConfig[] = [];
  protocolCalls: Uint8Array[] = [];
  protocolSqlCalls: string[] = [];
  simpleQueryCalls: string[] = [];
  backupCalls: Array<{ handle: NativeHandle; format: BackupFormat }> = [];
  restoreCalls: NativeRestoreOptions[] = [];
  cancelCalls: NativeHandle[] = [];
  detachCalls: NativeHandle[] = [];
  holdNextProtocolCall = false;
  #nextHandle = 1;
  #releaseHeldProtocolCall: (() => void) | undefined;

  constructor(
    options: {
      flags?: bigint;
      protocolStream?: boolean;
    } = {},
  ) {
    this.flags =
      options.flags ??
      CAP_PROTOCOL_RAW |
        CAP_EXTENSIONS |
        CAP_QUERY_CANCEL |
        CAP_BACKUP_RESTORE |
        CAP_SIMPLE_QUERY |
        CAP_LOGICAL_REOPEN;
    this.protocolStream = options.protocolStream ?? false;
  }

  version(): string {
    return 'test-liboliphaunt';
  }

  capabilities(): bigint {
    return this.flags;
  }

  open(config: NativeOpenConfig): NativeHandle {
    this.openCalls.push(config);
    return this.#nextHandle++;
  }

  async execProtocolRaw(handle: NativeHandle, request: Uint8Array): Promise<Uint8Array> {
    assert.equal(handle, 1);
    this.protocolCalls.push(request);
    const sql = decodeSimpleQuerySql(request);
    if (sql !== undefined) {
      this.protocolSqlCalls.push(sql);
    }
    if (this.holdNextProtocolCall) {
      this.holdNextProtocolCall = false;
      await new Promise<void>((resolve) => {
        this.#releaseHeldProtocolCall = resolve;
      });
    }
    return queryResponse(request[0] === 0x50 || sql?.includes('typed') ? 'typed' : '1');
  }

  execProtocolStream(
    handle: NativeHandle,
    request: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
  ): void {
    assert.equal(handle, 1);
    this.protocolCalls.push(request);
    onChunk(queryResponse('stream'));
  }

  execSimpleQuery(handle: NativeHandle, sql: string): Uint8Array {
    assert.equal(handle, 1);
    this.simpleQueryCalls.push(sql);
    return queryResponse(sql.includes('typed') ? 'typed' : '1');
  }

  backup(handle: NativeHandle, format: BackupFormat): Uint8Array {
    this.backupCalls.push({ handle, format });
    return new TextEncoder().encode('phys');
  }

  restore(options: NativeRestoreOptions): void {
    this.restoreCalls.push(options);
  }

  cancel(handle: NativeHandle): void {
    this.cancelCalls.push(handle);
  }

  detach(handle: NativeHandle): void {
    this.detachCalls.push(handle);
  }

  releaseHeldProtocolCall(): void {
    this.#releaseHeldProtocolCall?.();
    this.#releaseHeldProtocolCall = undefined;
  }
}

function queryResponse(value: string): Uint8Array {
  const valueBytes = new TextEncoder().encode(value);
  return Uint8Array.from([
    ...backendMessage(0x54, [
      ...i16(1),
      ...cstring('value'),
      ...u32(0),
      ...i16(0),
      ...u32(25),
      ...i16(-1),
      ...i32(-1),
      ...i16(0),
    ]),
    ...backendMessage(0x44, [...i16(1), ...i32(valueBytes.length), ...valueBytes]),
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

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function i32(value: number): number[] {
  return u32(value >>> 0);
}

function decodeSimpleQuerySql(request: Uint8Array): string | undefined {
  if (request[0] !== 0x51) {
    return undefined;
  }
  return new TextDecoder().decode(request.subarray(5, request.length - 1));
}

test('client', async () => {
  await main();
}, 15_000);
