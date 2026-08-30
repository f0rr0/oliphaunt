import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { installedPackageClosure } from './installed-closure.mjs';
import { dispatchPgliteRequest } from './pglite-node-worker.mjs';
import {
  assertExpectedRawProtocolResponse,
  assertNativeAddonContract,
  assertNativeArtifactProvenance,
  assertRuntimeBuildConfiguration,
  assertSuccessfulRawProtocolResponse,
  bulkSql,
  comfortableWinGate,
  defaultPlanFile,
  expandExpectedResult,
  expectedBulkProtocol,
  geomean,
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

  assert.equal(summary.schema, 'oliphaunt-wasix-node-benchmark-plan-v2');
  assert.equal(summary.id, 'node-pglite-memory-v2');
  assert.equal(summary.engines.candidate.package, '@oliphaunt/wasix-ts');
  assert.deepEqual(summary.engines.candidate.nativeAddon, {
    schema: 'oliphaunt-wasix-napi-host-v1',
    product: 'oliphaunt-wasix-napi',
    binary: 'oliphaunt_wasix_napi.node',
    addonAbiVersion: 1,
    nodeApiVersion: 8,
    profiles: ['standard', 'icu'],
    build: {
      cargoProfile: 'release',
      incremental: false,
      codegenUnits: 1,
      lto: 'thin',
      strip: 'symbols',
      features: ['release'],
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
  });
  assert.deepEqual(summary.engines.candidate.surfaces.worker, {
    engine: 'candidate-worker',
    entrypoint: '@oliphaunt/wasix-ts/worker',
    callingContract: 'async',
    executionOwner: 'sdk-worker',
    executionBoundary: 'node-worker-thread',
    isolationImplementation: 'package-owned-worker-rpc',
    timingBoundary: 'host-end-to-end-around-one-isolation-rpc',
  });
  assert.deepEqual(summary.engines.candidate.surfaces.direct, {
    engine: 'candidate-direct',
    entrypoint: '@oliphaunt/wasix-ts/direct',
    callingContract: 'async',
    executionOwner: 'caller',
    executionBoundary: 'node-caller-realm',
    isolationImplementation: 'none-caller-realm',
    timingBoundary: 'caller-around-public-api',
  });
  assert.equal(summary.engines.comparison.package, '@electric-sql/pglite');
  assert.equal(summary.engines.comparison.version, '0.5.4');
  assert.equal(summary.engines.comparison.homepage, 'https://pglite.dev');
  assert.equal(
    summary.engines.comparison.sourceRepository,
    'https://github.com/electric-sql/pglite',
  );
  assert.equal(summary.gate.maxGeomeanRatio, 0.8);
  assert.deepEqual(summary.gate.comparisons, ['worker', 'direct']);
  assert.deepEqual(summary.engines.comparison.surfaces.callerRealm, {
    engine: 'comparison-direct',
    entrypoint: '@electric-sql/pglite',
    callingContract: 'async',
    executionOwner: 'caller',
    executionBoundary: 'node-main-thread',
    isolationImplementation: 'none-caller-realm',
    timingBoundary: 'caller-around-public-api',
  });
  assert.equal(
    summary.engines.candidate.surfaces.worker.timingBoundary,
    summary.engines.comparison.surfaces.worker.timingBoundary,
  );
  assert.equal(
    summary.engines.comparison.surfaces.worker.benchmarkMethodology,
    'official-browser-worker-timer-reference-only-not-collected',
  );
  assert.equal(
    summary.engines.comparison.surfaces.worker.gatedResponsePayload,
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

test('candidate native addon contract rejects ABI, profile, and optimization drift', async () => {
  const { plan } = await loadPlan(defaultPlanFile, { repositoryBindings: false });
  assert.deepEqual(
    assertNativeAddonContract(
      plan.engines.candidate.nativeAddon,
      plan.engines.candidate.nativeAddon,
    ),
    plan.engines.candidate.nativeAddon,
  );
  const drifts = [
    ['addon ABI', (value) => (value.addonAbiVersion = 2), /addonAbiVersion/u],
    ['Node-API floor', (value) => (value.nodeApiVersion = 9), /nodeApiVersion/u],
    ['profiles', (value) => value.profiles.reverse(), /profiles/u],
    ['Cargo profile', (value) => (value.build.cargoProfile = 'debug'), /cargoProfile/u],
    ['incremental', (value) => (value.build.incremental = true), /incremental/u],
    ['codegen units', (value) => (value.build.codegenUnits = 16), /codegenUnits/u],
    ['LTO', (value) => (value.build.lto = false), /build\.lto/u],
    ['features', (value) => value.build.features.push('icu'), /build\.features/u],
  ];
  for (const [label, mutate, error] of drifts) {
    const drifted = structuredClone(plan.engines.candidate.nativeAddon);
    mutate(drifted);
    assert.throws(
      () => assertNativeAddonContract(drifted, plan.engines.candidate.nativeAddon),
      error,
      label,
    );
  }
});

test('candidate native artifact provenance must match the benchmark commit and target', async () => {
  const { plan } = await loadPlan(defaultPlanFile, { repositoryBindings: false });
  const artifactSourceSha = 'a'.repeat(40);
  const target = 'linux-x64-gnu';
  const targetTriple = 'x86_64-unknown-linux-gnu';
  const carrier = {
    name: '@oliphaunt/wasix-napi-linux-x64-gnu',
    version: '0.0.0',
    target,
    artifactProvenanceMember: 'package/artifact-provenance.json',
    manifest: {
      oliphaunt: {
        target,
        addonAbiVersion: plan.engines.candidate.nativeAddon.addonAbiVersion,
        nodeApiVersion: plan.engines.candidate.nativeAddon.nodeApiVersion,
        profiles: plan.engines.candidate.nativeAddon.profiles,
      },
    },
    artifactProvenance: {
      schema: 'oliphaunt-wasix-napi-provenance-v1',
      product: 'oliphaunt-wasix-napi',
      target,
      artifactSourceSha,
      build: { ...plan.engines.candidate.nativeAddon.build, targetTriple },
      buildInputs: {
        schema: 'oliphaunt-wasix-napi-build-inputs-v1',
        target,
        targetTriple,
      },
      binary: {
        filename: plan.engines.candidate.nativeAddon.binary,
        sha256: 'b'.repeat(64),
      },
    },
  };

  assert.equal(
    assertNativeArtifactProvenance(carrier, plan.engines.candidate.nativeAddon, artifactSourceSha)
      .artifactProvenance,
    carrier.artifactProvenance,
  );
  assert.throws(
    () =>
      assertNativeArtifactProvenance(carrier, plan.engines.candidate.nativeAddon, 'c'.repeat(40)),
    /addon\/source contract/u,
  );
  const wrongBuildTarget = structuredClone(carrier);
  wrongBuildTarget.artifactProvenance.buildInputs.target = 'linux-arm64-gnu';
  assert.throws(
    () =>
      assertNativeArtifactProvenance(
        wrongBuildTarget,
        plan.engines.candidate.nativeAddon,
        artifactSourceSha,
      ),
    /addon\/source contract/u,
  );
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
  comparatorTelemetry.engines.comparison.surfaces.worker.gatedResponsePayload =
    'public-result-plus-internal-timing';
  assert.throws(() => validatePlan(comparatorTelemetry), /gatedResponsePayload/u);

  const workerEntrypointDrift = structuredClone(plan);
  workerEntrypointDrift.engines.candidate.surfaces.worker.entrypoint = '@oliphaunt/wasix-ts';
  assert.throws(() => validatePlan(workerEntrypointDrift), /surfaces\.worker\.entrypoint/u);

  const directOwnerDrift = structuredClone(plan);
  directOwnerDrift.engines.candidate.surfaces.direct.executionOwner = 'sdk-worker';
  assert.throws(() => validatePlan(directOwnerDrift), /surfaces\.direct\.executionOwner/u);

  const invalidGateLabel = structuredClone(plan);
  invalidGateLabel.gate.comparisons[1] = 'inline';
  assert.throws(() => validatePlan(invalidGateLabel), /gate\.comparisons/u);

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

  const hostWithoutLto = structuredClone(plan);
  hostWithoutLto.engines.candidate.nativeAddon.build.lto = 'off';
  assert.throws(() => validatePlan(hostWithoutLto), /nativeAddon\.build\.lto/u);
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
