import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createOliphauntClient,
  supportsBackupFormat,
  supportsRestoreFormat,
  type OliphauntTransaction,
} from '../client';
import { simpleQuery } from '../protocol';
import { extendedQuery, parseQueryResponse, PostgresError } from '../query';
import { runOliphauntReactNativeBenchmark } from '../benchmark';
import { runOliphauntReactNativeSmoke } from '../smoke';
import type { NativeCapabilities, Spec } from '../specs/NativeOliphaunt';

async function main(): Promise<void> {
  await testPackageEntrypointWiresDefaultTurboModuleClient();
  await testSupportedModesExposePlatformRuntimeContract();
  await testPackageSizeReportDelegatesToNativeSdk();
  await testPackageSizeReportRejectsBlankResourceRootBeforeNativeCall();
  await testProcessMemoryReportDelegatesToNativeSdk();
  testJsiBinaryTransportFixturesAreModeled();
  await testOpenExecCapabilitiesAndClose();
  await testJsiArrayBufferTransportIsRequiredAndUsedForBinaryCalls();
  await testJsiStreamTransportAdvertisesAndUsesNativeChunks();
  await testJsiStreamTransportRejectsNonBinaryChunks();
  await testJsiStreamTransportPropagatesChunkCallbackErrors();
  await testOpenRequiresJsiTransportBeforeNativeCall();
  await testJsiArrayBufferTransportRejectsNonBinaryResponses();
  await testReusableReactNativeSmokeRunnerExercisesInstalledTransportShape();
  await testReusableReactNativeBenchmarkRunnerExercisesInstalledTransportShape();
  await testRawProtocolStreamFallsBackToOwnedResponse();
  await testQueryParsesSimpleQueryResults();
  await testQueryParametersUseExtendedProtocol();
  testSimpleQueryRejectsNulSQLBeforeBuildingProtocol();
  testExtendedQueryRejectsInvalidFrontendInputsBeforeBuildingProtocol();
  await testQuerySurfacesPostgresErrors();
  await testExecuteSurfacesPostgresErrors();
  await testQueryNormalizesCancellationPostgresErrors();
  testQueryParserRejectsInvalidUTF8FieldNames();
  testQueryTextAccessorsRejectInvalidUTF8Values();
  testQueryParserAcceptsExtendedQueryControlMessages();
  testQueryParserAcceptsAsyncBackendControlMessages();
  testQueryParserRejectsMalformedEmptyControlMessages();
  testQueryParserRejectsMalformedAsyncBackendControlMessages();
  testQueryParserRejectsUnexpectedBackendMessageTags();
  testQueryParserAcceptsReadyForQueryTransactionStates();
  testQueryParserRejectsMalformedReadyForQueryStatus();
  await testConnectionStringIsOnlyPresentForServerCapabilities();
  await testTransactionCommitsAndRejectsUnpinnedInterleaving();
  await testTransactionRollsBackWhenBodyThrows();
  await testCloseDuringTransactionClosesSessionAndRejectsPinnedWork();
  await testBackupRejectsUnsupportedFormatsBeforeNativeCall();
  await testOpenForwardsNativeRuntimeOverrides();
  await testOpenRejectsBlankNativeRuntimeOverridesBeforeNativeCall();
  await testOpenRejectsEmptyRootBeforeNativeCall();
  await testOpenRejectsInvalidConnectionIdentityBeforeNativeCall();
  await testOpenValidatesExtensionIdsBeforeNativeCall();
  await testOpenValidatesStartupGUCsBeforeNativeCall();
  await testRestoreUsesPhysicalArchiveShape();
  await testRestoreForwardsNativeLibraryOverride();
  await testRestoreRejectsBlankLibraryOverrideBeforeNativeCall();
  await testRestoreRejectsUnsupportedFormatsBeforeNativeCall();
  await testRestoreRejectsBlankRootBeforeNativeCall();
  await testMutuallyExclusiveRoots();
  await testCancelUsesNativeOutOfBandPath();
  await testCloseDoesNotIssueSpuriousCancel();
  await testPrepareForBackgroundCheckpointsWhenIdleAndResumeProbesSession();
  await testPrepareForBackgroundCancelsActiveWorkAndSkipsCheckpoint();
  await testPrepareForBackgroundSkipsCheckpointDuringTransaction();
  await testExecutionAfterCloseFailsBeforeNativeCall();
}

async function testPackageEntrypointWiresDefaultTurboModuleClient(): Promise<void> {
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
    assert.equal(typeof entrypoint.createOliphauntClient, 'function');
    assert.equal(typeof entrypoint.Oliphaunt.supportedModes, 'function');
    const support = await entrypoint.Oliphaunt.supportedModes();
    assert.deepEqual(
      support.map((entry) => entry.engine),
      ['nativeDirect', 'nativeBroker', 'nativeServer'],
    );
  } finally {
    vi.doUnmock('react-native');
    vi.resetModules();
  }
}

async function testSupportedModesExposePlatformRuntimeContract(): Promise<void> {
  const client = createOliphauntClient(new MockNative());
  const support = await client.supportedModes();

  assert.deepEqual(
    support.map((entry) => entry.engine),
    ['nativeDirect', 'nativeBroker', 'nativeServer'],
  );
  assert.equal(support[0]?.available, true);
  assert.equal(support[0]?.capabilities.maxClientSessions, 1);
  assert.deepEqual(support[0]?.capabilities.backupFormats, ['physicalArchive']);
  assert.equal(support[0]?.capabilities.independentSessions, false);
  assert.equal(support[0]?.capabilities.multiRoot, false);
  assert.equal(support[0]?.capabilities.reopenable, true);
  assert.equal(support[0]?.capabilities.sameRootLogicalReopen, true);
  assert.equal(support[0]?.capabilities.rootSwitchable, false);
  assert.equal(support[0]?.capabilities.crashRestartable, false);
  assert.equal(support[1]?.available, false);
  assert.equal(support[1]?.capabilities.processIsolated, true);
  assert.equal(support[1]?.capabilities.multiRoot, true);
  assert.equal(support[1]?.capabilities.reopenable, true);
  assert.equal(support[1]?.capabilities.sameRootLogicalReopen, false);
  assert.equal(support[1]?.capabilities.rootSwitchable, true);
  assert.equal(support[1]?.capabilities.crashRestartable, true);
  assert.match(support[1]?.unavailableReason ?? '', /broker/);
  assert.equal(support[2]?.available, false);
  assert.equal(support[2]?.capabilities.independentSessions, true);
  assert.equal(support[2]?.capabilities.multiRoot, false);
  assert.equal(support[2]?.capabilities.reopenable, true);
  assert.equal(support[2]?.capabilities.sameRootLogicalReopen, false);
  assert.equal(support[2]?.capabilities.rootSwitchable, true);
  assert.equal(support[2]?.capabilities.crashRestartable, false);
  assert.deepEqual(support[2]?.capabilities.backupFormats, ['sql', 'physicalArchive']);
  assert.match(support[2]?.unavailableReason ?? '', /server/);
}

async function testPackageSizeReportDelegatesToNativeSdk(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  const report = await client.packageSizeReport({
    resourceRoot: '/tmp/oliphaunt-rn-resources',
  });

  assert.deepEqual(native.packageSizeReportCalls, [
    { resourceRoot: '/tmp/oliphaunt-rn-resources' },
  ]);
  assert.deepEqual(report, {
    packageBytes: 185,
    runtimeBytes: 100,
    templatePgdataBytes: 40,
    staticRegistryBytes: 45,
    selectedExtensionBytes: 30,
    mobileStaticRegistryState: null,
    mobileStaticRegistryRegistered: [],
    mobileStaticRegistryPending: [],
    nativeModuleStems: [],
    extensions: [
      {
        name: 'vector',
        fileCount: 3,
        bytes: 30,
      },
    ],
  });
}

async function testPackageSizeReportRejectsBlankResourceRootBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.packageSizeReport({ resourceRoot: ' \n' });
  }, /resourceRoot must not be empty/);
  await assert.rejects(async () => {
    await client.packageSizeReport({ resourceRoot: '/tmp/oliphaunt\0resources' });
  }, /resourceRoot must not contain NUL bytes/);
  assert.deepEqual(native.packageSizeReportCalls, []);
}

async function testProcessMemoryReportDelegatesToNativeSdk(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  const report = await client.processMemory();

  assert.deepEqual(report, {
    source: 'test-process-memory',
    residentBytes: 4096,
    physicalFootprintBytes: 8192,
    totalPssKb: 12,
  });
}

function testJsiBinaryTransportFixturesAreModeled(): void {
  const fixturePath = sharedFixturePath('react-native-jsi/binary-transport.json');
  assert.ok(fixturePath, 'shared React Native JSI fixture corpus must exist');

  const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    schemaVersion: number;
    kind: string;
    cases: Array<{ name: string; valid?: boolean; requiresNativeChunkCallback?: boolean }>;
  };

  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.kind, 'oliphaunt-react-native-jsi-binary-transport');
  const cases = new Map(corpus.cases.map((fixture) => [fixture.name, fixture]));
  assert.equal(cases.get('array-buffer-request')?.valid, true);
  assert.equal(cases.get('uint8array-offset')?.valid, true);
  assert.equal(cases.get('stream-chunks')?.requiresNativeChunkCallback, true);
  assert.equal(cases.get('base64-rejected')?.valid, false);
  assert.equal(cases.get('unsafe-handle-rejected')?.valid, false);
}

function sharedFixturePath(relativePath: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), '..', '..', '..', 'fixtures', relativePath),
    path.resolve(process.cwd(), '..', '..', '..', '..', 'fixtures', relativePath),
    path.resolve(process.cwd(), '..', '..', 'shared', 'fixtures', relativePath),
    path.resolve(process.cwd(), '..', '..', '..', 'shared', 'fixtures', relativePath),
    path.resolve(process.cwd(), '..', '..', '..', 'src', 'shared', 'fixtures', relativePath),
    path.resolve(process.cwd(), '..', '..', 'src', 'shared', 'fixtures', relativePath),
    path.resolve(process.cwd(), 'src', 'shared', 'fixtures', relativePath),
  ];
  return candidates.find(existsSync);
}

async function testOpenExecCapabilitiesAndClose(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);
  const db = await client.open({
    engine: 'nativeServer',
    temporary: true,
    durability: 'balanced',
    extensions: ['hstore'],
  });

  assert.equal(db.handle, 1);
  assert.deepEqual(native.openCalls[0], {
    engine: 'nativeServer',
    root: undefined,
    temporary: true,
    durability: 'balanced',
    runtimeFootprint: 'balancedMobile',
    startupGUCs: undefined,
    username: undefined,
    database: undefined,
    extensions: ['hstore'],
    libraryPath: undefined,
    runtimeDirectory: undefined,
    resourceRoot: undefined,
  });
  const capabilities = await db.capabilities();
  assert.equal(capabilities.engine, 'nativeServer');
  assert.equal(capabilities.rawProtocolTransport, 'jsi-array-buffer');
  assert.equal(capabilities.multiRoot, false);
  assert.equal(capabilities.queryCancel, true);
  assert.equal(capabilities.backupRestore, true);
  assert.deepEqual(capabilities.backupFormats, ['sql', 'physicalArchive']);
  assert.deepEqual(capabilities.restoreFormats, ['physicalArchive']);
  assert.equal(supportsBackupFormat(capabilities, 'sql'), true);
  assert.equal(supportsBackupFormat(capabilities, 'physicalArchive'), true);
  assert.equal(supportsBackupFormat(capabilities, 'oliphauntArchive'), false);
  assert.equal(supportsRestoreFormat(capabilities, 'physicalArchive'), true);
  assert.equal(supportsRestoreFormat(capabilities, 'sql'), false);
  assert.equal(await db.supportsBackupFormat('sql'), true);
  assert.equal(await db.supportsRestoreFormat('sql'), false);
  assert.equal(capabilities.simpleQuery, true);
  assert.equal(capabilities.connectionString, 'postgres://postgres@127.0.0.1:55432/template1');

  const response = await db.execProtocolRaw(Uint8Array.from([0x51]));
  assert.deepEqual(Array.from(response), [1, 0x51]);

  const query = await db.execute('SELECT 1');
  assert.ok(query.includes(0x54), 'missing RowDescription');
  assert.ok(query.includes(0x44), 'missing DataRow');
  assert.ok(query.includes(0x5a), 'missing ReadyForQuery');

  const backup = await db.backup('sql');
  assert.equal(backup.format, 'sql');
  assert.equal(new TextDecoder().decode(backup.bytes), 'sql-backup');

  await db.close();
  await db.close();
  assert.deepEqual(native.closedHandles, [1]);
}

async function testJsiArrayBufferTransportIsRequiredAndUsedForBinaryCalls(): Promise<void> {
  const native = new MockNative();
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  const jsiRequests: number[][] = [];
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    async execProtocolRaw(handle: number, request: Uint8Array): Promise<Uint8Array> {
      jsiRequests.push(Array.from(request));
      return Uint8Array.from([handle, ...request]);
    },
    async backup(handle: number, format: string): Promise<Uint8Array> {
      return new TextEncoder().encode(`${handle}:${format}`);
    },
    async restore(): Promise<string> {
      return '/tmp/oliphaunt-jsi-restored';
    },
  };
  try {
    const client = createOliphauntClient(native);
    const support = await client.supportedModes();
    assert.equal(support[0]?.capabilities.rawProtocolTransport, 'jsi-array-buffer');
    assert.equal(support[0]?.capabilities.protocolStream, false);

    const db = await client.open();
    assert.equal((await db.capabilities()).rawProtocolTransport, 'jsi-array-buffer');
    assert.equal((await db.capabilities()).protocolStream, false);
    const response = await db.execProtocolRaw(Uint8Array.from([0x51, 0x00]));

    assert.deepEqual(Array.from(response), [1, 0x51, 0x00]);
    assert.deepEqual(jsiRequests, [[0x51, 0x00]]);
    await db.close();
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testJsiStreamTransportAdvertisesAndUsesNativeChunks(): Promise<void> {
  const native = new MockNative();
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  const streamRequests: number[][] = [];
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    execProtocolRaw: (handle, request) => native.execProtocolRawJsi(handle, request),
    execProtocolStream: async (_handle, request, onChunk) => {
      streamRequests.push(Array.from(request));
      onChunk(Uint8Array.from([0xaa]));
      onChunk(Uint8Array.from([0xbb]));
    },
    backup: (handle, format) => native.backupJsi(handle, format),
    restore: (root, format, artifact, replaceExisting, libraryPath) =>
      native.restoreJsi(root, format, artifact, replaceExisting, libraryPath),
  };
  try {
    const client = createOliphauntClient(native);
    const support = await client.supportedModes();
    assert.equal(support[0]?.capabilities.protocolStream, true);

    const db = await client.open();
    assert.equal((await db.capabilities()).protocolStream, true);
    const chunks: number[][] = [];
    await db.execProtocolStream(Uint8Array.from([0x51, 0x10]), (chunk) => {
      chunks.push(Array.from(chunk));
    });

    assert.deepEqual(chunks, [[0xaa], [0xbb]]);
    assert.deepEqual(streamRequests, [[0x51, 0x10]]);
    assert.equal(native.execCalls, 0);
    await db.close();
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testJsiStreamTransportRejectsNonBinaryChunks(): Promise<void> {
  const native = new MockNative();
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    execProtocolRaw: (handle, request) => native.execProtocolRawJsi(handle, request),
    execProtocolStream: async (_handle, _request, onChunk) => {
      onChunk({} as ArrayBuffer);
    },
    backup: (handle, format) => native.backupJsi(handle, format),
    restore: (root, format, artifact, replaceExisting, libraryPath) =>
      native.restoreJsi(root, format, artifact, replaceExisting, libraryPath),
  };
  try {
    const db = await createOliphauntClient(native).open();
    await assert.rejects(
      () => db.execProtocolStream(Uint8Array.from([0x51]), () => {}),
      /JSI transport returned a non-binary response/,
    );
    await db.close();
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testJsiStreamTransportPropagatesChunkCallbackErrors(): Promise<void> {
  const native = new MockNative();
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    execProtocolRaw: (handle, request) => native.execProtocolRawJsi(handle, request),
    execProtocolStream: async (_handle, _request, onChunk) => {
      onChunk(Uint8Array.from([0xaa]));
      onChunk(Uint8Array.from([0xbb]));
    },
    backup: (handle, format) => native.backupJsi(handle, format),
    restore: (root, format, artifact, replaceExisting, libraryPath) =>
      native.restoreJsi(root, format, artifact, replaceExisting, libraryPath),
  };
  try {
    const db = await createOliphauntClient(native).open();
    const chunks: number[][] = [];
    await assert.rejects(
      () =>
        db.execProtocolStream(Uint8Array.from([0x51]), (chunk) => {
          chunks.push(Array.from(chunk));
          throw new Error('chunk callback failed');
        }),
      /chunk callback failed/,
    );
    assert.deepEqual(chunks, [[0xaa]]);
    await db.close();
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testOpenRequiresJsiTransportBeforeNativeCall(): Promise<void> {
  const native = new MockNative({ installJsi: false });
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  delete globalWithJsi.__oliphauntReactNativeJsi;
  try {
    const client = createOliphauntClient(native);
    const support = await client.supportedModes();
    assert.equal(support[0]?.available, false);
    assert.match(
      support[0]?.unavailableReason ?? '',
      /New Architecture JSI ArrayBuffer transport is not installed/,
    );
    await assert.rejects(
      () => client.open(),
      /requires React Native New Architecture JSI ArrayBuffer bindings/,
    );
    assert.deepEqual(native.openCalls, []);
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testJsiArrayBufferTransportRejectsNonBinaryResponses(): Promise<void> {
  const native = new MockNative();
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    async execProtocolRaw(): Promise<ArrayBuffer> {
      return 'not-bytes' as unknown as ArrayBuffer;
    },
    async backup(): Promise<Uint8Array> {
      return Uint8Array.from([]);
    },
    async restore(): Promise<string> {
      return '/tmp/oliphaunt-jsi-restored';
    },
  };
  try {
    const db = await createOliphauntClient(native).open();
    await assert.rejects(
      () => db.execProtocolRaw(Uint8Array.from([0x51])),
      /JSI transport returned a non-binary response/,
    );
    await db.close();
  } finally {
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testReusableReactNativeSmokeRunnerExercisesInstalledTransportShape(): Promise<void> {
  const native = new MockNative();
  let afterSmokeValue = '';
  // liboliphaunt-doc-example:react-native-smoke-runner
  const report = await runOliphauntReactNativeSmoke(createOliphauntClient(native), {
    open: {
      temporary: true,
      extensions: ['vector'],
      resourceRoot: '/tmp/oliphaunt-rn-smoke-resources',
    },
    expectedEngine: 'nativeServer',
    requirePackageSizeReport: true,
    afterSmoke: async (database) => {
      assert.deepEqual(native.closedHandles, []);
      const result = await database.query('SELECT 1::text AS value');
      afterSmokeValue = result.getText(0, 'value') ?? '';
    },
  });

  assert.equal(report.engine, 'nativeServer');
  assert.equal(report.rawProtocolTransport, 'jsi-array-buffer');
  assert.equal(report.selectOne, '1');
  assert.equal(report.parameterRoundTrip, 'hello');
  assert.equal(afterSmokeValue, '1');
  assert.equal(typeof report.jsTimerTicks, 'number');
  assert.ok(report.elapsedMs >= 0);
  assert.equal(report.packageSizeReport?.extensions[0]?.name, 'vector');
  assert.deepEqual(native.openCalls[0], {
    engine: 'nativeDirect',
    root: undefined,
    temporary: true,
    durability: 'balanced',
    runtimeFootprint: 'balancedMobile',
    startupGUCs: undefined,
    username: 'postgres',
    database: 'postgres',
    extensions: ['vector'],
    libraryPath: undefined,
    runtimeDirectory: undefined,
    resourceRoot: '/tmp/oliphaunt-rn-smoke-resources',
  });
  assert.deepEqual(native.packageSizeReportCalls, [
    { resourceRoot: '/tmp/oliphaunt-rn-smoke-resources' },
  ]);
  assert.deepEqual(native.closedHandles, [1]);
}

async function testReusableReactNativeBenchmarkRunnerExercisesInstalledTransportShape(): Promise<void> {
  const native = new DirectCapabilitiesNative();
  // liboliphaunt-doc-example:react-native-benchmark-runner
  const report = await runOliphauntReactNativeBenchmark(createOliphauntClient(native), {
    requirePackageSizeReport: true,
    warmupIterations: 1,
    rawRttIterations: 1,
    typedRttIterations: 1,
    parameterizedRttIterations: 1,
    insertRows: 1,
    lookupIterations: 1,
    aggregateIterations: 1,
    updateIterations: 1,
    checkpointIterations: 1,
    largeResultRows: 1,
  });

  assert.equal(report.engine, 'nativeDirect');
  assert.equal(report.rawProtocolTransport, 'jsi-array-buffer');
  assert.equal(report.postgresSettings.shared_buffers, '32MB');
  assert.equal(report.postgresSettings.wal_buffers, '-1');
  assert.equal(report.postgresSettings.wal_segment_size, '16MB');
  assert.equal(report.postgresSettings.synchronous_commit, 'off');
  assert.equal(report.packageSizeReport?.extensions[0]?.name, 'vector');
  assert.equal(report.processMemoryReport.source, 'test-process-memory');
  assert.equal(report.processMemoryReport.physicalFootprintBytes, 8192);
  assert.deepEqual(
    report.workloads.map((workload) => workload.id),
    [
      'raw_simple_query_rtt',
      'typed_select_rtt',
      'parameterized_select_rtt',
      'transaction_insert',
      'indexed_lookup',
      'indexed_aggregate',
      'indexed_update',
      'background_checkpoint',
      'large_result_raw',
    ],
  );
  assert.ok(
    native.execRequestTexts().some((request) => request.includes('CHECKPOINT')),
    'benchmark must measure background checkpoint latency',
  );
  assert.ok(
    native.execRequestTexts().some((request) => request.includes('current_setting(name, true)')),
    'benchmark must record effective PostgreSQL settings',
  );
  assert.deepEqual(native.closedHandles, [1]);
}

async function testRawProtocolStreamFallsBackToOwnedResponse(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  const chunks: Uint8Array[] = [];

  await db.execProtocolStream(Uint8Array.from([0x51]), (chunk) => {
    chunks.push(chunk);
  });

  assert.deepEqual(
    chunks.map((chunk) => Array.from(chunk)),
    [[1, 0x51]],
  );
  await db.close();
}

async function testQueryParsesSimpleQueryResults(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  // liboliphaunt-doc-example:react-native-open-query
  // OLIPHAUNT_DOCS_SNIPPET react-native-quickstart
  const result = await db.query('SELECT 1::text AS value, NULL AS empty');

  assert.deepEqual(
    result.fields.map((field) => field.name),
    ['value', 'empty'],
  );
  assert.equal(result.fields[0]?.typeOid, 25);
  assert.equal(result.rowCount, 1);
  assert.equal(result.commandTag, 'SELECT 1');
  assert.equal(result.getText(0, 'value'), '1');
  assert.equal(result.getText(0, 'empty'), null);
  await db.close();
}

async function testQueryParametersUseExtendedProtocol(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const request = extendedQuery('SELECT $1::text AS value, $2::text AS empty', ['1', null]);
  assert.equal(request[0], 0x50);
  assert.ok(request.includes(0x42), 'missing Bind');
  assert.ok(request.includes(0x45), 'missing Execute');

  // liboliphaunt-doc-example:react-native-parameterized-query
  const result = await db.query('SELECT $1::text AS value, $2::text AS empty', [
    { format: 'text', value: '1' },
    null,
  ]);

  assert.equal(native.execRequests[0]?.[0], 0x50);
  assert.equal(result.getText(0, 'value'), '1');
  assert.equal(result.getText(0, 'empty'), null);
  await db.close();
}

function testSimpleQueryRejectsNulSQLBeforeBuildingProtocol(): void {
  assert.throws(
    () => simpleQuery('SELECT 1\0SELECT 2'),
    /simple query SQL must not contain NUL bytes/,
  );
}

function testExtendedQueryRejectsInvalidFrontendInputsBeforeBuildingProtocol(): void {
  assert.throws(
    () => extendedQuery('SELECT \0', [null]),
    /extended query SQL must not contain NUL bytes/,
  );
  assert.throws(
    () =>
      extendedQuery(
        'SELECT 1',
        Array.from({ length: 0x8000 }, () => null),
      ),
    /extended query supports at most 32767 parameters, got 32768/,
  );
}

async function testQuerySurfacesPostgresErrors(): Promise<void> {
  const native = new ErroringQueryNative('42P01', 'relation does not exist');
  const db = await createOliphauntClient(native).open();

  await assert.rejects(
    async () => {
      await db.query('SELECT * FROM missing');
    },
    (error: unknown) => {
      assert.ok(error instanceof PostgresError);
      assert.equal(error.severity, 'ERROR');
      assert.equal(error.sqlstate, '42P01');
      assert.equal(error.postgresMessage, 'relation does not exist');
      return true;
    },
  );
  await db.close();
}

async function testExecuteSurfacesPostgresErrors(): Promise<void> {
  const native = new ErroringQueryNative('42601', 'syntax error at or near "TRIGGER"');
  const db = await createOliphauntClient(native).open();

  await assert.rejects(
    async () => {
      await db.execute('CREATE TRIGGER broken');
    },
    (error: unknown) => {
      assert.ok(error instanceof PostgresError);
      assert.equal(error.severity, 'ERROR');
      assert.equal(error.sqlstate, '42601');
      assert.equal(error.postgresMessage, 'syntax error at or near "TRIGGER"');
      return true;
    },
  );
  await db.close();
}

async function testQueryNormalizesCancellationPostgresErrors(): Promise<void> {
  const native = new ErroringQueryNative('57014', 'canceling statement due to user request');
  const db = await createOliphauntClient(native).open();

  await assert.rejects(
    async () => {
      await db.query('SELECT pg_sleep(5)');
    },
    (error: unknown) => {
      assert.ok(error instanceof PostgresError);
      assert.equal(error.severity, 'ERROR');
      assert.equal(error.sqlstate, '57014');
      assert.equal(error.postgresMessage, 'canceling statement due to user request');
      return true;
    },
  );
  await db.close();
}

function testQueryParserRejectsInvalidUTF8FieldNames(): void {
  const out: number[] = [];
  pushRawRowDescription(out, [[Uint8Array.from([0xff]), 25]]);
  pushReadyForQuery(out);

  assert.throws(() => parseQueryResponse(Uint8Array.from(out)), /field name is not valid UTF-8/);
}

function testQueryTextAccessorsRejectInvalidUTF8Values(): void {
  const out: number[] = [];
  pushRowDescription(out, [['value', 25]]);
  pushDataRow(out, [Uint8Array.from([0xff])]);
  pushCommandComplete(out, 'SELECT 1');
  pushReadyForQuery(out);

  const result = parseQueryResponse(Uint8Array.from(out));
  assert.throws(() => result.getText(0, 'value'), /query value is not valid UTF-8/);
}

function testQueryParserAcceptsExtendedQueryControlMessages(): void {
  const out: number[] = [];
  pushBackendMessage(out, 0x31, []);
  pushBackendMessage(out, 0x32, []);
  pushBackendMessage(out, 0x6e, []);
  pushCommandComplete(out, 'INSERT 0 0');
  pushReadyForQuery(out);

  const result = parseQueryResponse(Uint8Array.from(out));
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.commandTag, 'INSERT 0 0');
}

function testQueryParserAcceptsAsyncBackendControlMessages(): void {
  const out: number[] = [];
  pushParameterStatus(out, 'client_encoding', 'UTF8');
  pushNoticeResponse(out, 'NOTICE', 'hello');
  pushNotificationResponse(out, 123, 'channel', 'payload');
  pushCommandComplete(out, 'SELECT 0');
  pushReadyForQuery(out);

  const result = parseQueryResponse(Uint8Array.from(out));
  assert.equal(result.commandTag, 'SELECT 0');
}

function testQueryParserRejectsMalformedEmptyControlMessages(): void {
  const out: number[] = [];
  pushBackendMessage(out, 0x31, [0]);
  pushReadyForQuery(out);

  assert.throws(
    () => parseQueryResponse(Uint8Array.from(out)),
    /ParseComplete contained trailing bytes/,
  );
}

function testQueryParserRejectsMalformedAsyncBackendControlMessages(): void {
  const malformedParameter: number[] = [];
  pushBackendMessage(malformedParameter, 0x53, [...new TextEncoder().encode('client_encoding'), 0]);
  pushReadyForQuery(malformedParameter);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from(malformedParameter)),
    /ParameterStatus value is missing null terminator/,
  );

  const malformedNotice: number[] = [];
  pushBackendMessage(malformedNotice, 0x4e, [0x53, ...new TextEncoder().encode('NOTICE'), 0]);
  pushReadyForQuery(malformedNotice);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from(malformedNotice)),
    /NoticeResponse is missing terminator/,
  );

  const malformedNotification: number[] = [];
  const notificationBody: number[] = [];
  pushI32(notificationBody, 123);
  notificationBody.push(...new TextEncoder().encode('channel'));
  pushBackendMessage(malformedNotification, 0x41, notificationBody);
  pushReadyForQuery(malformedNotification);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from(malformedNotification)),
    /NotificationResponse channel is missing null terminator/,
  );
}

function testQueryParserRejectsUnexpectedBackendMessageTags(): void {
  const out: number[] = [];
  pushBackendMessage(out, 0x52, [0, 0, 0, 0]);
  pushReadyForQuery(out);

  assert.throws(
    () => parseQueryResponse(Uint8Array.from(out)),
    /unexpected backend message tag 0x52/,
  );
}

function testQueryParserAcceptsReadyForQueryTransactionStates(): void {
  for (const status of [0x49, 0x54, 0x45]) {
    const out: number[] = [];
    pushCommandComplete(out, 'SELECT 0');
    pushReadyForQuery(out, status);

    const result = parseQueryResponse(Uint8Array.from(out));
    assert.equal(result.commandTag, 'SELECT 0');
  }
}

function testQueryParserRejectsMalformedReadyForQueryStatus(): void {
  const missing: number[] = [];
  pushBackendMessage(missing, 0x5a, []);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from(missing)),
    /ReadyForQuery contained 0 bytes, expected 1/,
  );

  const invalid: number[] = [];
  pushReadyForQuery(invalid, 0);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from(invalid)),
    /ReadyForQuery contained invalid transaction status 0x00/,
  );
}

async function testConnectionStringIsOnlyPresentForServerCapabilities(): Promise<void> {
  const direct = await createOliphauntClient(new DirectCapabilitiesNative()).open({
    engine: 'nativeDirect',
  });
  assert.equal(await direct.connectionString(), undefined);
  assert.equal((await direct.capabilities()).independentSessions, false);
  assert.equal((await direct.capabilities()).reopenable, true);
  assert.equal((await direct.capabilities()).sameRootLogicalReopen, true);
  assert.equal((await direct.capabilities()).rootSwitchable, false);
  assert.equal((await direct.capabilities()).crashRestartable, false);
  await direct.close();

  const server = await createOliphauntClient(new MockNative()).open({
    engine: 'nativeServer',
  });
  assert.equal(await server.connectionString(), 'postgres://postgres@127.0.0.1:55432/template1');
  assert.equal((await server.capabilities()).independentSessions, true);
  assert.equal((await server.capabilities()).reopenable, true);
  assert.equal((await server.capabilities()).sameRootLogicalReopen, false);
  assert.equal((await server.capabilities()).rootSwitchable, true);
  assert.equal((await server.capabilities()).crashRestartable, false);
  await server.close();
}

async function testTransactionCommitsAndRejectsUnpinnedInterleaving(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const value = await db.transaction(async (tx) => {
    await assert.rejects(
      () => db.execute('SELECT outside_transaction'),
      /active OliphauntTransaction/,
    );
    await assert.rejects(() => db.checkpoint(), /active OliphauntTransaction/);
    await tx.execute('INSERT INTO rn_tx VALUES (1)');
    const chunks: number[][] = [];
    await tx.execProtocolStream(Uint8Array.from([0x52]), (chunk) => {
      chunks.push(Array.from(chunk));
    });
    assert.deepEqual(chunks, [[1, 0x52]]);
    return 7;
  });

  await db.checkpoint();
  assert.equal(value, 7);
  const requests = native.execRequestTexts();
  assert.ok(requests.some((request) => request.includes('BEGIN')));
  assert.ok(requests.some((request) => request.includes('INSERT INTO rn_tx')));
  assert.ok(requests.some((request) => request.includes('COMMIT')));
  assert.ok(requests.some((request) => request.includes('CHECKPOINT')));
  assert.ok(!requests.some((request) => request.includes('ROLLBACK')));

  const escaped = await db.transaction((tx) => tx);
  await assert.rejects(
    () => escaped.execute('SELECT after_commit'),
    /transaction is no longer active/,
  );
  await db.close();
}

async function testTransactionRollsBackWhenBodyThrows(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  let captured: OliphauntTransaction | undefined;
  await assert.rejects(async () => {
    await db.transaction(async (tx) => {
      captured = tx;
      await tx.execute('INSERT INTO rn_tx VALUES (2)');
      throw new Error('boom');
    });
  }, /boom/);

  const requests = native.execRequestTexts();
  assert.ok(requests.some((request) => request.includes('BEGIN')));
  assert.ok(requests.some((request) => request.includes('INSERT INTO rn_tx')));
  assert.ok(requests.some((request) => request.includes('ROLLBACK')));
  assert.ok(captured);
  await assert.rejects(
    () => captured!.execute('SELECT after_rollback'),
    /transaction is no longer active/,
  );
  await db.close();
}

async function testCloseDuringTransactionClosesSessionAndRejectsPinnedWork(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await assert.rejects(async () => {
    await db.transaction(async (tx) => {
      await db.close();
      await tx.execute('SELECT after_close');
    });
  }, /Oliphaunt database is closed/);

  await assert.rejects(
    () => db.execute('SELECT after_closed_database'),
    /Oliphaunt database is closed/,
  );

  const requests = native.execRequestTexts();
  assert.ok(requests.some((request) => request.includes('BEGIN')));
  assert.ok(!requests.some((request) => request.includes('SELECT after_close')));
  assert.ok(!requests.some((request) => request.includes('COMMIT')));
  assert.deepEqual(native.closedHandles, [1]);
}

async function testBackupRejectsUnsupportedFormatsBeforeNativeCall(): Promise<void> {
  const native = new DirectCapabilitiesNative();
  const db = await createOliphauntClient(native).open({ engine: 'nativeDirect' });

  await assert.rejects(async () => {
    await db.backup('sql');
  }, /sql backup is not supported by nativeDirect/);
  assert.deepEqual(native.backupCalls, []);
  await db.close();
}

async function testOpenForwardsNativeRuntimeOverrides(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);
  await client.open({
    engine: 'nativeDirect',
    root: '/tmp/oliphaunt-rn-root',
    durability: 'fastDev',
    runtimeFootprint: 'balancedMobile',
    startupGUCs: [{ name: 'shared_buffers', value: '16MB' }, 'wal_buffers=256kB'],
    username: 'app_user',
    database: 'app_db',
    libraryPath: '/tmp/oliphaunt.dylib',
    runtimeDirectory: '/tmp/postgres-install',
    resourceRoot: '/tmp/oliphaunt-resources',
  });

  assert.deepEqual(native.openCalls[0], {
    engine: 'nativeDirect',
    root: '/tmp/oliphaunt-rn-root',
    temporary: undefined,
    durability: 'fastDev',
    runtimeFootprint: 'balancedMobile',
    startupGUCs: ['shared_buffers=16MB', 'wal_buffers=256kB'],
    username: 'app_user',
    database: 'app_db',
    extensions: undefined,
    libraryPath: '/tmp/oliphaunt.dylib',
    runtimeDirectory: '/tmp/postgres-install',
    resourceRoot: '/tmp/oliphaunt-resources',
  });
}

async function testOpenRejectsBlankNativeRuntimeOverridesBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.open({ libraryPath: ' \n' });
  }, /libraryPath must not be empty/);
  await assert.rejects(async () => {
    await client.open({ runtimeDirectory: '\t' });
  }, /runtimeDirectory must not be empty/);
  await assert.rejects(async () => {
    await client.open({ resourceRoot: ' \n' });
  }, /resourceRoot must not be empty/);
  await assert.rejects(async () => {
    await client.open({ libraryPath: '/tmp/oliphaunt\0.dylib' });
  }, /libraryPath must not contain NUL bytes/);
  await assert.rejects(async () => {
    await client.open({ runtimeDirectory: '/tmp/oliphaunt\0runtime' });
  }, /runtimeDirectory must not contain NUL bytes/);
  await assert.rejects(async () => {
    await client.open({ resourceRoot: '/tmp/oliphaunt\0resources' });
  }, /resourceRoot must not contain NUL bytes/);
  assert.deepEqual(native.openCalls, []);
}

async function testOpenRejectsEmptyRootBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.open({ root: ' \t' });
  }, /database root must not be empty/);
  await assert.rejects(async () => {
    await client.open({ root: '/tmp/oliphaunt-rn\0root' });
  }, /database root must not contain NUL bytes/);
  assert.deepEqual(native.openCalls, []);
}

async function testOpenRejectsInvalidConnectionIdentityBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.open({ username: ' \n' });
  }, /username must not be empty/);
  await assert.rejects(async () => {
    await client.open({ database: 'app\0db' });
  }, /database must not contain NUL bytes/);
  assert.deepEqual(native.openCalls, []);
}

async function testOpenValidatesExtensionIdsBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.open({ extensions: ['mobile/vector'] });
  }, /extension id 'mobile\/vector' must contain 1 to 128 ASCII/);
  assert.equal(native.openCalls.length, 0);

  await client.open({
    extensions: [' pg_trgm ', '', 'vector', 'hstore'],
  });
  const forwardedConfig = native.openCalls[0] as { extensions?: string[] };
  assert.deepEqual(forwardedConfig.extensions, ['pg_trgm', 'vector', 'hstore']);
}

async function testOpenValidatesStartupGUCsBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.open({ startupGUCs: ['shared-buffers=16MB'] });
  }, /startup GUC name 'shared-buffers'/);
  await assert.rejects(async () => {
    await client.open({ startupGUCs: [{ name: 'shared_buffers', value: ' \n' }] });
  }, /startup GUC 'shared_buffers' value must not be empty/);
  await assert.rejects(async () => {
    await client.open({ startupGUCs: ['shared_buffers'] });
  }, /startup GUC string must use name=value/);
  await assert.rejects(async () => {
    await client.open({ startupGUCs: [{ name: 'shared_buffers', value: '16\0MB' }] });
  }, /startup GUC must not contain NUL bytes/);
  assert.equal(native.openCalls.length, 0);
}

async function testRestoreUsesPhysicalArchiveShape(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);
  const restored = await client.restore({
    root: '/tmp/oliphaunt-react-native-restore',
    artifact: {
      format: 'physicalArchive',
      bytes: new TextEncoder().encode('physical-backup'),
    },
    replaceExisting: true,
  });

  assert.equal(restored, '/tmp/oliphaunt-react-native-restore');
  assert.deepEqual(native.restoreCalls, [
    {
      root: '/tmp/oliphaunt-react-native-restore',
      format: 'physicalArchive',
      payload: 'physical-backup',
      replaceExisting: true,
      libraryPath: null,
    },
  ]);
}

async function testRestoreForwardsNativeLibraryOverride(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await client.restore({
    root: '/tmp/oliphaunt-react-native-restore-library',
    artifact: {
      format: 'physicalArchive',
      bytes: new TextEncoder().encode('physical-backup'),
    },
    libraryPath: '/tmp/oliphaunt-rn-restore.dylib',
  });

  assert.equal(native.restoreCalls[0]?.libraryPath, '/tmp/oliphaunt-rn-restore.dylib');
}

async function testRestoreRejectsBlankLibraryOverrideBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.restore({
      root: '/tmp/oliphaunt-react-native-restore-library',
      artifact: {
        format: 'physicalArchive',
        bytes: new TextEncoder().encode('physical-backup'),
      },
      libraryPath: ' \n',
    });
  }, /libraryPath must not be empty/);
  await assert.rejects(async () => {
    await client.restore({
      root: '/tmp/oliphaunt-react-native-restore-library',
      artifact: {
        format: 'physicalArchive',
        bytes: new TextEncoder().encode('physical-backup'),
      },
      libraryPath: '/tmp/oliphaunt\0restore.dylib',
    });
  }, /libraryPath must not contain NUL bytes/);
  assert.deepEqual(native.restoreCalls, []);
}

async function testRestoreRejectsUnsupportedFormatsBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.restore({
      root: '/tmp/oliphaunt-react-native-restore-sql',
      artifact: {
        format: 'sql',
        bytes: new TextEncoder().encode('sql-backup'),
      },
    });
  }, /restore currently requires a physicalArchive artifact, got sql/);
  assert.deepEqual(native.restoreCalls, []);
}

async function testRestoreRejectsBlankRootBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const client = createOliphauntClient(native);

  await assert.rejects(async () => {
    await client.restore({
      root: '\n',
      artifact: {
        format: 'physicalArchive',
        bytes: new TextEncoder().encode('physical-backup'),
      },
    });
  }, /restore root must not be empty/);
  await assert.rejects(async () => {
    await client.restore({
      root: '/tmp/oliphaunt-rn\0restore',
      artifact: {
        format: 'physicalArchive',
        bytes: new TextEncoder().encode('physical-backup'),
      },
    });
  }, /restore root must not contain NUL bytes/);
  assert.deepEqual(native.restoreCalls, []);
}

async function testMutuallyExclusiveRoots(): Promise<void> {
  const client = createOliphauntClient(new MockNative());
  await assert.rejects(
    () => client.open({ root: '/tmp/db', temporary: true }),
    /mutually exclusive/,
  );
}

async function testExecutionAfterCloseFailsBeforeNativeCall(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();
  await db.close();
  await assert.rejects(() => db.execProtocolRaw([1]), /closed/);
  assert.equal(native.execCalls, 0);
}

async function testCancelUsesNativeOutOfBandPath(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await db.cancel();

  assert.deepEqual(native.cancelledHandles, [1]);
  await db.close();
}

async function testCloseDoesNotIssueSpuriousCancel(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  await db.close();
  await db.close();

  assert.deepEqual(native.cancelledHandles, []);
  assert.deepEqual(native.closedHandles, [1]);
}

async function testPrepareForBackgroundCheckpointsWhenIdleAndResumeProbesSession(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const prepared = await db.prepareForBackground();
  await db.resumeFromBackground();

  assert.deepEqual(prepared, {
    cancelledActiveWork: false,
    checkpointed: true,
  });
  const requests = native.execRequestTexts();
  assert.ok(requests.some((request) => request.includes('CHECKPOINT')));
  assert.ok(requests.some((request) => request.includes('SELECT 1')));
  assert.deepEqual(native.cancelledHandles, []);
  await db.close();
}

async function testPrepareForBackgroundCancelsActiveWorkAndSkipsCheckpoint(): Promise<void> {
  const native = new MockNative({ installJsi: false });
  const globalWithJsi = globalThis as GlobalWithJsiTransport;
  const previous = globalWithJsi.__oliphauntReactNativeJsi;
  let markStarted: () => void = () => {};
  let finishActiveWork: (value: Uint8Array) => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const activeWork = new Promise<Uint8Array>((resolve) => {
    finishActiveWork = resolve;
  });
  globalWithJsi.__oliphauntReactNativeJsi = {
    version: 1,
    async execProtocolRaw(): Promise<Uint8Array> {
      markStarted();
      return activeWork;
    },
    backup: (handle, format) => native.backupJsi(handle, format),
    restore: (root, format, artifact, replaceExisting, libraryPath) =>
      native.restoreJsi(root, format, artifact, replaceExisting, libraryPath),
  };
  try {
    const db = await createOliphauntClient(native).open();
    const running = db.execProtocolRaw(Uint8Array.from([0x51]));
    await started;

    const prepared = await db.prepareForBackground();

    assert.deepEqual(prepared, {
      cancelledActiveWork: true,
      checkpointed: false,
      skippedCheckpointReason: 'activeWork',
    });
    assert.deepEqual(native.cancelledHandles, [1]);
    finishActiveWork(Uint8Array.from([0xca]));
    assert.deepEqual(Array.from(await running), [0xca]);
    await db.close();
  } finally {
    finishActiveWork(Uint8Array.from([0xca]));
    globalWithJsi.__oliphauntReactNativeJsi = previous;
  }
}

async function testPrepareForBackgroundSkipsCheckpointDuringTransaction(): Promise<void> {
  const native = new MockNative();
  const db = await createOliphauntClient(native).open();

  const prepared = await db.transaction(() => db.prepareForBackground());

  assert.deepEqual(prepared, {
    cancelledActiveWork: false,
    checkpointed: false,
    skippedCheckpointReason: 'transactionActive',
  });
  assert.equal(
    native.execRequestTexts().some((request) => request.includes('CHECKPOINT')),
    false,
  );
  await db.close();
}

class MockNative implements Spec {
  readonly closedHandles: number[] = [];
  readonly cancelledHandles: number[] = [];
  readonly openCalls: unknown[] = [];
  readonly packageSizeReportCalls: unknown[] = [];
  readonly execRequests: Uint8Array[] = [];
  readonly backupCalls: string[] = [];
  readonly restoreCalls: Array<{
    root: string;
    format: string;
    payload: string;
    replaceExisting: boolean;
    libraryPath: string | null;
  }> = [];
  execCalls = 0;
  private nextHandle = 1;

  constructor(options: { installJsi?: boolean } = {}) {
    if (options.installJsi !== false) {
      installMockJsiTransport(this);
    }
  }

  getConstants(): {} {
    return {};
  }

  async open(config?: unknown): Promise<number> {
    this.openCalls.push(config);
    return this.nextHandle++;
  }

  async supportedModes() {
    return [
      {
        engine: 'nativeDirect',
        available: true,
        capabilities: {
          engine: 'nativeDirect',
          processIsolated: false,
          multiRoot: false,
          reopenable: true,
          sameRootLogicalReopen: true,
          rootSwitchable: false,
          crashRestartable: false,
          independentSessions: false,
          maxClientSessions: 1,
          protocolRaw: true,
          protocolStream: true,
          queryCancel: true,
          backupRestore: true,
          backupFormats: ['physicalArchive'],
          restoreFormats: ['physicalArchive'],
          simpleQuery: true,
          extensions: true,
          rawProtocolTransport: 'jsi-array-buffer',
        },
      },
      {
        engine: 'nativeBroker',
        available: false,
        capabilities: {
          engine: 'nativeBroker',
          processIsolated: true,
          multiRoot: true,
          reopenable: true,
          sameRootLogicalReopen: false,
          rootSwitchable: true,
          crashRestartable: true,
          independentSessions: false,
          maxClientSessions: 1,
          protocolRaw: true,
          protocolStream: true,
          queryCancel: true,
          backupRestore: true,
          backupFormats: ['physicalArchive'],
          restoreFormats: ['physicalArchive'],
          simpleQuery: true,
          extensions: true,
          rawProtocolTransport: 'jsi-array-buffer',
        },
        unavailableReason: 'broker adapter is unavailable',
      },
      {
        engine: 'nativeServer',
        available: false,
        capabilities: {
          engine: 'nativeServer',
          processIsolated: true,
          multiRoot: false,
          reopenable: true,
          sameRootLogicalReopen: false,
          rootSwitchable: true,
          crashRestartable: false,
          independentSessions: true,
          maxClientSessions: 32,
          protocolRaw: true,
          protocolStream: true,
          queryCancel: true,
          backupRestore: true,
          backupFormats: ['sql', 'physicalArchive'],
          restoreFormats: ['physicalArchive'],
          simpleQuery: true,
          extensions: true,
          rawProtocolTransport: 'jsi-array-buffer',
        },
        unavailableReason: 'server adapter is unavailable',
      },
    ];
  }

  async packageSizeReport(config: unknown) {
    this.packageSizeReportCalls.push(config);
    return {
      packageBytes: 185,
      runtimeBytes: 100,
      templatePgdataBytes: 40,
      staticRegistryBytes: 45,
      selectedExtensionBytes: 30,
      extensions: [
        {
          name: 'vector',
          fileCount: 3,
          bytes: 30,
        },
      ],
    };
  }

  async processMemory() {
    return {
      source: 'test-process-memory',
      residentBytes: 4096,
      physicalFootprintBytes: 8192,
      totalPssKb: 12,
      virtualBytes: Number.NaN,
    };
  }

  async execProtocolRawJsi(handle: number, request: Uint8Array): Promise<Uint8Array> {
    this.execCalls += 1;
    this.execRequests.push(request);
    if (request.length > 5 && (request[0] === 0x51 || request[0] === 0x50)) {
      const text = new TextDecoder().decode(request);
      if (text.includes('current_setting(name, true)')) {
        return backendNamedRowsResponse(
          ['name', 'value'],
          [
            ['autovacuum_worker_slots', '1'],
            ['fsync', 'on'],
            ['full_page_writes', 'on'],
            ['io_max_concurrency', '1'],
            ['io_method', 'sync'],
            ['maintenance_work_mem', '16MB'],
            ['max_connections', '1'],
            ['max_replication_slots', '0'],
            ['max_wal_senders', '0'],
            ['max_wal_size', '64MB'],
            ['min_wal_size', '32MB'],
            ['reserved_connections', '0'],
            ['shared_buffers', '32MB'],
            ['superuser_reserved_connections', '0'],
            ['synchronous_commit', 'off'],
            ['wal_buffers', '-1'],
            ['wal_segment_size', '16MB'],
            ['work_mem', '4MB'],
          ],
        );
      }
      if (text.includes('SELECT payload FROM rn_bench_events')) {
        return backendNamedValuesResponse([['payload', 'payload-1']]);
      }
      if (text.includes('count(*)::text AS rows')) {
        return backendNamedValuesResponse([
          ['rows', '1'],
          ['total', '1'],
        ]);
      }
      if (text.includes('RETURNING amount::text AS amount')) {
        return backendNamedValuesResponse([['amount', '1']]);
      }
      if (text.includes('sum(amount), 0)::text AS checksum')) {
        return backendNamedValuesResponse([['checksum', '1']]);
      }
      if (text.includes('hello')) {
        return backendSingleValueResponse('hello');
      }
      if (text.includes('ORDER BY value COLLATE oliphaunt_icu_numeric')) {
        return backendNamedValuesResponse([['values', '1,2,10']]);
      }
      return backendSelectResponse();
    }
    return Uint8Array.from([handle, ...request]);
  }

  execRequestTexts(): string[] {
    return this.execRequests.map((request) => new TextDecoder().decode(request));
  }

  async backupJsi(_handle: number, format: string): Promise<Uint8Array> {
    this.backupCalls.push(format);
    return new TextEncoder().encode(`${format}-backup`);
  }

  async restoreJsi(
    root: string,
    format: string,
    artifact: Uint8Array,
    replaceExisting: boolean,
    libraryPath: string | null,
  ): Promise<string> {
    this.restoreCalls.push({
      root,
      format,
      payload: new TextDecoder().decode(artifact),
      replaceExisting,
      libraryPath,
    });
    return root;
  }

  async cancel(handle: number): Promise<void> {
    this.cancelledHandles.push(handle);
  }

  async close(handle: number): Promise<void> {
    this.closedHandles.push(handle);
  }

  async capabilities(): Promise<NativeCapabilities> {
    return {
      engine: 'nativeServer',
      processIsolated: true,
      multiRoot: false,
      reopenable: true,
      sameRootLogicalReopen: false,
      rootSwitchable: true,
      crashRestartable: false,
      independentSessions: true,
      maxClientSessions: 32,
      protocolRaw: true,
      protocolStream: true,
      queryCancel: true,
      backupRestore: true,
      backupFormats: ['sql', 'physicalArchive'],
      restoreFormats: ['physicalArchive'],
      simpleQuery: true,
      extensions: true,
      connectionString: 'postgres://postgres@127.0.0.1:55432/template1',
      rawProtocolTransport: 'jsi-array-buffer',
    };
  }
}

class DirectCapabilitiesNative extends MockNative {
  override async capabilities(): Promise<NativeCapabilities> {
    return {
      engine: 'nativeDirect',
      processIsolated: false,
      multiRoot: false,
      reopenable: true,
      sameRootLogicalReopen: true,
      rootSwitchable: false,
      crashRestartable: false,
      independentSessions: false,
      maxClientSessions: 1,
      protocolRaw: true,
      protocolStream: true,
      queryCancel: true,
      backupRestore: true,
      backupFormats: ['physicalArchive'],
      restoreFormats: ['physicalArchive'],
      simpleQuery: true,
      extensions: true,
      connectionString: undefined,
      rawProtocolTransport: 'jsi-array-buffer',
    };
  }
}

class ErroringQueryNative extends MockNative {
  constructor(
    private readonly sqlstate: string,
    private readonly message: string,
  ) {
    super();
  }

  override async execProtocolRawJsi(_handle: number, _request: Uint8Array): Promise<Uint8Array> {
    return backendErrorResponse('ERROR', this.sqlstate, this.message);
  }
}

type GlobalWithJsiTransport = typeof globalThis & {
  __oliphauntReactNativeJsi?: {
    version: 1;
    execProtocolRaw: (
      handle: number,
      request: Uint8Array,
    ) => Promise<ArrayBuffer | ArrayBufferView>;
    execProtocolStream?: (
      handle: number,
      request: Uint8Array,
      onChunk: (chunk: ArrayBuffer | ArrayBufferView) => void,
    ) => Promise<void>;
    backup: (handle: number, format: string) => Promise<ArrayBuffer | ArrayBufferView>;
    restore: (
      root: string,
      format: string,
      artifact: Uint8Array,
      replaceExisting: boolean,
      libraryPath: string | null,
    ) => Promise<string>;
  };
};

function installMockJsiTransport(native: MockNative): void {
  (globalThis as GlobalWithJsiTransport).__oliphauntReactNativeJsi = {
    version: 1,
    execProtocolRaw: (handle, request) => native.execProtocolRawJsi(handle, request),
    backup: (handle, format) => native.backupJsi(handle, format),
    restore: (root, format, artifact, replaceExisting, libraryPath) =>
      native.restoreJsi(root, format, artifact, replaceExisting, libraryPath),
  };
}

function backendSelectResponse(): Uint8Array {
  const out: number[] = [];
  pushRowDescription(out, [
    ['value', 25],
    ['empty', 25],
  ]);
  pushDataRow(out, [new TextEncoder().encode('1'), null]);
  pushCommandComplete(out, 'SELECT 1');
  pushReadyForQuery(out);
  return Uint8Array.from(out);
}

function backendSingleValueResponse(value: string): Uint8Array {
  return backendNamedValuesResponse([['value', value]]);
}

function backendNamedValuesResponse(fields: Array<[string, string | null]>): Uint8Array {
  return backendNamedRowsResponse(
    fields.map(([name]) => name),
    [fields.map(([, value]) => value)],
  );
}

function backendNamedRowsResponse(fields: string[], rows: Array<Array<string | null>>): Uint8Array {
  const out: number[] = [];
  pushRowDescription(
    out,
    fields.map((name) => [name, 25]),
  );
  for (const row of rows) {
    pushDataRow(
      out,
      row.map((value) => (value == null ? null : new TextEncoder().encode(value))),
    );
  }
  pushCommandComplete(out, 'SELECT 1');
  pushReadyForQuery(out);
  return Uint8Array.from(out);
}

function backendErrorResponse(severity: string, sqlstate: string, message: string): Uint8Array {
  const body: number[] = [];
  body.push(0x53, ...new TextEncoder().encode(severity), 0);
  body.push(0x43, ...new TextEncoder().encode(sqlstate), 0);
  body.push(0x4d, ...new TextEncoder().encode(message), 0);
  body.push(0);
  const out: number[] = [];
  pushBackendMessage(out, 0x45, body);
  pushReadyForQuery(out);
  return Uint8Array.from(out);
}

function pushRowDescription(out: number[], fields: Array<[string, number]>): void {
  pushRawRowDescription(
    out,
    fields.map(([name, typeOid]): [Uint8Array, number] => [
      new TextEncoder().encode(name),
      typeOid,
    ]),
  );
}

function pushRawRowDescription(out: number[], fields: Array<[Uint8Array, number]>): void {
  const body: number[] = [];
  pushI16(body, fields.length);
  for (const [name, typeOid] of fields) {
    body.push(...name, 0);
    pushU32(body, 0);
    pushI16(body, 0);
    pushU32(body, typeOid);
    pushI16(body, -1);
    pushI32(body, -1);
    pushI16(body, 0);
  }
  pushBackendMessage(out, 0x54, body);
}

function pushDataRow(out: number[], values: Array<Uint8Array | null>): void {
  const body: number[] = [];
  pushI16(body, values.length);
  for (const value of values) {
    if (value === null) {
      pushI32(body, -1);
    } else {
      pushI32(body, value.length);
      body.push(...value);
    }
  }
  pushBackendMessage(out, 0x44, body);
}

function pushCommandComplete(out: number[], tag: string): void {
  pushBackendMessage(out, 0x43, [...new TextEncoder().encode(tag), 0]);
}

function pushNoticeResponse(out: number[], severity: string, message: string): void {
  const body: number[] = [];
  body.push(0x53, ...new TextEncoder().encode(severity), 0);
  body.push(0x4d, ...new TextEncoder().encode(message), 0);
  body.push(0);
  pushBackendMessage(out, 0x4e, body);
}

function pushParameterStatus(out: number[], name: string, value: string): void {
  pushBackendMessage(out, 0x53, [
    ...new TextEncoder().encode(name),
    0,
    ...new TextEncoder().encode(value),
    0,
  ]);
}

function pushNotificationResponse(
  out: number[],
  pid: number,
  channel: string,
  payload: string,
): void {
  const body: number[] = [];
  pushI32(body, pid);
  body.push(...new TextEncoder().encode(channel), 0);
  body.push(...new TextEncoder().encode(payload), 0);
  pushBackendMessage(out, 0x41, body);
}

function pushReadyForQuery(out: number[], status = 0x49): void {
  pushBackendMessage(out, 0x5a, [status]);
}

function pushBackendMessage(out: number[], tag: number, body: number[]): void {
  out.push(tag);
  pushI32(out, body.length + 4);
  out.push(...body);
}

function pushI32(out: number[], value: number): void {
  pushU32(out, value >>> 0);
}

function pushU32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff);
  out.push((value >>> 16) & 0xff);
  out.push((value >>> 8) & 0xff);
  out.push(value & 0xff);
}

function pushI16(out: number[], value: number): void {
  const bits = value & 0xffff;
  out.push((bits >>> 8) & 0xff);
  out.push(bits & 0xff);
}

test('client', async () => {
  await main();
});
