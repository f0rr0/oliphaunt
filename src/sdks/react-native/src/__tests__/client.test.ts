import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import {
  createOliphauntClient,
  type ForgottenDatabase,
  type ForgottenDatabaseRegistry,
} from '../client';
import type {
  BinaryQueryParameter,
  EncodedQueryParameter,
  NullQueryParameter,
  OliphauntDatabase,
  QueryArrayRow,
  QueryObjectRow,
  QueryParam,
  QueryResult,
  QueryValue,
  TextQueryParameter,
} from '../index';
import type { JsiProtocolChunkResult } from '../jsiTransport';
import { parseCommandResponse, text } from '../query';
import type { Spec } from '../specs/NativeOliphaunt';

// OLIPHAUNT_DOCS_SNIPPET react-native-quickstart
// liboliphaunt-doc-example:react-native-open-query

const encoder = new TextEncoder();

function assertPublicHelperTypes(
  _text: TextQueryParameter,
  _binary: BinaryQueryParameter,
  _null: NullQueryParameter,
): void {}
void assertPublicHelperTypes;

function assertInferredQueryTypes(database: OliphauntDatabase): void {
  const arrays: Promise<QueryResult<QueryArrayRow>> = database.query('SELECT 1', [], {
    rowMode: 'array',
  });
  const decoded: Promise<QueryResult<QueryObjectRow<QueryValue | Date>>> = database.query(
    'SELECT now()',
    [],
    { decoders: { 1184: (value) => new Date(value) } },
  );
  // @ts-expect-error Stream callbacks are synchronous backpressure acknowledgements.
  const asyncStreamed = database.execProtocolRawStream(Uint8Array.of(1), async () => {});
  const widenedAsyncCallback: (chunk: Uint8Array) => unknown = async () => {};
  const widenedAsyncStreamed = database.execProtocolRawStream(
    Uint8Array.of(1),
    // @ts-expect-error Widening an async callback must not bypass the synchronous contract.
    widenedAsyncCallback,
  );
  void [arrays, decoded, asyncStreamed, widenedAsyncStreamed];
}
void assertInferredQueryTypes;
const plainJsonParameter: QueryParam = {
  format: 'text',
  value: 'plain JSON data',
};
// @ts-expect-error Encoded parameters must be created by an exported helper.
const forgedEncodedParameter: EncodedQueryParameter = {
  format: 'text',
  value: 'forged',
};
void [plainJsonParameter, forgedEncodedParameter];

async function main(): Promise<void> {
  await testPublicEntrypointIsMinimal();
  await testStartupGUCValidation();
  await testOpenUsesNativeDirectDefaults();
  await testExecuteReturnsPostgresCommandMetadata();
  await testExecuteSupportsParameters();
  await testExecuteRejectsRows();
  testCommandParserRejectsUnknownAndCopyMessages();
  await testQueryReturnsRowsAndCommandMetadata();
  await testRawArrayExecAndDescribe();
  await testPhysicalSessionFifo();
  await testQueuedInputsAndCodecsAreSnapshotted();
  await testQueuedTransactionInputsAndCodecsAreSnapshotted();
  await testDescribeNoticesMergeIntoLogicalQuery();
  await testDecoderFailureAfterReadyDoesNotPoison();
  await testMultipleReadyMessagesPoisonTheHandle();
  await testUnexpectedTransactionStatusRecovers();
  await testRecoveryFailuresRejectCurrentOperationAndPoison();
  await testMalformedReadinessPoisonsTheHandle();
  await testRawProtocolSqlAndCancel();
  await testRawProtocolTransportFailuresPoison();
  await testCancelCanInterruptWorkAdmittedBeforeClose();
  await testForgottenHandleCleanupIsGenerationBound();
  await testProtocolStreamCallbackFailure();
  await testProtocolStreamRecoveryFailuresPoison();
  await testPhysicalBackupAndStaticRestore();
  await testTransactionsCommitAndRollback();
  await testTransactionPromiseMethodsNeverThrowSynchronously();
  await testCallbackAndRollbackFailuresAreBothPreserved();
  await testCallbackAndIndependentDatabaseFailuresAreBothPreserved();
  await testExplicitRollbackSkipsCommit();
  await testCaughtRollbackFailureCannotCommit();
  await testUnawaitedFailedStatementRetainsPostgresError();
  await testCaughtFailureCanRecoverToSavepoint();
  await testCommitRollbackIsKnownAndReusable();
  await testUncertainCommitPoisonsTheHandle();
  await testTransactionOwnershipEscapePoisonsTheHandle();
  await testTransactionCommandTagsPoisonBeforeParsing();
  await testCommitNonIdleDoesNotSendRollback();
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

  const duplicateNative = new MockNative();
  const duplicateDb = await createOliphauntClient(duplicateNative).open({
    startupGUCs: { WORK_MEM: '8MB', search_path: 'public', work_mem: '16MB' },
  });
  assert.deepEqual((duplicateNative.openCalls[0] as { startupGUCs?: string[] }).startupGUCs, [
    'search_path=public',
    'work_mem=16MB',
  ]);
  await duplicateDb.close();

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
  for (const name of ['CONFIG_FILE', 'data_directory']) {
    const rejectedNative = new MockNative();
    await assert.rejects(
      () =>
        createOliphauntClient(rejectedNative).open({
          startupGUCs: { [name]: 'override' },
        }),
      /Oliphaunt owns PostgreSQL startup GUC.*configure database storage/,
    );
    assert.equal(rejectedNative.openCalls.length, 0);
  }
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
    assert.deepEqual(Object.keys(entrypoint).sort(), [
      'Oliphaunt',
      'PostgresError',
      'array',
      'binary',
      'default',
      'json',
      'postgresOids',
      'text',
      'typedNull',
    ]);
    assert.equal(entrypoint.default, entrypoint.Oliphaunt);
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
    notices: [],
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
    notices: [],
  });
  assert.deepEqual(native.execRequests.slice(-2).map(frontendMessageTags), [
    ['P', 'D', 'S'],
    ['P', 'B', 'D', 'E', 'S'],
  ]);
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
    notices: [],
  });
}

async function testQueryReturnsRowsAndCommandMetadata(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const result = await db.query('SELECT $1::text AS value', ['hello']);

  assert.deepEqual(result.rows, [{ value: 'hello' }]);
  assert.equal(result.kind, 'rows');
  assert.equal(result.commandTag, 'SELECT 1');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(native.execRequests.slice(-2).map(frontendMessageTags), [
    ['P', 'D', 'S'],
    ['P', 'B', 'D', 'E', 'S'],
  ]);
  await db.close();
}

async function testRawArrayExecAndDescribe(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const raw = await db.queryRaw('SELECT $1::text AS value', ['hello']);
  assert.equal(raw.getText(0, 'value'), 'hello');
  assert.deepEqual(
    raw.rows[0]?.values.map((value) => value && new TextDecoder().decode(value)),
    ['hello'],
  );

  const arrayResult = await db.query<unknown[]>('SELECT 1 AS value', [], {
    rowMode: 'array',
  });
  assert.deepEqual(arrayResult.rows, [['hello']]);

  const execResult = await db.exec('CREATE TABLE items; SELECT 1 AS value');
  assert.equal(execResult.statements[0]?.kind, 'command');
  assert.deepEqual(execResult.statements[1]?.rows, [{ value: 'hello' }]);

  const description = await db.describe('SELECT $1::text AS value');
  assert.deepEqual(description.parameterTypeOids, [25]);
  assert.equal(description.fields?.[0]?.name, 'value');
  assert.equal(frontendMessageTags(native.execRequests.at(-1) ?? new Uint8Array()).join(''), 'PDS');
  await db.close();
}

async function testPhysicalSessionFifo(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const gate = deferred<void>();
  const started = deferred<void>();
  native.pauseNextRequest = gate.promise;
  native.onPausedRequest = () => started.resolve();

  const first = db.query('SELECT $1::text AS value', ['first']);
  await started.promise;
  const second = db.query('SELECT $1::text AS value', ['second']);
  await Promise.resolve();
  assert.equal(native.execRequests.length, 1, 'the second logical operation must remain queued');
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(native.execRequests.map(frontendMessageTags), [
    ['P', 'D', 'S'],
    ['P', 'B', 'D', 'E', 'S'],
    ['P', 'D', 'S'],
    ['P', 'B', 'D', 'E', 'S'],
  ]);
  await db.close();
}

async function testQueuedInputsAndCodecsAreSnapshotted(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const gate = deferred<void>();
  const started = deferred<void>();
  native.pauseNextRequest = gate.promise;
  native.onPausedRequest = () => started.resolve();
  const blocker = db.query('SELECT $1::text AS value', ['blocker']);
  await started.promise;

  const parameters = ['before'];
  const decoders: Record<number, (value: string) => string> = {
    25: (value) => `before:${value}`,
  };
  const queued = db.query('SELECT $1::text AS value', parameters, { decoders });
  parameters[0] = 'after';
  decoders[25] = (value) => `after:${value}`;

  const rawInput = Uint8Array.of(0xaa);
  const raw = db.execProtocolRaw(rawInput);
  rawInput[0] = 0xbb;
  gate.resolve();
  await blocker;
  assert.deepEqual((await queued).rows, [{ value: 'before:hello' }]);
  assert.match(native.requestTexts().find((request) => request.includes('before')) ?? '', /before/);
  assert.deepEqual(Array.from(await raw), [1, 0xaa]);
  await db.close();
}

async function testQueuedTransactionInputsAndCodecsAreSnapshotted(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await db.transaction(async (transaction) => {
    const gate = deferred<void>();
    const started = deferred<void>();
    native.pauseNextRequest = gate.promise;
    native.onPausedRequest = () => started.resolve();
    const blocker = transaction.query('SELECT $1::text AS value', ['blocker']);
    await started.promise;

    const executeParameters = ['execute-before'];
    const rawParameters = ['raw-before'];
    const queryParameters = ['query-before'];
    const queryEncoders: Record<
      number,
      (value: QueryParam, typeOid: number) => EncodedQueryParameter
    > = {
      25: () => text('encoded-before', 25),
    };
    const queryDecoders: Record<number, (value: string) => string> = {
      25: (value) => `decoded-before:${value}`,
    };
    const execDecoders: Record<number, (value: string) => string> = {
      25: (value) => `exec-before:${value}`,
    };
    const parameterTypeOids = [25];

    const queuedExecute = transaction.execute('UPDATE items SET value = $1', executeParameters);
    const queuedQuery = transaction.query('SELECT $1::text AS value', queryParameters, {
      encoders: queryEncoders,
      decoders: queryDecoders,
    });
    const queuedRaw = transaction.queryRaw('SELECT $1::text AS value', rawParameters);
    const queuedExec = transaction.exec('CREATE TABLE items; SELECT 1 AS value', {
      decoders: execDecoders,
    });
    const queuedDescribe = transaction.describe('SELECT $1 AS value', parameterTypeOids);

    executeParameters[0] = 'execute-after';
    rawParameters[0] = 'raw-after';
    queryParameters[0] = 'query-after';
    queryEncoders[25] = () => text('encoded-after', 25);
    queryDecoders[25] = (value) => `decoded-after:${value}`;
    execDecoders[25] = (value) => `exec-after:${value}`;
    parameterTypeOids[0] = -1;

    gate.resolve();
    await blocker;
    await queuedExecute;
    assert.deepEqual((await queuedQuery).rows, [{ value: 'decoded-before:hello' }]);
    assert.equal((await queuedRaw).getText(0, 'value'), 'hello');
    assert.deepEqual((await queuedExec).statements[1]?.rows, [{ value: 'exec-before:hello' }]);
    assert.deepEqual((await queuedDescribe).parameterTypeOids, [25]);

    const requests = native.requestTexts().join('\n');
    assert.match(requests, /execute-before/);
    assert.match(requests, /encoded-before/);
    assert.match(requests, /raw-before/);
    assert.doesNotMatch(requests, /execute-after|encoded-after|raw-after/);
  });

  await db.close();
}

async function testDescribeNoticesMergeIntoLogicalQuery(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.noticeOnDescribeOnce = true;
  const result = await db.query('SELECT $1::text AS value', ['hello']);
  assert.deepEqual(
    result.notices.map((notice) => notice.message),
    ['described'],
  );

  for (const thrown of [Object.freeze(new Error('frozen encoder failure')), 'primitive failure']) {
    native.noticeOnDescribeOnce = true;
    const failure = await db
      .query('SELECT $1::text AS value', ['hello'], {
        encoders: {
          25: () => {
            throw thrown;
          },
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failure instanceof Error);
    assert.notEqual(failure, thrown);
    assert.equal((failure as Error & { cause?: unknown }).cause, thrown);
    assert.deepEqual(
      (failure as Error & { notices: Array<{ message: string }> }).notices.map(
        (notice) => notice.message,
      ),
      ['described'],
    );
  }
  await db.close();
}

async function testDecoderFailureAfterReadyDoesNotPoison(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.noticeOnExecOnce = true;
  const thrown = { message: 'decoder failed' };
  const failure = await db
    .exec('CREATE TABLE items; SELECT 1 AS value', {
      decoders: {
        25: () => {
          throw thrown;
        },
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /could not parse the PostgreSQL response/);
  assert.equal((failure as Error & { cause?: unknown }).cause, thrown);
  assert.deepEqual(
    (failure as Error & { notices: Array<{ message: string }> }).notices.map(
      (notice) => notice.message,
    ),
    ['exec notice'],
  );
  assert.deepEqual((await db.query('SELECT 1 AS value')).rows, [{ value: 'hello' }]);
  await db.close();
}

async function testMultipleReadyMessagesPoisonTheHandle(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.appendReadyOnce = true;
  await assert.rejects(() => db.execute('UPDATE items SET value = value'), /after ReadyForQuery/);
  await assert.rejects(
    Promise.resolve().then(() => db.query('SELECT 1')),
    /session state is unknown/,
  );
  await db.close();
}

async function testUnexpectedTransactionStatusRecovers(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.nextReadyStatus = 0x54;
  await assert.rejects(
    () => db.execute('UPDATE items SET value = value'),
    /transaction status 'transaction'/,
  );
  assert.match(native.requestTexts().at(-1) ?? '', /ROLLBACK/);
  assert.deepEqual((await db.query('SELECT 1 AS value')).rows, [{ value: 'hello' }]);
  await db.close();
}

async function testRecoveryFailuresRejectCurrentOperationAndPoison(): Promise<void> {
  for (const mode of ['transport', 'wrong-boundary'] as const) {
    const native = new MockNative();
    const db = await createOliphauntClient(native).open();
    native.nextReadyStatus = 0x54;
    if (mode === 'transport') native.failRollbackOnce = true;
    else native.wrongRollbackBoundaryOnce = true;

    const failure = await db.execute('UPDATE items SET value = value').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AggregateError);
    assert.match(
      failure.message,
      /operation failed and automatic ROLLBACK could not prove recovery/,
    );
    assert.match(String(failure.errors[0]), /transaction status 'transaction'/);
    assert.match(
      String(failure.errors[1]),
      mode === 'transport'
        ? /ROLLBACK transport failed/
        : /expected ROLLBACK\/idle, got COMMIT\/transaction/,
    );

    const nextFailure = await Promise.resolve()
      .then(() => db.query('SELECT 1'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(nextFailure instanceof Error);
    assert.match(nextFailure.message, /session state is unknown/);
    assert.equal((nextFailure as Error & { cause?: unknown }).cause, failure);
    await db.close();
  }
}

async function testMalformedReadinessPoisonsTheHandle(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.omitReadyOnce = true;
  await assert.rejects(() => db.execute('UPDATE items SET value = value'), /ReadyForQuery/);
  await assert.rejects(
    Promise.resolve().then(() => db.query('SELECT 1')),
    /session state is unknown/,
  );
  assert.equal(db.closed, false);
  await db.close();
  assert.equal(db.closed, true);
}

async function testRawProtocolSqlAndCancel(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  assert.deepEqual(Array.from(await db.execProtocolRaw(Uint8Array.from([0xaa]))), [1, 0xaa]);
  const chunks: Uint8Array[] = [];
  await db.execProtocolRawStream(Uint8Array.from([0xbb]), (chunk) => {
    chunks.push(chunk);
  });
  assert.deepEqual(
    chunks.map((chunk) => Array.from(chunk)),
    [[1], [0xbb]],
  );
  await db.execute('CHECKPOINT');
  assert.match(native.requestTexts().at(-1) ?? '', /CHECKPOINT/);
  await db.cancel();
  assert.deepEqual(native.cancelledHandles, [1]);
  await db.close();
}

async function testRawProtocolTransportFailuresPoison(): Promise<void> {
  const publicNative = new MockNative();
  const publicDatabase = await createOliphauntClient(publicNative).open();
  const publicFailure = new Error('raw protocol transport failed');
  publicNative.rawTransportFailure = publicFailure;
  await assert.rejects(
    () => publicDatabase.execProtocolRaw(Uint8Array.of(0xaa)),
    (error) => error === publicFailure,
  );
  publicNative.rawTransportFailure = undefined;
  const publicCalls = publicNative.execRequests.length;
  await assert.rejects(() => publicDatabase.query('SELECT 1'), /session state is unknown/);
  assert.equal(publicNative.execRequests.length, publicCalls);
  await publicDatabase.close();
}

async function testCancelCanInterruptWorkAdmittedBeforeClose(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const gate = deferred<void>();
  const started = deferred<void>();
  native.pauseNextRequest = gate.promise;
  native.onPausedRequest = () => started.resolve();

  const query = db.query('SELECT $1::text AS value', ['running']);
  await started.promise;
  const closing = db.close();
  const cancelGate = deferred<void>();
  const cancelStarted = deferred<void>();
  native.pauseCancel = cancelGate.promise;
  native.onCancelStarted = () => cancelStarted.resolve();
  const cancellation = db.cancel();
  await cancelStarted.promise;
  assert.deepEqual(native.cancelledHandles, [1]);
  const closeGate = deferred<void>();
  const closeStarted = deferred<void>();
  native.pauseClose = closeGate.promise;
  native.onCloseStarted = () => closeStarted.resolve();
  gate.resolve();
  await query;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    native.closedHandles,
    [],
    'native close must wait for cancellation admitted before teardown',
  );
  cancelGate.resolve();
  await cancellation;
  await closeStarted.promise;
  await assert.rejects(() => db.cancel(), /closed/);
  closeGate.resolve();
  await closing;
  await assert.rejects(() => db.cancel(), /closed/);
}

async function testForgottenHandleCleanupIsGenerationBound(): Promise<void> {
  const native = new MockNative();
  const registry = new MockForgottenDatabaseRegistry();
  const client = createOliphauntClient(native, registry);
  await client.open();
  const first = registry.registrations[0];
  assert.ok(first);
  assert.equal(first.held.generation, 1);

  first.held.transport.closeIfGeneration(first.held.generation);
  assert.deepEqual(native.forgottenClosedGenerations, [1]);

  const current = await client.open();
  const second = registry.registrations[1];
  assert.ok(second);
  assert.equal(second.held.generation, 2);
  first.held.transport.closeIfGeneration(first.held.generation);
  assert.deepEqual(
    native.forgottenClosedGenerations,
    [1],
    'stale cleanup must not touch the current generation',
  );

  await current.close();
  assert.equal(registry.unregistered.includes(second.target), true);
  assert.deepEqual(native.closedHandles, [2]);
}

async function testProtocolStreamCallbackFailure(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const failure = new Error('chunk consumer failed');
  await assert.rejects(
    () =>
      db.execProtocolRawStream(Uint8Array.from([0xcc]), () => {
        throw failure;
      }),
    (error) => error === failure,
  );

  native.swallowStreamCallbackErrors = true;
  let callbackCalls = 0;
  await assert.rejects(
    () =>
      db.execProtocolRawStream(Uint8Array.from([0xcd]), () => {
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
      .execProtocolRawStream(Uint8Array.from([0xce]), () => {
        throw thrown;
      })
      .then(
        () => ({ fulfilled: true as const, error: undefined }),
        (error: unknown) => ({ fulfilled: false as const, error }),
      );
    assert.equal(outcome.fulfilled, false);
    assert.ok(Object.is(outcome.error, thrown));
  }

  const dynamicallyTypedInvalidCallbacks: Array<(chunk: Uint8Array) => unknown> = [
    async () => undefined,
    () => ({ then: () => undefined }),
  ];
  for (const callback of dynamicallyTypedInvalidCallbacks) {
    await assert.rejects(
      () =>
        db.execProtocolRawStream(
          Uint8Array.from([0xcf]),
          callback as unknown as (chunk: Uint8Array) => undefined,
        ),
      /must complete synchronously.*Promise or thenable/,
    );
  }

  const databaseReentryCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['execute', () => db.execute("UPDATE items SET value = 'forbidden reentry'")],
    ['query', () => db.query("SELECT 'forbidden reentry'")],
    ['queryRaw', () => db.queryRaw("SELECT 'forbidden reentry'")],
    ['exec', () => db.exec("SELECT 'forbidden reentry'")],
    ['describe', () => db.describe("SELECT 'forbidden reentry'")],
    ['execProtocolRaw', () => db.execProtocolRaw(Uint8Array.of(0xaa))],
    ['execProtocolRawStream', () => db.execProtocolRawStream(Uint8Array.of(0xaa), () => undefined)],
    ['backup', () => db.backup()],
    ['transaction', () => db.transaction(() => undefined)],
    ['close', () => db.close()],
    ['asyncDispose', () => db[Symbol.asyncDispose]()],
  ];
  const requestCountBeforeDatabaseReentry = native.execRequests.length;
  for (const [index, [name, call]] of databaseReentryCalls.entries()) {
    let reentryOutcome:
      | Promise<{ fulfilled: true; error?: never } | { fulfilled: false; error: unknown }>
      | undefined;
    await db.execProtocolRawStream(Uint8Array.of(0xd0 + index), () => {
      if (reentryOutcome !== undefined) return;
      const returned = call();
      reentryOutcome = returned.then(
        () => ({ fulfilled: true as const }),
        (error: unknown) => ({ fulfilled: false as const, error }),
      );
    });
    assert.ok(reentryOutcome, `${name} callback reentry must return a Promise`);
    const outcome = await reentryOutcome;
    assert.equal(outcome.fulfilled, false, `${name} callback reentry must reject`);
    if (!outcome.fulfilled) {
      assert.match(
        String(outcome.error),
        /must not reenter the same Oliphaunt database or transaction/,
        name,
      );
    }
  }
  assert.equal(
    native.execRequests.length,
    requestCountBeforeDatabaseReentry + databaseReentryCalls.length,
  );
  assert.equal(
    native.requestTexts().some((sql) => sql.includes('forbidden reentry')),
    false,
  );
  assert.equal(db.closed, false);

  await db.query('SELECT 1');
  await db.close();
}

async function testProtocolStreamRecoveryFailuresPoison(): Promise<void> {
  const publicNative = new MockNative();
  const publicDatabase = await createOliphauntClient(publicNative).open();
  const callbackFailure = new Error('protocol stream callback failed');
  const publicFailure = new Error('native protocol stream recovery failed');
  publicNative.streamRecoveryFailure = publicFailure;
  await assert.rejects(
    () =>
      publicDatabase.execProtocolRawStream(Uint8Array.of(0xcd), () => {
        throw callbackFailure;
      }),
    (error) => error === publicFailure,
  );
  publicNative.streamRecoveryFailure = undefined;
  const publicCalls = publicNative.execRequests.length;
  await assert.rejects(() => publicDatabase.query('SELECT 1'), /session state is unknown/);
  assert.equal(publicNative.execRequests.length, publicCalls);
  await publicDatabase.close();
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
    return (await transaction.query('SELECT $1::text AS value', ['hello'])).rows[0]?.value;
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

async function testTransactionPromiseMethodsNeverThrowSynchronously(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await db.transaction(async (transaction) => {
    assert.equal('execProtocolRaw' in transaction, false);
    assert.equal('execProtocolRawStream' in transaction, false);
    const invalidCalls: ReadonlyArray<() => Promise<unknown>> = [
      () => transaction.execute('SELECT\0invalid'),
      () => transaction.query('SELECT\0invalid'),
      () => transaction.queryRaw('SELECT\0invalid'),
      () => transaction.exec('COPY items TO STDOUT'),
      () => transaction.describe('SELECT 1', [-1]),
    ];
    for (const call of invalidCalls) {
      await assertRejectsWithoutSynchronousThrow(call);
    }

    const chainCalls: ReadonlyArray<() => Promise<unknown>> = [
      () => transaction.execute('ROLLBACK AND CHAIN'),
      () => transaction.query('ABORT WORK AND CHAIN'),
      () => transaction.queryRaw('ROLLBACK TRANSACTION /* ownership */ AND CHAIN'),
      () => transaction.exec('SELECT 1; RoLlBaCk AND /* comment */ CHAIN'),
    ];
    for (const call of chainCalls) {
      await assertRejectsWithoutSynchronousThrow(
        call,
        /do not support ROLLBACK\/ABORT .* AND CHAIN/,
      );
    }
    assert.deepEqual(
      native.requestTexts().filter((sql) => sql.includes('CHAIN')),
      [],
    );

    await transaction.rollback();
    const expiredCalls: ReadonlyArray<() => Promise<unknown>> = [
      () => transaction.execute('UPDATE items SET value = 1'),
      () => transaction.query('SELECT 1'),
      () => transaction.queryRaw('SELECT 1'),
      () => transaction.exec('SELECT 1'),
      () => transaction.describe('SELECT 1'),
      () => transaction.rollback(),
    ];
    for (const call of expiredCalls) {
      await assertRejectsWithoutSynchronousThrow(call, /no longer active/);
    }
  });

  await db.close();
}

async function assertRejectsWithoutSynchronousThrow(
  call: () => Promise<unknown>,
  expected?: RegExp,
): Promise<void> {
  let result: Promise<unknown> | undefined;
  assert.doesNotThrow(() => {
    result = call();
  });
  assert.ok(result);
  if (expected === undefined) {
    await assert.rejects(result);
  } else {
    await assert.rejects(result, expected);
  }
}

async function testCallbackAndRollbackFailuresAreBothPreserved(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const bodyFailure = new Error('body failed before rollback');
  native.failRollbackOnce = true;

  await assert.rejects(
    () => db.transaction(() => Promise.reject(bodyFailure)),
    (failure: unknown) => {
      assert.ok(failure instanceof AggregateError);
      assert.match(failure.message, /automatic ROLLBACK could not prove recovery/);
      assert.equal(failure.errors[0], bodyFailure);
      assert.match(String(failure.errors[1]), /ROLLBACK transport failed/);
      return true;
    },
  );
  await assert.rejects(
    Promise.resolve().then(() => db.query('SELECT 1')),
    /session state is unknown/,
  );
  await db.close();
}

async function testCallbackAndIndependentDatabaseFailuresAreBothPreserved(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const transportFailure = new Error('transaction transport outcome is unknown');
  const businessFailure = new Error('business callback failed');
  let caughtDatabaseFailure: unknown;

  const combined = await db
    .transaction(async (transaction) => {
      native.rawTransportFailure = transportFailure;
      try {
        await transaction.query('SELECT transport_failure');
      } catch (error) {
        caughtDatabaseFailure = error;
      }
      throw businessFailure;
    })
    .catch((error: unknown) => error);

  assert.ok(combined instanceof AggregateError);
  assert.deepEqual(combined.errors, [businessFailure, caughtDatabaseFailure]);
  assert.match(combined.message, /independent database failure/);
  const requestCount = native.execRequests.length;
  await assert.rejects(() => db.query('SELECT never_runs'), /session state is unknown/);
  assert.equal(native.execRequests.length, requestCount);
  await db.close();
}

async function testExplicitRollbackSkipsCommit(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const value = await db.transaction(async (transaction) => {
    assert.equal(transaction.closed, false);
    await transaction.rollback();
    assert.equal(transaction.closed, true);
    await assert.rejects(() => transaction.rollback(), /no longer active/);
    return 42;
  });
  assert.equal(value, 42);
  const controls = native
    .requestTexts()
    .filter((request) => /BEGIN|COMMIT|ROLLBACK/.test(request))
    .join('\n');
  assert.match(controls, /BEGIN/);
  assert.match(controls, /ROLLBACK/);
  assert.doesNotMatch(controls, /COMMIT/);
  await db.close();
}

async function testCaughtRollbackFailureCannotCommit(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.failRollbackOnce = true;
  await assert.rejects(
    () =>
      db.transaction(async (transaction) => {
        await transaction.rollback().catch(() => undefined);
        return 'must not escape';
      }),
    /ROLLBACK transport failed/,
  );
  assert.equal(db.closed, false);
  await db.close();
}

async function testUnawaitedFailedStatementRetainsPostgresError(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.failStatementOnce = true;
  let observedFailure: Promise<unknown> | undefined;

  await assert.rejects(
    () =>
      db.transaction((transaction) => {
        observedFailure = transaction.execute('SELECT rejected').then(
          () => undefined,
          (error: unknown) => error,
        );
        return 42;
      }),
    (failure: unknown) => {
      assert.equal((failure as { sqlstate?: unknown }).sqlstate, 'XX000');
      assert.match(String(failure), /queued operation failed/);
      return true;
    },
  );
  assert.equal(((await observedFailure) as { sqlstate?: unknown }).sqlstate, 'XX000');
  const controls = native.requestTexts().filter((request) => /BEGIN|COMMIT|ROLLBACK/.test(request));
  assert.equal(controls.filter((request) => request.includes('COMMIT')).length, 1);
  assert.equal(controls.filter((request) => request.includes('ROLLBACK')).length, 0);
  assert.deepEqual((await db.query('SELECT recovered')).rows, [{ value: 'hello' }]);
  await db.close();
}

async function testCaughtFailureCanRecoverToSavepoint(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.failStatementOnce = true;

  const value = await db.transaction(async (transaction) => {
    await transaction.execute('SAVEPOINT retry');
    await assert.rejects(
      () => transaction.execute('SELECT rejected'),
      (failure: unknown) => (failure as { sqlstate?: unknown }).sqlstate === 'XX000',
    );
    await transaction.execute('ROLLBACK TO SAVEPOINT retry');
    await transaction.query('SELECT recovered');
    return 42;
  });
  assert.equal(value, 42);
  const requests = native.requestTexts().join('\n');
  assert.match(requests, /SAVEPOINT retry/);
  assert.match(requests, /ROLLBACK TO SAVEPOINT retry/);
  assert.match(requests, /COMMIT/);
  await db.close();
}

async function testCommitRollbackIsKnownAndReusable(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.commitAsRollbackOnce = true;
  await assert.rejects(() => db.transaction(() => 'not committed'), /got ROLLBACK\/idle/);
  assert.deepEqual((await db.query('SELECT 1 AS value')).rows, [{ value: 'hello' }]);
  await db.close();
}

async function testUncertainCommitPoisonsTheHandle(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  native.malformedCommitOnce = true;
  await assert.rejects(
    () => db.transaction(() => 'unknown'),
    /omitted .*Complete|statement completion/,
  );
  await assert.rejects(
    Promise.resolve().then(() => db.query('SELECT 1')),
    /session state is unknown/,
  );
  await db.close();
}

async function testTransactionOwnershipEscapePoisonsTheHandle(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  await assert.rejects(
    () =>
      db.transaction(async (transaction) => {
        native.nextReadyStatus = 0x49;
        await transaction.query('SELECT 1').catch(() => undefined);
        return 'must not commit';
      }),
    /ended PostgreSQL transaction ownership/,
  );
  await assert.rejects(
    Promise.resolve().then(() => db.query('SELECT 1')),
    /session state is unknown/,
  );
  await db.close();
}

async function testTransactionCommandTagsPoisonBeforeParsing(): Promise<void> {
  const cases = [
    {
      response: backendResponse([
        [0x43, [...encoder.encode('COMMIT'), 0]],
        [0x43, [...encoder.encode('BEGIN'), 0]],
        [0x45, postgresDiagnostic('ERROR', 'XX000', 'later failure')],
        [0x5a, [0x54]],
      ]),
      expected: /command tag COMMIT/,
    },
    {
      response: backendResponse([
        [0x43, [...encoder.encode('ROLLBACK'), 0]],
        [0x43, [...encoder.encode('BEGIN'), 0]],
        [0x5a, [0x54]],
      ]),
      expected: /command tag BEGIN/,
    },
  ];

  for (const entry of cases) {
    const native = new MockNative();
    const db = await createOliphauntClient(native).open();
    await assert.rejects(
      () =>
        db.transaction((transaction) => {
          native.nextRawResponse = entry.response;
          const ignored = transaction.exec('SELECT ownership_escape');
          void ignored.catch(() => undefined);
        }),
      entry.expected,
    );
    const controls = native
      .requestTexts()
      .filter((request) => /BEGIN|COMMIT|ROLLBACK/.test(request));
    assert.equal(controls.length, 1);
    assert.match(controls[0] ?? '', /BEGIN/);
    const requestCount = native.execRequests.length;
    await assert.rejects(() => db.query('SELECT 1'), /session state is unknown/);
    assert.equal(native.execRequests.length, requestCount);
    await db.close();
  }
}

async function testCommitNonIdleDoesNotSendRollback(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  await assert.rejects(
    () =>
      db.transaction(() => {
        native.nextReadyStatus = 0x54;
        return 'unknown';
      }),
    /got COMMIT\/transaction/,
  );
  const controls = native.requestTexts().filter((request) => /BEGIN|COMMIT|ROLLBACK/.test(request));
  assert.equal(controls.filter((request) => request.includes('ROLLBACK')).length, 0);
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
  streamRecoveryFailure?: Error;
  rawTransportFailure?: Error;
  streamChunkCallbackCalls = 0;
  pauseNextRequest?: Promise<void>;
  onPausedRequest?: () => void;
  pauseCancel?: Promise<void>;
  onCancelStarted?: () => void;
  pauseClose?: Promise<void>;
  onCloseStarted?: () => void;
  nextReadyStatus?: number;
  omitReadyOnce = false;
  failRollbackOnce = false;
  wrongRollbackBoundaryOnce = false;
  commitAsRollbackOnce = false;
  malformedCommitOnce = false;
  failStatementOnce = false;
  noticeOnDescribeOnce = false;
  noticeOnExecOnce = false;
  appendReadyOnce = false;
  nextRawResponse?: Uint8Array;
  readonly openCalls: unknown[] = [];
  readonly execRequests: Uint8Array[] = [];
  readonly cancelledHandles: number[] = [];
  readonly closedHandles: number[] = [];
  readonly forgottenClosedGenerations: number[] = [];
  readonly restoreCalls: Array<{
    destination: {
      storageKind: 'directory' | 'applicationData';
      storagePath?: string;
      storageName?: string;
    };
    payload: string;
  }> = [];
  #nextHandle = 1;
  readonly #pendingSql = new Map<number, string>();
  readonly #transactionStatus = new Map<number, number>();
  readonly #activeGenerations = new Set<number>();

  constructor() {
    const native = this;
    (globalThis as GlobalWithJsi).__oliphauntReactNativeJsi = {
      version: 1,
      closeIfGeneration(generation) {
        native.closeIfGenerationJsi(generation);
      },
      execProtocolRaw(handle, request) {
        return native.execProtocolRawJsi(handle, request);
      },
      async execProtocolStream(handle, request, onChunk) {
        const response = await native.execProtocolRawJsi(handle, request);
        const split = Math.max(1, Math.floor(response.byteLength / 2));
        for (const chunk of [response.subarray(0, split), response.subarray(split)]) {
          native.streamChunkCallbackCalls += 1;
          const result = onChunk(chunk);
          if (result?.__oliphauntProtocolChunkFailure) {
            if (native.streamRecoveryFailure !== undefined) {
              throw native.streamRecoveryFailure;
            }
            if (!native.swallowStreamCallbackErrors) {
              throw protocolCallbackAbortedError();
            }
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
    const handle = this.#nextHandle++;
    this.#transactionStatus.set(handle, 0x49);
    this.#activeGenerations.add(handle);
    return handle;
  }

  async cancel(handle: number): Promise<void> {
    this.cancelledHandles.push(handle);
    this.onCancelStarted?.();
    await this.pauseCancel;
  }

  async close(handle: number): Promise<void> {
    this.closedHandles.push(handle);
    this.onCloseStarted?.();
    await this.pauseClose;
    this.#activeGenerations.delete(handle);
  }

  closeIfGenerationJsi(generation: number): void {
    if (!this.#activeGenerations.delete(generation)) return;
    this.forgottenClosedGenerations.push(generation);
  }

  async execProtocolRawJsi(handle: number, request: Uint8Array): Promise<Uint8Array> {
    this.execRequests.push(request);
    if (this.rawTransportFailure !== undefined) throw this.rawTransportFailure;
    if (this.pauseNextRequest !== undefined) {
      const pause = this.pauseNextRequest;
      this.pauseNextRequest = undefined;
      this.onPausedRequest?.();
      await pause;
    }
    if (request[0] !== 0x51 && request[0] !== 0x50 && request[0] !== 0x42) {
      return Uint8Array.from([handle, ...request]);
    }
    const tags = frontendMessageTags(request);
    const sql = frontendSql(request) ?? this.#pendingSql.get(handle) ?? '';
    if (tags.join('') === 'PDS') {
      this.#pendingSql.set(handle, sql);
      const response = backendDescribeResponse(
        inferredParameterOids(sql),
        sql.includes('SELECT'),
        this.#transactionStatus.get(handle) ?? 0x49,
        this.noticeOnDescribeOnce ? 'described' : undefined,
      );
      this.noticeOnDescribeOnce = false;
      return response;
    }
    if (tags[0] === 'B') this.#pendingSql.delete(handle);
    if (this.nextRawResponse !== undefined) {
      const response = this.nextRawResponse;
      this.nextRawResponse = undefined;
      return response;
    }
    if (this.failRollbackOnce && sql.includes('ROLLBACK')) {
      this.failRollbackOnce = false;
      throw new Error('ROLLBACK transport failed');
    }
    if (request[0] === 0x51 && sql.includes(';')) {
      const response = backendMultiStatementResponse(
        this.#transactionStatus.get(handle) ?? 0x49,
        this.noticeOnExecOnce ? 'exec notice' : undefined,
      );
      this.noticeOnExecOnce = false;
      return response;
    }
    let status = this.#transactionStatus.get(handle) ?? 0x49;
    let response: Uint8Array;
    if (this.failStatementOnce && sql.includes('SELECT rejected')) {
      this.failStatementOnce = false;
      status = 0x45;
      this.#transactionStatus.set(handle, status);
      response = backendErrorResponse('XX000', 'queued operation failed', status);
    } else if (sql.includes('SELECT')) {
      response = backendSingleValueResponse('hello', this.#consumeReadyStatus(status));
    } else if (sql.includes('INSERT')) {
      response = backendCommandResponse('INSERT 0 3', this.#consumeReadyStatus(status));
    } else if (sql.includes('UPDATE')) {
      response = backendCommandResponse('UPDATE 2', this.#consumeReadyStatus(status));
    } else if (sql.includes('BEGIN')) {
      status = 0x54;
      this.#transactionStatus.set(handle, status);
      response = backendCommandResponse('BEGIN', this.#consumeReadyStatus(status));
    } else if (sql.includes('ROLLBACK TO SAVEPOINT')) {
      status = 0x54;
      this.#transactionStatus.set(handle, status);
      response = backendCommandResponse('ROLLBACK', this.#consumeReadyStatus(status));
    } else if (sql.includes('SAVEPOINT')) {
      response = backendCommandResponse('SAVEPOINT', this.#consumeReadyStatus(status));
    } else if (sql.includes('COMMIT')) {
      const transactionAborted = status === 0x45;
      status = 0x49;
      this.#transactionStatus.set(handle, status);
      if (this.malformedCommitOnce) {
        this.malformedCommitOnce = false;
        response = backendResponse([[0x5a, [this.#consumeReadyStatus(status)]]]);
      } else {
        const tag = this.commitAsRollbackOnce || transactionAborted ? 'ROLLBACK' : 'COMMIT';
        this.commitAsRollbackOnce = false;
        response = backendCommandResponse(tag, this.#consumeReadyStatus(status));
      }
    } else if (sql.includes('ROLLBACK')) {
      if (this.wrongRollbackBoundaryOnce) {
        this.wrongRollbackBoundaryOnce = false;
        status = 0x54;
        this.#transactionStatus.set(handle, status);
        response = backendCommandResponse('COMMIT', this.#consumeReadyStatus(status));
      } else {
        status = 0x49;
        this.#transactionStatus.set(handle, status);
        response = backendCommandResponse('ROLLBACK', this.#consumeReadyStatus(status));
      }
    } else {
      response = backendCommandResponse('CHECKPOINT', this.#consumeReadyStatus(status));
    }
    if (this.omitReadyOnce) {
      this.omitReadyOnce = false;
      return withoutReadyForQuery(response);
    }
    if (this.appendReadyOnce) {
      this.appendReadyOnce = false;
      response = concatenateBytes(response, backendResponse([[0x5a, [status]]]));
    }
    return response;
  }

  #consumeReadyStatus(fallback: number): number {
    const status = this.nextReadyStatus ?? fallback;
    this.nextReadyStatus = undefined;
    return status;
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

class MockForgottenDatabaseRegistry implements ForgottenDatabaseRegistry {
  readonly registrations: Array<{
    target: object;
    held: ForgottenDatabase;
    token: object;
  }> = [];
  readonly unregistered: object[] = [];

  register(target: object, held: ForgottenDatabase, token: object): void {
    this.registrations.push({ target, held, token });
  }

  unregister(token: object): boolean {
    this.unregistered.push(token);
    return true;
  }
}

type GlobalWithJsi = typeof globalThis & {
  __oliphauntReactNativeJsi?: {
    version: 1;
    closeIfGeneration(generation: number): void;
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

function protocolCallbackAbortedError(): Error {
  const error = new Error('protocol stream callback aborted after ReadyForQuery') as Error & {
    __oliphauntProtocolCallbackAborted: true;
  };
  error.__oliphauntProtocolCallbackAborted = true;
  return error;
}

function backendSingleValueResponse(value: string, status = 0x49): Uint8Array {
  const out: number[] = [];
  pushMessage(out, 0x31, []);
  pushMessage(out, 0x32, []);
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
  pushMessage(out, 0x5a, [status]);
  return Uint8Array.from(out);
}

function backendDescribeResponse(
  parameterTypeOids: ReadonlyArray<number>,
  returnsRows: boolean,
  status: number,
  notice?: string,
): Uint8Array {
  const out: number[] = [];
  pushMessage(out, 0x31, []);
  if (notice !== undefined) pushMessage(out, 0x4e, postgresDiagnostic('NOTICE', '00000', notice));
  const parameters: number[] = [];
  pushI16(parameters, parameterTypeOids.length);
  for (const typeOid of parameterTypeOids) pushI32(parameters, typeOid);
  pushMessage(out, 0x74, parameters);
  if (returnsRows) {
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
  } else {
    pushMessage(out, 0x6e, []);
  }
  pushMessage(out, 0x5a, [status]);
  return Uint8Array.from(out);
}

function backendMultiStatementResponse(status: number, notice?: string): Uint8Array {
  const out: number[] = [];
  pushMessage(out, 0x43, [...encoder.encode('CREATE TABLE'), 0]);
  if (notice !== undefined) pushMessage(out, 0x4e, postgresDiagnostic('NOTICE', '00000', notice));
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
  const bytes = encoder.encode('hello');
  const row: number[] = [];
  pushI16(row, 1);
  pushI32(row, bytes.length);
  row.push(...bytes);
  pushMessage(out, 0x44, row);
  pushMessage(out, 0x43, [...encoder.encode('SELECT 1'), 0]);
  pushMessage(out, 0x5a, [status]);
  return Uint8Array.from(out);
}

function backendCommandResponse(commandTag: string, status = 0x49): Uint8Array {
  const out: number[] = [];
  pushMessage(out, 0x31, []);
  pushMessage(out, 0x32, []);
  pushMessage(out, 0x6e, []);
  pushMessage(out, 0x43, [...encoder.encode(commandTag), 0]);
  pushMessage(out, 0x5a, [status]);
  return Uint8Array.from(out);
}

function backendErrorResponse(sqlstate: string, message: string, status: number): Uint8Array {
  return backendResponse([
    [0x31, []],
    [0x32, []],
    [0x45, postgresDiagnostic('ERROR', sqlstate, message)],
    [0x5a, [status]],
  ]);
}

function backendResponse(messages: ReadonlyArray<readonly [number, number[]]>): Uint8Array {
  const out: number[] = [];
  for (const [tag, body] of messages) {
    pushMessage(out, tag, body);
  }
  return Uint8Array.from(out);
}

function frontendMessageTags(request: Uint8Array): string[] {
  const tags: string[] = [];
  let offset = 0;
  while (offset < request.length) {
    tags.push(String.fromCharCode(request[offset] ?? 0));
    const length = readI32(request, offset + 1);
    offset += length + 1;
  }
  return tags;
}

function frontendSql(request: Uint8Array): string | undefined {
  if (request[0] === 0x51) {
    const end = request.indexOf(0, 5);
    return new TextDecoder().decode(request.subarray(5, end < 0 ? request.length : end));
  }
  if (request[0] !== 0x50) return undefined;
  let offset = 5;
  while (request[offset] !== 0 && offset < request.length) offset += 1;
  offset += 1;
  const end = request.indexOf(0, offset);
  return new TextDecoder().decode(request.subarray(offset, end < 0 ? request.length : end));
}

function inferredParameterOids(sql: string): number[] {
  const indexes = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const count = indexes.length === 0 ? 0 : Math.max(...indexes);
  return Array.from({ length: count }, (_, index) => {
    const marker = `\\$${index + 1}`;
    if (new RegExp(`${marker}::(?:int4|integer)\\b`, 'i').test(sql)) return 23;
    if (new RegExp(`${marker}::jsonb\\b`, 'i').test(sql)) return 3802;
    return 25;
  });
}

function withoutReadyForQuery(response: Uint8Array): Uint8Array {
  return response.slice(0, -6);
}

function concatenateBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function postgresDiagnostic(severity: string, sqlstate: string, message: string): number[] {
  return [
    0x53,
    ...encoder.encode(severity),
    0,
    0x43,
    ...encoder.encode(sqlstate),
    0,
    0x4d,
    ...encoder.encode(message),
    0,
    0,
  ];
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

function readI32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('client', async () => {
  await main();
});
