import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { installedPackageClosure } from './installed-closure.mjs';
import { dispatchPgliteRequest } from './pglite-node-worker.mjs';
import {
  assertExpectedRawProtocolResponse,
  assertRuntimeBuildConfiguration,
  assertSuccessfulRawProtocolResponse,
  bulkSql,
  comfortableWinGate,
  defaultPlanFile,
  expandExpectedResult,
  expectedBulkProtocol,
  geomean,
  installedHostBuildProvenance,
  latencySummary,
  loadPlan,
  median,
  metricIds,
  pairedRatioSummary,
  planSummary,
  postgresSettingsParity,
  simpleQueryMessage,
  validatePlan,
} from './plan.mjs';

test('the checked-in plan pins identities, generated SQL, and the comfortable-win gate', async () => {
  const source = await loadPlan(defaultPlanFile);
  const summary = planSummary(source.plan, source);

  assert.equal(summary.engines.candidate.package, '@oliphaunt/wasix-ts');
  assert.deepEqual(summary.engines.candidate.hostBuild, {
    wasmerJsCommit: '93b8b738ebd3ee57e118da0f0eb795b97d5b999e',
    wasmerWasixVersion: '0.601.0',
    inputsSha256: '722f44d6a53742aef649e0d9cf6ead004482f36344e6cf95c6a0b701bdb4f533',
    guestConcurrency: 'denied-for-oliphaunt-single-backend',
    optimization: {
      cargoProfile: 'release',
      rustOptLevel: 3,
      lto: true,
      wasmOpt: ['--enable-threads', '--enable-bulk-memory', '-O3'],
    },
  });
  assert.deepEqual(summary.engines.candidate.runtimeBuild, {
    profile: 'release',
    cflags: '-O2 -g0 -flto=thin',
    ldflags: '-flto=thin',
    configureWasmOpt: 'no',
    buildWasmOpt: 'yes',
    wasmOptFlags: '--converge:--strip-debug:--strip-producers',
    wasmOptSuppressDefault: '',
    wasmOptPreserveUnoptimized: '',
    compilerFlags: '',
    linkerFlags: '',
    backendTiming: '0',
  });
  assert.equal(summary.engines.candidate.executionBoundary, 'node-worker-thread');
  assert.equal(summary.engines.candidate.directExecutionBoundary, 'node-main-thread');
  assert.equal(summary.engines.candidate.directIsolationImplementation, 'none-main-thread');
  assert.equal(summary.engines.candidate.directTimingBoundary, 'caller-around-public-api');
  assert.equal(summary.engines.comparison.package, '@electric-sql/pglite');
  assert.equal(summary.engines.comparison.version, '0.5.4');
  assert.equal(summary.engines.comparison.homepage, 'https://pglite.dev');
  assert.equal(
    summary.engines.comparison.sourceRepository,
    'https://github.com/electric-sql/pglite',
  );
  assert.equal(summary.gate.maxGeomeanRatio, 0.8);
  assert.deepEqual(summary.gate.placements, ['worker', 'direct']);
  assert.equal(summary.engines.comparison.executionBoundary, 'node-worker-thread');
  assert.equal(summary.engines.comparison.directExecutionBoundary, 'node-main-thread');
  assert.equal(summary.engines.comparison.directIsolationImplementation, 'none-main-thread');
  assert.equal(summary.engines.comparison.directTimingBoundary, 'caller-around-public-api');
  assert.equal(summary.engines.candidate.timingBoundary, summary.engines.comparison.timingBoundary);
  assert.equal(
    summary.engines.comparison.benchmarkMethodology,
    'official-browser-worker-timer-reference-only-not-collected',
  );
  assert.equal(
    summary.engines.comparison.gatedResponsePayload,
    'public-result-only-no-comparator-telemetry',
  );
  assert.equal(summary.measurement.pairedRepeats, 10);
  assert.equal(summary.measurement.pairing, 'same-repeat-candidate-over-comparison');
  assert.equal(summary.measurement.startupMetric, 'cold-to-first-result');
  assert.deepEqual(summary.measurement.startupMetricIncludes, [
    'public-open',
    'immediate-first-query',
  ]);
  assert.equal(summary.bulkTransport.publicApi, 'execProtocolRaw');
  assert.equal(summary.bulkTransport.pgliteSyncToFs, false);
  assert.equal(summary.postgres.expectedSettings.shared_buffers, '128MB');
  assert.equal(summary.postgres.expectedSettings.max_parallel_maintenance_workers, '0');
  assert.deepEqual(metricIds(source.plan), [
    'cold-to-first-result',
    'warm-rtt/parameter-scalar/p50',
    'warm-rtt/indexed-lookup/p50',
    'warm-rtt/counter-update/p50',
    'bulk/insert-series/elapsed',
    'bulk/create-index/elapsed',
    'bulk/indexed-update/elapsed',
    'bulk/aggregate/elapsed',
  ]);
  assert.deepEqual(
    summary.generatedSql.map(({ sha256 }) => sha256),
    [
      'b33b0aea9b7fd4d93bb499069dc768fe53810bfc3c0bd1b0a3cde8e23205ef2b',
      '6d7e5592e5d4135a1a42f78d796b6d9c2ff40b9ba7e14edd4a11cdd4e8340ced',
      'a431224ba0bd421b74fc2a9437b2a4a505b5e6fb1aa9a897a829d1c05f4b3ba6',
      'e21d82bb79fff4535b3368a5933b003f540aa86926422f823e8de9f07f991536',
    ],
  );
  assert.ok(source.plan.bulk.every((entry) => Buffer.byteLength(bulkSql(entry)) < 512));
});

test('the gated comparator worker returns public results without private timing telemetry', async () => {
  const rawResponse = Uint8Array.of(1, 2, 3);
  const calls = [];
  const database = {
    async query(sql, parameters) {
      calls.push(['query', sql, parameters]);
      return { fields: [{ name: 'answer' }], rows: [{ answer: 42 }] };
    },
    async exec(sql) {
      calls.push(['execute', sql]);
    },
    async execProtocolRaw(input, options) {
      calls.push(['rawProtocol', [...input], options]);
      return rawResponse;
    },
    async close() {
      calls.push(['close']);
    },
  };

  const query = await dispatchPgliteRequest(database, {
    id: 1,
    method: 'query',
    args: ['SELECT $1', [42]],
  });
  assert.deepEqual(query.result, {
    result: { fields: [{ name: 'answer' }], rows: [{ answer: 42 }] },
  });
  assert.deepEqual(Object.keys(query.result), ['result']);

  const raw = await dispatchPgliteRequest(database, {
    id: 2,
    method: 'rawProtocol',
    args: [Uint8Array.of(9), false],
  });
  assert.deepEqual(raw.result, { response: rawResponse });
  assert.deepEqual(Object.keys(raw.result), ['response']);
  assert.deepEqual(raw.transfer, [rawResponse.buffer]);

  const execute = await dispatchPgliteRequest(database, {
    id: 3,
    method: 'execute',
    args: ['SELECT 1'],
  });
  assert.deepEqual(execute.result, {});
  assert.equal(
    JSON.stringify([query.result, raw.result, execute.result]).includes('Elapsed'),
    false,
  );
  assert.deepEqual(calls, [
    ['query', 'SELECT $1', [42]],
    ['rawProtocol', [9], { syncToFs: false }],
    ['execute', 'SELECT 1'],
  ]);
});

test('the exact installed comparator tree matches the plan byte pin', async () => {
  const { plan } = await loadPlan(defaultPlanFile);
  const require = createRequire(import.meta.url);
  const closure = await installedPackageClosure(
    require.resolve(plan.engines.comparison.package),
    plan.engines.comparison.package,
  );
  const root = closure.packages.find((candidate) => candidate.id === closure.root);
  assert.equal(closure.treeHashSchema, plan.engines.comparison.installedTreeHashSchema);
  assert.equal(root.installedTreeSha256, plan.engines.comparison.installedTreeSha256);
  assert.deepEqual(root.dependencies, []);
});

test('installed candidate host provenance must exactly match the speed-optimized plan', async () => {
  const { plan } = await loadPlan(defaultPlanFile, { repositoryBindings: false });
  const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-host-provenance-'));
  const manifestFile = resolve(scratch, 'package.json');
  const provenanceFile = resolve(scratch, 'lib/host/provenance.json');
  await mkdir(resolve(scratch, 'lib/host'), { recursive: true });
  await writeFile(manifestFile, '{}\n');
  await writeFile(provenanceFile, `${JSON.stringify(plan.engines.candidate.hostBuild)}\n`);

  try {
    assert.deepEqual(
      await installedHostBuildProvenance(manifestFile, plan.engines.candidate.hostBuild),
      plan.engines.candidate.hostBuild,
    );

    const drifts = [
      [
        'Wasmer JS identity',
        (value) => {
          value.wasmerJsCommit = '0'.repeat(40);
        },
        /wasmerJsCommit/u,
      ],
      [
        'wasmer-wasix identity',
        (value) => {
          value.wasmerWasixVersion = '0.602.0';
        },
        /wasmerWasixVersion/u,
      ],
      [
        'host inputs',
        (value) => {
          value.inputsSha256 = '0'.repeat(64);
        },
        /inputsSha256/u,
      ],
      [
        'guest concurrency policy',
        (value) => {
          value.guestConcurrency = 'allowed';
        },
        /guestConcurrency/u,
      ],
      [
        'Cargo profile',
        (value) => {
          value.optimization.cargoProfile = 'debug';
        },
        /cargoProfile/u,
      ],
      [
        'Rust optimization',
        (value) => {
          value.optimization.rustOptLevel = 2;
        },
        /rustOptLevel/u,
      ],
      [
        'LTO',
        (value) => {
          value.optimization.lto = false;
        },
        /optimization\.lto/u,
      ],
      [
        'wasm-opt',
        (value) => {
          value.optimization.wasmOpt[2] = '-Oz';
        },
        /optimization\.wasmOpt/u,
      ],
    ];
    for (const [label, mutate, error] of drifts) {
      const drifted = structuredClone(plan.engines.candidate.hostBuild);
      mutate(drifted);
      await writeFile(provenanceFile, `${JSON.stringify(drifted)}\n`);
      await assert.rejects(
        installedHostBuildProvenance(manifestFile, plan.engines.candidate.hostBuild),
        error,
        label,
      );
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test('plan validation rejects comparator drift and a weaker performance claim', async () => {
  const { plan } = await loadPlan(defaultPlanFile, { repositoryBindings: false });

  const versionDrift = structuredClone(plan);
  versionDrift.engines.comparison.version = '^0.5.4';
  assert.throws(() => validatePlan(versionDrift), /expected "0\.5\.4"/u);

  const integrityDrift = structuredClone(plan);
  integrityDrift.engines.comparison.integrity = `sha512-${'A'.repeat(88)}`;
  assert.throws(() => validatePlan(integrityDrift), /comparison\.integrity/u);

  const weakerGate = structuredClone(plan);
  weakerGate.gate.maxGeomeanRatio = 0.81;
  assert.throws(() => validatePlan(weakerGate), /no greater than 0\.80/u);

  const tooFewSamples = structuredClone(plan);
  tooFewSamples.measurement.sampleIterations = 19;
  assert.throws(() => validatePlan(tooFewSamples), /integer of at least 20/u);

  const tooFewPairs = structuredClone(plan);
  tooFewPairs.measurement.pairedRepeats = 8;
  assert.throws(() => validatePlan(tooFewPairs), /integer of at least 9/u);

  const comparatorTelemetry = structuredClone(plan);
  comparatorTelemetry.engines.comparison.gatedResponsePayload =
    'public-result-plus-internal-timing';
  assert.throws(() => validatePlan(comparatorTelemetry), /gatedResponsePayload/u);

  const unbalancedPairs = structuredClone(plan);
  unbalancedPairs.measurement.pairedRepeats = 9;
  assert.throws(() => validatePlan(unbalancedPairs), /must be even/u);

  const optimizedOutsideThePlan = structuredClone(plan.engines.candidate.runtimeBuild);
  optimizedOutsideThePlan.compilerFlags = '-O3';
  assert.throws(
    () =>
      assertRuntimeBuildConfiguration(optimizedOutsideThePlan, plan.engines.candidate.runtimeBuild),
    /compilerFlags/u,
  );

  const hostOptimizedForSize = structuredClone(plan);
  hostOptimizedForSize.engines.candidate.hostBuild.optimization.rustOptLevel = 'z';
  assert.throws(() => validatePlan(hostOptimizedForSize), /hostBuild\.optimization\.rustOptLevel/u);
});

test('summary math and correctness placeholders are deterministic', () => {
  assert.deepEqual(latencySummary([9, 1, 5, 3, 7], 0.2), {
    samples: 5,
    trimmedSamples: 3,
    minMs: 1,
    p50Ms: 5,
    p90Ms: 9,
    p95Ms: 9,
    p99Ms: 9,
    maxMs: 9,
    trimmedMeanMs: 5,
  });
  assert.equal(median([7, 1, 5, 3]), 4);
  assert.deepEqual(pairedRatioSummary([6, 4, 10], [3, 8, 5]), {
    pairedRatios: [2, 0.5, 2],
    medianRatio: 2,
  });
  assert.ok(Math.abs(geomean([0.5, 0.8]) - Math.sqrt(0.4)) < Number.EPSILON);
  assert.equal(comfortableWinGate([0.8], 0.8, true).gate.passed, true);
  assert.equal(comfortableWinGate([0.81], 0.8, true).gate.passed, false);
  assert.equal(comfortableWinGate([0.5], 0.8, false).gate.passed, false);
  assert.deepEqual(
    expandExpectedResult(
      { fields: ['counter'], rows: [['$totalIterations']] },
      { $totalIterations: 110 },
    ),
    { fields: ['counter'], rows: [['110']] },
  );
  assert.deepEqual(
    [...simpleQueryMessage('SELECT 1')],
    [0x51, 0, 0, 0, 13, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x31, 0],
  );
  assert.doesNotThrow(() =>
    assertSuccessfulRawProtocolResponse(
      Uint8Array.from([
        0x43, 0, 0, 0, 11, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0, 0x5a, 0, 0, 0, 5, 0x49,
      ]),
      'test response',
    ),
  );
  const createIndex = expectedBulkProtocol({ operation: { kind: 'create-payload-index' } });
  const readyOnly = protocolFrame(0x5a, Uint8Array.of(0x49));
  assert.throws(
    () => assertExpectedRawProtocolResponse(readyOnly, createIndex, 'bulk create-index'),
    /expected/u,
  );
  const createIndexResponse = concatenate([
    protocolFrame(0x53, new TextEncoder().encode('in_hot_standby\0off\0')),
    protocolFrame(0x43, new TextEncoder().encode('CREATE INDEX\0')),
    protocolFrame(0x4e, new TextEncoder().encode('SNOTICE\0Mvalidated notice\0\0')),
    readyOnly,
  ]);
  assert.deepEqual(
    assertExpectedRawProtocolResponse(createIndexResponse, createIndex, 'bulk create-index'),
    createIndex,
  );
  assert.throws(
    () =>
      assertExpectedRawProtocolResponse(
        concatenate([
          protocolFrame(0x53, new TextEncoder().encode('in_hot_standby\0off')),
          protocolFrame(0x43, new TextEncoder().encode('CREATE INDEX\0')),
          readyOnly,
        ]),
        createIndex,
        'malformed parameter status',
      ),
    /ParameterStatus value is missing its NUL terminator/u,
  );
  const aggregate = {
    commandTags: ['SELECT 1'],
    results: [{ fields: ['answer'], rows: [['42']] }],
    transactionStatus: 'idle',
  };
  const aggregateResponse = concatenate([
    protocolFrame(0x54, rowDescription(['answer'])),
    protocolFrame(0x44, dataRow(['42'])),
    protocolFrame(0x43, new TextEncoder().encode('SELECT 1\0')),
    readyOnly,
  ]);
  assert.deepEqual(
    assertExpectedRawProtocolResponse(aggregateResponse, aggregate, 'bulk aggregate'),
    aggregate,
  );

  const settingNames = ['fsync', 'shared_buffers'];
  const reports = [
    reportSettings('candidate', 0, { fsync: 'off', shared_buffers: '128MB' }),
    reportSettings('comparison', 0, { fsync: 'off', shared_buffers: '128MB' }),
  ];
  assert.equal(postgresSettingsParity(reports, settingNames).passed, true);
  assert.equal(
    postgresSettingsParity(reports, settingNames, {
      fsync: 'off',
      shared_buffers: '128MB',
    }).passed,
    true,
  );
  assert.equal(
    postgresSettingsParity(reports, settingNames, {
      fsync: 'on',
      shared_buffers: '128MB',
    }).passed,
    false,
  );
  reports[1].postgres.settings.fsync = 'on';
  assert.equal(postgresSettingsParity(reports, settingNames).passed, false);
});

function protocolFrame(tag, body) {
  const frame = new Uint8Array(body.length + 5);
  frame[0] = tag;
  new DataView(frame.buffer).setUint32(1, body.length + 4);
  frame.set(body, 5);
  return frame;
}

function concatenate(chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function rowDescription(fields) {
  const encoder = new TextEncoder();
  const names = fields.map((field) => encoder.encode(`${field}\0`));
  const body = new Uint8Array(2 + names.reduce((size, name) => size + name.length + 18, 0));
  const view = new DataView(body.buffer);
  view.setUint16(0, fields.length);
  let offset = 2;
  for (const name of names) {
    body.set(name, offset);
    offset += name.length + 18;
  }
  return body;
}

function dataRow(values) {
  const encoder = new TextEncoder();
  const encoded = values.map((value) => encoder.encode(value));
  const body = new Uint8Array(2 + encoded.reduce((size, value) => size + 4 + value.length, 0));
  const view = new DataView(body.buffer);
  view.setUint16(0, values.length);
  let offset = 2;
  for (const value of encoded) {
    view.setInt32(offset, value.length);
    offset += 4;
    body.set(value, offset);
    offset += value.length;
  }
  return body;
}

function reportSettings(kind, repeat, settings) {
  return { engine: { kind }, repeat, postgres: { settings } };
}
