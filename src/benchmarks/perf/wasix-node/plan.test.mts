import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installedPackageClosure } from './installed-closure.mts';
import { dispatchPgliteRequest } from './pglite-node-worker.mts';
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
  pairedRatioSummary,
  postgresSettingsParity,
  simpleQueryMessage,
  validatePlan,
} from './plan.mts';

test('installed package identities include dependencies with only subpath exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-closure-'));
  try {
    const dependency = join(root, 'node_modules', '@oliphaunt', 'core');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        dependencies: { '@oliphaunt/core': '1.0.0' },
        optionalDependencies: { 'absent-test-package': '1.0.0' },
      }),
    );
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: '@oliphaunt/core',
        version: '1.0.0',
        exports: { './query': './query.mts' },
      }),
    );
    await writeFile(join(dependency, 'query.mts'), 'export const answer: number = 42;');
    const closure = await installedPackageClosure(join(root, 'package.json'), 'consumer');
    assert.deepEqual(
      closure.packages.map(({ name }) => name),
      ['@oliphaunt/core', 'consumer'],
    );
    const consumer = closure.packages.find(({ name }) => name === 'consumer');
    assert.equal(
      consumer.dependencies.find(({ name }) => name === '@oliphaunt/core').installed,
      true,
    );
    assert.equal(
      consumer.dependencies.find(({ name }) => name === 'absent-test-package').installed,
      false,
    );
    await rm(dependency, { recursive: true });
    await assert.rejects(
      installedPackageClosure(join(root, 'package.json'), 'consumer'),
      /cannot resolve installed dependency/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  const { plan } = await loadPlan(defaultPlanFile);
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
  const { plan } = await loadPlan(defaultPlanFile);
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

test('plan validation rejects malformed identity and a weaker performance claim', async () => {
  const { plan } = await loadPlan(defaultPlanFile);

  const versionDrift = structuredClone(plan);
  versionDrift.engines.comparison.version = '^0.5.4';
  assert.throws(() => validatePlan(versionDrift), /exact release version/u);

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
