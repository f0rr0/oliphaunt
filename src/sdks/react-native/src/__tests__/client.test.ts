import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { createOliphauntClient } from '../client';
import type { JsiProtocolChunkResult } from '../jsiTransport';
import { parseCommandResponse } from '../query';
import type { Spec } from '../specs/NativeOliphaunt';

// OLIPHAUNT_DOCS_SNIPPET react-native-quickstart
// liboliphaunt-doc-example:react-native-open-query

const encoder = new TextEncoder();

async function main(): Promise<void> {
  await testPublicEntrypointIsMinimal();
  await testStartupGUCValidation();
  await testOpenUsesNativeDirectDefaults();
  await testExecuteReturnsPostgresCommandMetadata();
  await testExecuteSupportsParameters();
  await testExecuteRejectsRows();
  testCommandParserRejectsUnknownAndCopyMessages();
  await testQueryReturnsRowsAndCommandMetadata();
  await testRawProtocolCheckpointAndCancel();
  await testProtocolStreamCallbackFailure();
  await testPhysicalBackupAndStaticRestore();
  await testTransactionsCommitAndRollback();
  await testCloseDuringTransactionIsRejected();
  await testCloseIsIdempotent();
}

async function testStartupGUCValidation(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open({
    startupGUCs: { _name: '', 'ext.name$1': 'on' },
  });
  assert.deepEqual((native.openCalls[0] as { startupGUCs?: string[] }).startupGUCs, [
    '_name=',
    'ext.name$1=on',
  ]);
  await db.close();

  for (const name of ['1name', '.foo', 'a..b', 'a.1b', 'ext.$name']) {
    await assert.rejects(
      () =>
        createOliphauntClient(new MockNative()).open({
          startupGUCs: { [name]: '1' },
        }),
      /each dot-separated component/,
    );
  }
  await assert.rejects(
    () =>
      createOliphauntClient(new MockNative()).open({
        startupGUCs: { good: 'bad\0value' },
      }),
    /must not contain NUL/,
  );
}

async function testPublicEntrypointIsMinimal(): Promise<void> {
  vi.resetModules();
  vi.doMock('react-native', () => ({
    TurboModuleRegistry: {
      getEnforcing(name: string) {
        assert.equal(name, 'Oliphaunt');
        return new MockNative();
      },
    },
  }));
  try {
    const entrypoint = await import('../index');
    assert.deepEqual(Object.keys(entrypoint).sort(), ['Oliphaunt', 'PostgresError']);
    assert.equal('supportedModes' in entrypoint.Oliphaunt, false);
    assert.equal('packageSizeReport' in entrypoint.Oliphaunt, false);
    assert.equal('processMemory' in entrypoint.Oliphaunt, false);
  } finally {
    vi.doUnmock('react-native');
    vi.resetModules();
  }
}

async function testOpenUsesNativeDirectDefaults(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open({
    storage: { kind: 'applicationData', name: 'primary' },
    startupGUCs: { search_path: 'public' },
    username: 'postgres',
    database: 'app',
    extensions: ['hstore'],
  });

  assert.deepEqual(native.openCalls, [
    {
      storageKind: 'applicationData',
      storageName: 'primary',
      startupGUCs: ['search_path=public'],
      username: 'postgres',
      database: 'app',
      extensions: ['hstore'],
    },
  ]);
  await db.close();
}

async function testExecuteReturnsPostgresCommandMetadata(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  assert.deepEqual(await db.execute('INSERT INTO items VALUES (1), (2), (3)'), {
    commandTag: 'INSERT 0 3',
    rowCount: 3,
  });
  assert.equal(native.execRequests.at(-1)?.[0], 0x50);
  await db.close();
}

async function testExecuteSupportsParameters(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  assert.deepEqual(await db.execute('UPDATE items SET value = $1', ['updated']), {
    commandTag: 'UPDATE 2',
    rowCount: 2,
  });
  assert.equal(native.execRequests.at(-1)?.[0], 0x50);
  await db.close();
}

async function testExecuteRejectsRows(): Promise<void> {
  const db = await createOliphauntClient(new MockNative()).open();
  await assert.rejects(() => db.execute('SELECT 1'), /use query\(\) for row results/);
  await db.close();
}

function testCommandParserRejectsUnknownAndCopyMessages(): void {
  assert.throws(
    () =>
      parseCommandResponse(
        backendResponse([
          [0x47, []],
          [0x5a, [0x49]],
        ]),
      ),
    /does not support COPY protocol responses/,
  );
  assert.throws(
    () =>
      parseCommandResponse(
        backendResponse([
          [0x59, []],
          [0x5a, [0x49]],
        ]),
      ),
    /unexpected backend message tag 0x59/,
  );
  assert.deepEqual(parseCommandResponse(backendCommandResponse('CREATE TABLE')), {
    commandTag: 'CREATE TABLE',
    rowCount: null,
  });
}

async function testQueryReturnsRowsAndCommandMetadata(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const result = await db.query('SELECT $1::text AS value', ['hello']);

  assert.equal(result.getText(0, 'value'), 'hello');
  assert.equal(result.commandTag, 'SELECT 1');
  assert.equal(result.rowCount, 1);
  assert.equal(native.execRequests.at(-1)?.[0], 0x50);
  await db.close();
}

async function testRawProtocolCheckpointAndCancel(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  assert.deepEqual(Array.from(await db.execProtocolRaw(Uint8Array.from([0xaa]))), [1, 0xaa]);
  const chunks: Uint8Array[] = [];
  await db.execProtocolStream(Uint8Array.from([0xbb]), (chunk) => chunks.push(chunk));
  assert.deepEqual(
    chunks.map((chunk) => Array.from(chunk)),
    [[1], [0xbb]],
  );
  await db.checkpoint();
  assert.match(native.requestTexts().at(-1) ?? '', /CHECKPOINT/);
  await db.cancel();
  assert.deepEqual(native.cancelledHandles, [1]);
  await db.close();
}

async function testProtocolStreamCallbackFailure(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const failure = new Error('chunk consumer failed');
  await assert.rejects(
    () =>
      db.execProtocolStream(Uint8Array.from([0xcc]), () => {
        throw failure;
      }),
    (error) => error === failure,
  );

  native.swallowStreamCallbackErrors = true;
  let callbackCalls = 0;
  await assert.rejects(
    () =>
      db.execProtocolStream(Uint8Array.from([0xcd]), () => {
        callbackCalls += 1;
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(callbackCalls, 1);
  assert.equal(native.streamChunkCallbackCalls, 3);

  native.swallowStreamCallbackErrors = false;
  for (const thrown of [undefined, null, 'string failure', { reason: 'object failure' }]) {
    const outcome = await db
      .execProtocolStream(Uint8Array.from([0xce]), () => {
        throw thrown;
      })
      .then(
        () => ({ fulfilled: true as const, error: undefined }),
        (error: unknown) => ({ fulfilled: false as const, error }),
      );
    assert.equal(outcome.fulfilled, false);
    assert.ok(Object.is(outcome.error, thrown));
  }
  await db.close();
}

async function testPhysicalBackupAndStaticRestore(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);
  const db = await client.open();

  assert.equal(new TextDecoder().decode(await db.backup()), 'physical-backup');
  await db.close();
  assert.equal(
    await client.restore(
      { kind: 'directory', path: '/tmp/restored' },
      encoder.encode('physical-backup'),
    ),
    undefined,
  );
  assert.deepEqual(native.restoreCalls, [
    {
      destination: {
        storageKind: 'directory',
        storagePath: '/tmp/restored',
      },
      payload: 'physical-backup',
    },
  ]);
}

async function testTransactionsCommitAndRollback(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const value = await db.transaction(async (transaction) => {
    assert.equal((await transaction.execute('UPDATE items SET value = $1', ['x'])).rowCount, 2);
    return (await transaction.query('SELECT $1::text AS value', ['hello'])).getText(0, 'value');
  });
  assert.equal(value, 'hello');
  assert.match(native.requestTexts().join('\n'), /BEGIN/);
  assert.match(native.requestTexts().join('\n'), /COMMIT/);

  await assert.rejects(
    () => db.transaction(() => Promise.reject(new Error('body failed'))),
    /body failed/,
  );
  assert.match(native.requestTexts().join('\n'), /ROLLBACK/);
  await db.close();
}

async function testCloseDuringTransactionIsRejected(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await db.transaction(async () => {
    await assert.rejects(() => db.close(), /transaction is active/);
  });
  assert.deepEqual(native.closedHandles, []);
  await db.close();
}

async function testCloseIsIdempotent(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  await Promise.all([db.close(), db.close()]);
  await db.close();
  assert.deepEqual(native.closedHandles, [1]);
}

class MockNative implements Spec {
  swallowStreamCallbackErrors = false;
  streamChunkCallbackCalls = 0;
  readonly openCalls: unknown[] = [];
  readonly execRequests: Uint8Array[] = [];
  readonly cancelledHandles: number[] = [];
  readonly closedHandles: number[] = [];
  readonly restoreCalls: Array<{
    destination: {
      storageKind: 'directory' | 'applicationData';
      storagePath?: string;
      storageName?: string;
    };
    payload: string;
  }> = [];
  #nextHandle = 1;

  constructor() {
    const native = this;
    (globalThis as GlobalWithJsi).__oliphauntReactNativeJsi = {
      version: 1,
      execProtocolRaw(handle, request) {
        return native.execProtocolRawJsi(handle, request);
      },
      async execProtocolStream(handle, request, onChunk) {
        const response = await native.execProtocolRawJsi(handle, request);
        const split = Math.max(1, Math.floor(response.byteLength / 2));
        for (const chunk of [response.subarray(0, split), response.subarray(split)]) {
          native.streamChunkCallbackCalls += 1;
          const result = onChunk(chunk);
          if (result?.__oliphauntProtocolChunkFailure && !native.swallowStreamCallbackErrors) {
            throw result.error;
          }
        }
      },
      backup(handle) {
        return native.backupJsi(handle);
      },
      restore(destination, artifact) {
        return native.restoreJsi(destination, artifact);
      },
    };
  }

  getConstants(): {} {
    return {};
  }

  async open(config: unknown): Promise<number> {
    this.openCalls.push(config);
    return this.#nextHandle++;
  }

  async cancel(handle: number): Promise<void> {
    this.cancelledHandles.push(handle);
  }

  async close(handle: number): Promise<void> {
    this.closedHandles.push(handle);
  }

  async execProtocolRawJsi(handle: number, request: Uint8Array): Promise<Uint8Array> {
    this.execRequests.push(request);
    if (request[0] !== 0x51 && request[0] !== 0x50) {
      return Uint8Array.from([handle, ...request]);
    }
    const sql = new TextDecoder().decode(request);
    if (sql.includes('SELECT')) {
      return backendSingleValueResponse('hello');
    }
    if (sql.includes('INSERT')) {
      return backendCommandResponse('INSERT 0 3');
    }
    if (sql.includes('UPDATE')) {
      return backendCommandResponse('UPDATE 2');
    }
    if (sql.includes('BEGIN')) {
      return backendCommandResponse('BEGIN', 0x54);
    }
    if (sql.includes('COMMIT')) {
      return backendCommandResponse('COMMIT');
    }
    if (sql.includes('ROLLBACK')) {
      return backendCommandResponse('ROLLBACK');
    }
    return backendCommandResponse('CHECKPOINT');
  }

  async backupJsi(_handle: number): Promise<Uint8Array> {
    return encoder.encode('physical-backup');
  }

  async restoreJsi(
    destination: {
      storageKind: 'directory' | 'applicationData';
      storagePath?: string;
      storageName?: string;
    },
    artifact: Uint8Array,
  ): Promise<void> {
    this.restoreCalls.push({
      destination,
      payload: new TextDecoder().decode(artifact),
    });
  }

  requestTexts(): string[] {
    return this.execRequests.map((request) => new TextDecoder().decode(request));
  }
}

type GlobalWithJsi = typeof globalThis & {
  __oliphauntReactNativeJsi?: {
    version: 1;
    execProtocolRaw(handle: number, request: Uint8Array): Promise<ArrayBuffer | ArrayBufferView>;
    execProtocolStream(
      handle: number,
      request: Uint8Array,
      onChunk: (chunk: ArrayBuffer | ArrayBufferView) => JsiProtocolChunkResult,
    ): Promise<void>;
    backup(handle: number): Promise<ArrayBuffer | ArrayBufferView>;
    restore(
      destination: {
        storageKind: 'directory' | 'applicationData';
        storagePath?: string;
        storageName?: string;
      },
      artifact: Uint8Array,
    ): Promise<void>;
  };
};

function backendSingleValueResponse(value: string): Uint8Array {
  const out: number[] = [];
  const description: number[] = [];
  pushI16(description, 1);
  description.push(...encoder.encode('value'), 0);
  pushI32(description, 0);
  pushI16(description, 0);
  pushI32(description, 25);
  pushI16(description, -1);
  pushI32(description, -1);
  pushI16(description, 0);
  pushMessage(out, 0x54, description);
  const bytes = encoder.encode(value);
  const row: number[] = [];
  pushI16(row, 1);
  pushI32(row, bytes.length);
  row.push(...bytes);
  pushMessage(out, 0x44, row);
  pushMessage(out, 0x43, [...encoder.encode('SELECT 1'), 0]);
  pushMessage(out, 0x5a, [0x49]);
  return Uint8Array.from(out);
}

function backendCommandResponse(commandTag: string, status = 0x49): Uint8Array {
  const out: number[] = [];
  pushMessage(out, 0x43, [...encoder.encode(commandTag), 0]);
  pushMessage(out, 0x5a, [status]);
  return Uint8Array.from(out);
}

function backendResponse(messages: ReadonlyArray<readonly [number, number[]]>): Uint8Array {
  const out: number[] = [];
  for (const [tag, body] of messages) {
    pushMessage(out, tag, body);
  }
  return Uint8Array.from(out);
}

function pushMessage(out: number[], tag: number, body: number[]): void {
  out.push(tag);
  pushI32(out, body.length + 4);
  out.push(...body);
}

function pushI32(out: number[], value: number): void {
  const bits = value >>> 0;
  out.push((bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff);
}

function pushI16(out: number[], value: number): void {
  const bits = value & 0xffff;
  out.push((bits >>> 8) & 0xff, bits & 0xff);
}

test('client', async () => {
  await main();
});
