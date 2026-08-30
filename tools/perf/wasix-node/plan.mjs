import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative as relativePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const defaultPlanFile = resolve(
  repositoryRoot,
  'benchmarks/wasix/node-pglite-memory-v2.json',
);

const PLAN_SCHEMA = 'oliphaunt-wasix-node-benchmark-plan-v2';
const PLAN_ID = 'node-pglite-memory-v2';
const PACKAGE_NAME = '@oliphaunt/wasix-ts';
const COMPARISON_PACKAGE = '@electric-sql/pglite';
const COMPARISON_VERSION = '0.5.4';
const COMPARISON_HOMEPAGE = 'https://pglite.dev';
const COMPARISON_REPOSITORY = 'https://github.com/electric-sql/pglite';
const COMPARISON_INTEGRITY =
  'sha512-yYZUyyXrHU7tPlCjwZQJ6hIG9DscdCCn7Uk0mYKwC1FeHX286AbcmFveMiRBEak8e9iPupjsoVImN3yJZVed2g==';
const COMPARISON_COMMIT = '25d0a55e1f1e4c59f26d9e125150dda88a33fd00';
const COMPARISON_TREE_SHA256 = 'b3925de04c386f51859c1bf18c143b225e3850616718140dd32e8eb48e9a2c84';
const FZSTD_VERSION = '0.1.1';
const NATIVE_ADDON = Object.freeze({
  schema: 'oliphaunt-wasix-napi-host-v1',
  product: 'oliphaunt-wasix-napi',
  binary: 'oliphaunt_wasix_napi.node',
  addonAbiVersion: 1,
  nodeApiVersion: 8,
  profiles: Object.freeze(['standard', 'icu']),
  build: Object.freeze({
    cargoProfile: 'release',
    incremental: false,
    codegenUnits: 1,
    lto: 'thin',
    strip: 'symbols',
    features: Object.freeze(['release']),
  }),
});
const RUNTIME_BUILD = Object.freeze({
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
const GATED_TIMING_BOUNDARY = 'host-end-to-end-around-one-isolation-rpc';
const LOWER_GIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_SETTING = /^[a-z][a-z0-9_]*$/u;
const BULK_OPERATIONS = new Set([
  'aggregate-query',
  'create-and-insert-series',
  'create-payload-index',
  'reverse-indexed-prefix',
]);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export async function loadPlan(file = defaultPlanFile, { repositoryBindings = true } = {}) {
  const bytes = await readFile(file);
  let plan;
  try {
    plan = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${relative(file)} must contain JSON: ${describeError(error)}`);
  }
  validatePlan(plan);
  if (repositoryBindings) {
    await validateRepositoryBindings(plan);
  }
  return { plan, file: resolve(file), sha256: sha256(bytes), size: bytes.length };
}

function validateEngines(plan) {
  equal(plan.id, PLAN_ID, 'plan.id');
  const engines = object(plan.engines, 'plan.engines');
  exactKeys(engines, ['candidate', 'comparison'], 'plan.engines');
  const candidate = object(engines.candidate, 'plan.engines.candidate');
  exactKeys(
    candidate,
    ['nativeAddon', 'package', 'runtimeBuild', 'storage', 'surfaces'],
    'plan.engines.candidate',
  );
  validateCandidateIdentity(candidate);
  const candidateSurfaces = object(candidate.surfaces, 'plan.engines.candidate.surfaces');
  exactKeys(candidateSurfaces, ['direct', 'worker'], 'plan.engines.candidate.surfaces');
  exactRecord(
    candidateSurfaces.worker,
    {
      callingContract: 'async',
      engine: 'candidate-worker',
      entrypoint: '@oliphaunt/wasix-ts/worker',
      executionBoundary: 'node-worker-thread',
      executionOwner: 'sdk-worker',
      isolationImplementation: 'package-owned-worker-rpc',
      timingBoundary: GATED_TIMING_BOUNDARY,
    },
    'plan.engines.candidate.surfaces.worker',
  );
  exactRecord(
    candidateSurfaces.direct,
    {
      callingContract: 'async',
      engine: 'candidate-direct',
      entrypoint: '@oliphaunt/wasix-ts/direct',
      executionBoundary: 'node-caller-realm',
      executionOwner: 'caller',
      isolationImplementation: 'none-caller-realm',
      timingBoundary: 'caller-around-public-api',
    },
    'plan.engines.candidate.surfaces.direct',
  );

  const comparison = object(engines.comparison, 'plan.engines.comparison');
  exactKeys(
    comparison,
    [
      'homepage',
      'installedTreeHashSchema',
      'installedTreeSha256',
      'integrity',
      'package',
      'sourceCommit',
      'sourceRepository',
      'storage',
      'surfaces',
      'version',
    ],
    'plan.engines.comparison',
  );
  validateComparisonIdentity(comparison);
  const comparisonSurfaces = object(comparison.surfaces, 'plan.engines.comparison.surfaces');
  exactKeys(comparisonSurfaces, ['callerRealm', 'worker'], 'plan.engines.comparison.surfaces');
  exactRecord(
    comparisonSurfaces.worker,
    {
      benchmarkMethodology: 'official-browser-worker-timer-reference-only-not-collected',
      benchmarkMethodologySource: 'packages/benchmark/src/benchmarks-worker.js',
      callingContract: 'async',
      engine: 'comparison-worker',
      entrypoint: 'tools/perf/wasix-node/pglite-node-worker.mjs',
      executionBoundary: 'node-worker-thread',
      executionOwner: 'harness-worker',
      gatedResponsePayload: 'public-result-only-no-comparator-telemetry',
      isolationImplementation: 'harness-owned-worker-threads-rpc',
      officialWorkerModule: 'browser-worker-only',
      timingBoundary: GATED_TIMING_BOUNDARY,
    },
    'plan.engines.comparison.surfaces.worker',
  );
  exactRecord(
    comparisonSurfaces.callerRealm,
    {
      callingContract: 'async',
      engine: 'comparison-direct',
      entrypoint: '@electric-sql/pglite',
      executionBoundary: 'node-main-thread',
      executionOwner: 'caller',
      isolationImplementation: 'none-caller-realm',
      timingBoundary: 'caller-around-public-api',
    },
    'plan.engines.comparison.surfaces.callerRealm',
  );
}

function validateCandidateIdentity(candidate) {
  equal(candidate.package, PACKAGE_NAME, 'plan.engines.candidate.package');
  equal(candidate.storage, 'memory', 'plan.engines.candidate.storage');
  assertNativeAddonContract(
    candidate.nativeAddon,
    NATIVE_ADDON,
    'plan.engines.candidate.nativeAddon',
  );
  assertRuntimeBuildConfiguration(
    object(candidate.runtimeBuild, 'plan.engines.candidate.runtimeBuild'),
    RUNTIME_BUILD,
    'plan.engines.candidate.runtimeBuild',
  );
}

function validateComparisonIdentity(comparison) {
  equal(comparison.package, COMPARISON_PACKAGE, 'plan.engines.comparison.package');
  equal(comparison.version, COMPARISON_VERSION, 'plan.engines.comparison.version');
  equal(comparison.homepage, COMPARISON_HOMEPAGE, 'plan.engines.comparison.homepage');
  equal(
    comparison.sourceRepository,
    COMPARISON_REPOSITORY,
    'plan.engines.comparison.sourceRepository',
  );
  equal(comparison.integrity, COMPARISON_INTEGRITY, 'plan.engines.comparison.integrity');
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(comparison.integrity)) {
    fail('plan.engines.comparison.integrity must be one exact SHA-512 SRI');
  }
  equal(comparison.sourceCommit, COMPARISON_COMMIT, 'plan.engines.comparison.sourceCommit');
  if (!LOWER_GIT_SHA.test(comparison.sourceCommit)) {
    fail('plan.engines.comparison.sourceCommit must be a full lowercase Git commit');
  }
  equal(comparison.storage, 'memory', 'plan.engines.comparison.storage');
  equal(
    comparison.installedTreeHashSchema,
    'oliphaunt-path-size-content-sha256-v1',
    'plan.engines.comparison.installedTreeHashSchema',
  );
  equal(
    comparison.installedTreeSha256,
    COMPARISON_TREE_SHA256,
    'plan.engines.comparison.installedTreeSha256',
  );
}

function exactRecord(actual, expected, label) {
  const record = object(actual, label);
  exactKeys(record, Object.keys(expected), label);
  for (const [field, value] of Object.entries(expected)) {
    equal(record[field], value, `${label}.${field}`);
  }
}

export function validatePlan(plan) {
  object(plan, 'plan');
  exactKeys(
    plan,
    [
      'bulk',
      'bulkTransport',
      'description',
      'engines',
      'firstQuery',
      'gate',
      'id',
      'measurement',
      'postgres',
      'schema',
      'warmRtt',
      'warmSetupSql',
      'warmValidation',
    ],
    'plan',
  );
  equal(plan.schema, PLAN_SCHEMA, 'plan.schema');
  validateEngines(plan);
  safeId(plan.id, 'plan.id');
  nonEmptyString(plan.description, 'plan.description');

  const measurement = object(plan.measurement, 'plan.measurement');
  exactKeys(
    measurement,
    [
      'pairedRepeats',
      'pairing',
      'percentileMethod',
      'processOrder',
      'sampleIterations',
      'startupMetric',
      'startupMetricIncludes',
      'trimFraction',
      'warmupIterations',
    ],
    'plan.measurement',
  );
  positiveInteger(measurement.pairedRepeats, 'plan.measurement.pairedRepeats', 9);
  if (measurement.pairedRepeats % 2 !== 0) {
    fail('plan.measurement.pairedRepeats must be even to balance gated engine launch order');
  }
  positiveInteger(measurement.warmupIterations, 'plan.measurement.warmupIterations', 1);
  positiveInteger(measurement.sampleIterations, 'plan.measurement.sampleIterations', 20);
  if (
    typeof measurement.trimFraction !== 'number' ||
    measurement.trimFraction < 0 ||
    measurement.trimFraction >= 0.5
  ) {
    fail('plan.measurement.trimFraction must be a number from 0 up to, but not including, 0.5');
  }
  equal(
    measurement.processOrder,
    'alternating-worker-pairs-then-alternating-direct-pairs-fresh-processes',
    'plan.measurement.processOrder',
  );
  equal(measurement.pairing, 'same-repeat-candidate-over-comparison', 'plan.measurement.pairing');
  equal(measurement.percentileMethod, 'nearest-rank', 'plan.measurement.percentileMethod');
  equal(measurement.startupMetric, 'cold-to-first-result', 'plan.measurement.startupMetric');
  exactStringList(
    measurement.startupMetricIncludes,
    ['public-open', 'immediate-first-query'],
    'plan.measurement.startupMetricIncludes',
  );

  const gate = object(plan.gate, 'plan.gate');
  exactKeys(
    gate,
    ['comparisons', 'includes', 'maxGeomeanRatio', 'metric', 'requiresCorrectness'],
    'plan.gate',
  );
  if (
    typeof gate.maxGeomeanRatio !== 'number' ||
    gate.maxGeomeanRatio <= 0 ||
    gate.maxGeomeanRatio > 0.8
  ) {
    fail('plan.gate.maxGeomeanRatio must be positive and no greater than 0.80');
  }
  equal(gate.requiresCorrectness, true, 'plan.gate.requiresCorrectness');
  exactStringList(gate.comparisons, ['worker', 'direct'], 'plan.gate.comparisons');
  equal(
    gate.metric,
    'geometric-mean-of-median-paired-candidate-over-comparison-ratios-lower-is-better',
    'plan.gate.metric',
  );
  exactStringList(
    gate.includes,
    ['cold-to-first-result', 'warm-rtt-p50', 'bulk-elapsed'],
    'plan.gate.includes',
  );

  const bulkTransport = object(plan.bulkTransport, 'plan.bulkTransport');
  exactKeys(
    bulkTransport,
    ['pgliteSyncToFs', 'publicApi', 'request', 'response', 'validation'],
    'plan.bulkTransport',
  );
  equal(bulkTransport.publicApi, 'execProtocolRaw', 'plan.bulkTransport.publicApi');
  equal(bulkTransport.request, 'postgres-simple-query-message', 'plan.bulkTransport.request');
  equal(bulkTransport.response, 'raw-postgres-protocol-bytes', 'plan.bulkTransport.response');
  equal(bulkTransport.pgliteSyncToFs, false, 'plan.bulkTransport.pgliteSyncToFs');
  equal(
    bulkTransport.validation,
    'timed-response-semantics-and-canonical-state-validation',
    'plan.bulkTransport.validation',
  );

  const postgres = object(plan.postgres, 'plan.postgres');
  exactKeys(postgres, ['expectedSettings', 'major', 'settings'], 'plan.postgres');
  positiveInteger(postgres.major, 'plan.postgres.major', 1);
  nonEmptyArray(postgres.settings, 'plan.postgres.settings');
  const settings = new Set();
  for (const [index, setting] of postgres.settings.entries()) {
    if (typeof setting !== 'string' || !SAFE_SETTING.test(setting) || settings.has(setting)) {
      fail(`plan.postgres.settings[${index}] must be a unique safe PostgreSQL setting name`);
    }
    settings.add(setting);
  }
  const expectedSettings = object(postgres.expectedSettings, 'plan.postgres.expectedSettings');
  exactKeys(expectedSettings, postgres.settings, 'plan.postgres.expectedSettings');
  for (const setting of postgres.settings) {
    nonEmptyString(expectedSettings[setting], `plan.postgres.expectedSettings.${setting}`);
  }

  validateQuery(plan.firstQuery, 'plan.firstQuery');
  nonEmptyString(plan.warmSetupSql, 'plan.warmSetupSql');
  validateWarmCases(plan.warmRtt);
  validateQuery(plan.warmValidation, 'plan.warmValidation', { allowPlaceholder: true });
  validateBulk(plan.bulk);
  return plan;
}

export async function validateRepositoryBindings(plan) {
  const candidateFile = resolve(repositoryRoot, 'src/bindings/wasix-ts/package.json');
  const candidate = JSON.parse(await readFile(candidateFile, 'utf8'));
  equal(candidate.name, plan.engines.candidate.package, `${relative(candidateFile)}.name`);
  equal(
    candidate.exports?.['.']?.node,
    './lib/index.node.js',
    `${relative(candidateFile)}.exports["."].node`,
  );
  equal(
    candidate.exports?.['./direct']?.node,
    './lib/direct.node.js',
    `${relative(candidateFile)}.exports["./direct"].node`,
  );
  equal(
    candidate.exports?.['./worker']?.node,
    './lib/worker-entry.node.js',
    `${relative(candidateFile)}.exports["./worker"].node`,
  );
  equal(
    candidate.dependencies?.fzstd,
    FZSTD_VERSION,
    `${relative(candidateFile)}.dependencies.fzstd`,
  );
  equal(
    candidate.devDependencies?.[plan.engines.comparison.package],
    plan.engines.comparison.version,
    `${relative(candidateFile)}.devDependencies.${plan.engines.comparison.package}`,
  );
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (candidate[field]?.[plan.engines.comparison.package] !== undefined) {
      fail(
        `${relative(candidateFile)}.${field} must not publish the benchmark-only PGlite control`,
      );
    }
  }

  const harnessFile = resolve(repositoryRoot, 'tools/perf/wasix-node/package.json');
  const harness = JSON.parse(await readFile(harnessFile, 'utf8'));
  equal(harness.private, true, `${relative(harnessFile)}.private`);
  equal(
    harness.dependencies?.[plan.engines.comparison.package],
    plan.engines.comparison.version,
    `${relative(harnessFile)}.dependencies.${plan.engines.comparison.package}`,
  );
  const lockFile = resolve(repositoryRoot, 'pnpm-lock.yaml');
  const lock = await readFile(lockFile, 'utf8');
  const lockedControl =
    `  '${plan.engines.comparison.package}@${plan.engines.comparison.version}':\n` +
    `    resolution: {integrity: ${plan.engines.comparison.integrity}}`;
  if (!lock.includes(lockedControl)) {
    fail(`${relative(lockFile)} must lock the exact PGlite control and its expected integrity`);
  }
  const nativeProductFile = resolve(repositoryRoot, 'src/runtimes/wasix-napi/package.json');
  const nativeProduct = JSON.parse(await readFile(nativeProductFile, 'utf8'));
  equal(nativeProduct.name, '@oliphaunt/wasix-napi', `${relative(nativeProductFile)}.name`);
  equal(
    nativeProduct.oliphaunt?.addonAbiVersion,
    plan.engines.candidate.nativeAddon.addonAbiVersion,
    `${relative(nativeProductFile)}.oliphaunt.addonAbiVersion`,
  );
  equal(
    nativeProduct.oliphaunt?.nodeApiVersion,
    plan.engines.candidate.nativeAddon.nodeApiVersion,
    `${relative(nativeProductFile)}.oliphaunt.nodeApiVersion`,
  );
  exactStringList(
    nativeProduct.oliphaunt?.profiles,
    plan.engines.candidate.nativeAddon.profiles,
    `${relative(nativeProductFile)}.oliphaunt.profiles`,
  );
  return { candidate, harness };
}

export function planSummary(plan, source) {
  return {
    schema: plan.schema,
    id: plan.id,
    source: {
      path: relative(source.file),
      sha256: source.sha256,
      size: source.size,
    },
    engines: plan.engines,
    measurement: plan.measurement,
    gate: plan.gate,
    bulkTransport: plan.bulkTransport,
    postgres: plan.postgres,
    metrics: metricIds(plan),
    generatedSql: plan.bulk.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      sha256: sha256(bulkSql(entry)),
      bytes: Buffer.byteLength(bulkSql(entry)),
    })),
  };
}

export function assertRuntimeBuildConfiguration(actual, expected, label = 'runtime build') {
  object(actual, label);
  object(expected, `${label} expectation`);
  exactKeys(actual, Object.keys(expected), label);
  for (const [field, value] of Object.entries(expected)) {
    equal(actual[field], value, `${label}.${field}`);
  }
}

export function assertNativeAddonContract(actual, expected, label = 'native addon') {
  const fields = [
    'addonAbiVersion',
    'binary',
    'build',
    'nodeApiVersion',
    'product',
    'profiles',
    'schema',
  ];
  const actualAddon = object(actual, label);
  const expectedAddon = object(expected, `${label} expectation`);
  exactKeys(actualAddon, fields, label);
  exactKeys(expectedAddon, fields, `${label} expectation`);
  for (const addon of [actualAddon, expectedAddon]) {
    equal(addon.schema, 'oliphaunt-wasix-napi-host-v1', `${label}.schema`);
    equal(addon.product, 'oliphaunt-wasix-napi', `${label}.product`);
    equal(addon.binary, 'oliphaunt_wasix_napi.node', `${label}.binary`);
    positiveInteger(addon.addonAbiVersion, `${label}.addonAbiVersion`, 1);
    positiveInteger(addon.nodeApiVersion, `${label}.nodeApiVersion`, 8);
    exactStringList(addon.profiles, ['standard', 'icu'], `${label}.profiles`);
    const build = object(addon.build, `${label}.build`);
    exactKeys(
      build,
      ['cargoProfile', 'codegenUnits', 'features', 'incremental', 'lto', 'strip'],
      `${label}.build`,
    );
    equal(build.cargoProfile, 'release', `${label}.build.cargoProfile`);
    equal(build.incremental, false, `${label}.build.incremental`);
    equal(build.codegenUnits, 1, `${label}.build.codegenUnits`);
    equal(build.lto, 'thin', `${label}.build.lto`);
    equal(build.strip, 'symbols', `${label}.build.strip`);
    exactStringList(build.features, ['release'], `${label}.build.features`);
  }
  for (const field of ['schema', 'product', 'binary', 'addonAbiVersion', 'nodeApiVersion']) {
    equal(actualAddon[field], expectedAddon[field], `${label}.${field}`);
  }
  exactStringList(actualAddon.profiles, expectedAddon.profiles, `${label}.profiles`);
  for (const field of ['cargoProfile', 'incremental', 'codegenUnits', 'lto', 'strip']) {
    equal(actualAddon.build[field], expectedAddon.build[field], `${label}.build.${field}`);
  }
  exactStringList(
    actualAddon.build.features,
    expectedAddon.build.features,
    `${label}.build.features`,
  );
  return actualAddon;
}

export function assertNativeArtifactProvenance(carrier, expectedAddon, expectedArtifactSourceSha) {
  assertNativeAddonContract(expectedAddon, expectedAddon, 'benchmark native addon contract');
  if (!LOWER_GIT_SHA.test(expectedArtifactSourceSha ?? '')) {
    fail('benchmark artifact source must be a full lowercase Git commit');
  }
  if (carrier === undefined) fail('packed candidate has no native carrier');
  const provenance = carrier.artifactProvenance;
  const manifest = carrier.manifest;
  const buildInputs = provenance?.buildInputs;
  if (
    provenance?.schema !== 'oliphaunt-wasix-napi-provenance-v1' ||
    provenance.product !== expectedAddon.product ||
    provenance.target !== carrier.target ||
    provenance.artifactSourceSha !== expectedArtifactSourceSha ||
    provenance.binary?.filename !== expectedAddon.binary ||
    !/^[0-9a-f]{64}$/u.test(provenance.binary?.sha256 ?? '') ||
    buildInputs?.schema !== 'oliphaunt-wasix-napi-build-inputs-v1' ||
    buildInputs.target !== carrier.target ||
    manifest?.oliphaunt?.target !== carrier.target ||
    manifest.oliphaunt.addonAbiVersion !== expectedAddon.addonAbiVersion ||
    manifest.oliphaunt.nodeApiVersion !== expectedAddon.nodeApiVersion ||
    stableJson(manifest.oliphaunt.profiles) !== stableJson(expectedAddon.profiles)
  ) {
    fail('packed candidate native carrier differs from the benchmark addon/source contract');
  }
  const build = provenance.build;
  const { targetTriple, ...portableBuild } = build ?? {};
  if (
    typeof targetTriple !== 'string' ||
    targetTriple.length === 0 ||
    stableJson(portableBuild) !== stableJson(expectedAddon.build) ||
    targetTriple !== buildInputs.targetTriple
  ) {
    fail('packed candidate native carrier has incompatible optimized build provenance');
  }
  return {
    carrier: carrier.name,
    version: carrier.version,
    target: carrier.target,
    artifactProvenanceMember: carrier.artifactProvenanceMember,
    artifactProvenance: provenance,
  };
}

export function metricIds(plan) {
  return [
    'cold-to-first-result',
    ...plan.warmRtt.map((entry) => `warm-rtt/${entry.id}/p50`),
    ...plan.bulk.map((entry) => `bulk/${entry.id}/elapsed`),
  ];
}

export function bulkSql(entry) {
  switch (entry.operation.kind) {
    case 'create-and-insert-series':
      return `CREATE TABLE bench_bulk (id integer PRIMARY KEY, payload text NOT NULL, revision integer NOT NULL DEFAULT 0); INSERT INTO bench_bulk (id, payload) SELECT i, md5(i::text) FROM generate_series(1, ${entry.operation.rows}) AS i;`;
    case 'create-payload-index':
      return 'CREATE INDEX bench_bulk_payload_idx ON bench_bulk(payload);';
    case 'reverse-indexed-prefix':
      return `UPDATE bench_bulk SET payload = reverse(payload), revision = revision + 1 WHERE id <= ${entry.operation.rows};`;
    case 'aggregate-query':
      return 'SELECT count(*)::bigint AS rows, sum(id)::bigint AS sum_id, sum(octet_length(payload))::bigint AS total_bytes FROM bench_bulk';
    default:
      throw new Error(`unsupported bulk operation ${JSON.stringify(entry.operation.kind)}`);
  }
}

export function simpleQueryMessage(sql) {
  if (typeof sql !== 'string' || sql.includes('\0')) {
    throw new Error('simple query SQL must be a string without NUL bytes');
  }
  const body = UTF8_ENCODER.encode(sql);
  const packet = new Uint8Array(body.length + 6);
  packet[0] = 0x51;
  writeI32(packet, 1, body.length + 5);
  packet.set(body, 5);
  return packet;
}

export function assertSuccessfulRawProtocolResponse(bytes, label) {
  decodeRawProtocolOutcome(bytes, label);
}

export function assertExpectedRawProtocolResponse(bytes, expected, label) {
  const actual = decodeRawProtocolOutcome(bytes, label);
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      `${label} returned protocol outcome ${stableJson(actual)}, expected ${stableJson(expected)}`,
    );
  }
  return actual;
}

export function expectedBulkProtocol(entry) {
  switch (entry.operation.kind) {
    case 'create-and-insert-series':
      return {
        commandTags: ['CREATE TABLE', `INSERT 0 ${entry.operation.rows}`],
        results: [],
        transactionStatus: 'idle',
      };
    case 'create-payload-index':
      return { commandTags: ['CREATE INDEX'], results: [], transactionStatus: 'idle' };
    case 'reverse-indexed-prefix':
      return {
        commandTags: [`UPDATE ${entry.operation.rows}`],
        results: [],
        transactionStatus: 'idle',
      };
    case 'aggregate-query':
      return {
        commandTags: ['SELECT 1'],
        results: [entry.expectedResult],
        transactionStatus: 'idle',
      };
    default:
      throw new Error(`unsupported bulk operation ${JSON.stringify(entry.operation.kind)}`);
  }
}

export function decodeRawProtocolOutcome(bytes, label) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} must return raw PostgreSQL protocol bytes`);
  }
  let offset = 0;
  let sawReady = false;
  let transactionStatus;
  let fields;
  let rows = [];
  const commandTags = [];
  const results = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) {
      throw new Error(`${label} returned a truncated PostgreSQL protocol frame`);
    }
    const tag = bytes[offset];
    const length = readI32(bytes, offset + 1);
    const end = offset + 1 + length;
    if (length < 4 || end > bytes.length) {
      throw new Error(`${label} returned an invalid PostgreSQL protocol frame length ${length}`);
    }
    const body = bytes.subarray(offset + 5, end);
    if (tag === 0x45) throw rawProtocolError(body, label);
    if (tag === 0x54) {
      if (fields !== undefined) throw new Error(`${label} returned nested RowDescription frames`);
      fields = parseRawRowDescription(body, label);
      rows = [];
    } else if (tag === 0x44) {
      if (fields === undefined) throw new Error(`${label} returned DataRow before RowDescription`);
      rows.push(parseRawDataRow(body, fields.length, label));
    } else if (tag === 0x43) {
      commandTags.push(parseRawCommandTag(body, label));
      if (fields !== undefined) {
        results.push(canonicalResult(fields, rows));
        fields = undefined;
        rows = [];
      }
    } else if (tag === 0x5a) {
      if (length !== 5 || ![0x45, 0x49, 0x54].includes(bytes[offset + 5]) || fields !== undefined) {
        throw new Error(`${label} returned an invalid ReadyForQuery frame`);
      }
      sawReady = true;
      transactionStatus = { 69: 'failed', 73: 'idle', 84: 'transaction' }[bytes[offset + 5]];
      if (end !== bytes.length) throw new Error(`${label} returned bytes after ReadyForQuery`);
    } else if (tag === 0x53) {
      validateRawParameterStatus(body, label);
    } else if (tag === 0x4e) {
      validateRawFieldResponse(body, 'NoticeResponse', label);
    } else {
      throw new Error(`${label} returned unexpected PostgreSQL protocol tag 0x${tag.toString(16)}`);
    }
    offset = end;
  }
  if (!sawReady) throw new Error(`${label} ended before ReadyForQuery`);
  return { commandTags, results, transactionStatus };
}

export function postgresSettingsParity(reports, expectedNames, expectedSettings) {
  const expectedKeys = [...expectedNames].sort();
  const observations = reports.map((report) => {
    const source = report?.postgres?.settings;
    const validRecord = source !== null && !Array.isArray(source) && typeof source === 'object';
    const keys = validRecord ? Object.keys(source).sort() : [];
    const valid =
      validRecord &&
      stableJson(keys) === stableJson(expectedKeys) &&
      expectedNames.every((name) => typeof source[name] === 'string');
    const settings = valid
      ? Object.fromEntries(expectedNames.map((name) => [name, source[name]]))
      : null;
    return {
      engine: report?.engine?.kind ?? null,
      repeat: report?.repeat ?? null,
      settings,
      contract: settings === null ? null : stableJson(settings),
    };
  });
  const contracts = new Set(observations.map(({ contract }) => contract));
  const parityPassed = observations.length > 0 && !contracts.has(null) && contracts.size === 1;
  const sharedSettings = parityPassed ? observations[0]?.settings : null;
  const expectedPassed =
    expectedSettings === undefined || stableJson(sharedSettings) === stableJson(expectedSettings);
  const passed = parityPassed && expectedPassed;
  return {
    passed,
    parityPassed,
    expectedPassed,
    expectedNames: [...expectedNames],
    expectedSettings: expectedSettings ?? null,
    sharedSettings,
    mismatches: passed
      ? []
      : observations.map(({ engine, repeat, settings }) => ({ engine, repeat, settings })),
  };
}

export function pairedRatioSummary(candidateSamples, comparisonSamples) {
  if (
    !Array.isArray(candidateSamples) ||
    !Array.isArray(comparisonSamples) ||
    candidateSamples.length === 0 ||
    candidateSamples.length !== comparisonSamples.length
  ) {
    throw new Error('paired ratio summary requires equally sized non-empty sample arrays');
  }
  const pairedRatios = candidateSamples.map((candidate, index) => {
    const comparison = comparisonSamples[index];
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate <= 0 ||
      typeof comparison !== 'number' ||
      !Number.isFinite(comparison) ||
      comparison <= 0
    ) {
      throw new Error('paired ratio samples must be positive finite numbers');
    }
    return candidate / comparison;
  });
  return { pairedRatios, medianRatio: median(pairedRatios) };
}

export function canonicalResult(fields, rows) {
  if (!Array.isArray(fields) || !Array.isArray(rows)) {
    fail('database result must contain field and row arrays');
  }
  return {
    fields: fields.map((field, index) => nonEmptyString(field, `result.fields[${index}]`)),
    rows: rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== fields.length) {
        fail(`result.rows[${rowIndex}] must contain exactly ${fields.length} values`);
      }
      return row.map((value) => (value === null ? null : String(value)));
    }),
  };
}

export function expandExpectedResult(result, replacements = {}) {
  return {
    fields: [...result.fields],
    rows: result.rows.map((row) =>
      row.map((value) =>
        typeof value === 'string' && Object.hasOwn(replacements, value)
          ? String(replacements[value])
          : value,
      ),
    ),
  };
}

export function assertExpectedResult(actual, expected, label) {
  const left = stableJson(actual);
  const right = stableJson(expected);
  if (left !== right) {
    throw new Error(`${label} returned ${left}, expected ${right}`);
  }
  return sha256(right);
}

export function latencySummary(samples, trimFraction) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('latency summary requires samples');
  }
  if (
    samples.some((sample) => typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0)
  ) {
    throw new Error('latency samples must be positive finite numbers');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const trim = Math.floor(sorted.length * trimFraction);
  const trimmed = sorted.slice(trim, sorted.length - trim);
  return {
    samples: sorted.length,
    trimmedSamples: trimmed.length,
    minMs: sorted[0],
    p50Ms: nearestRank(sorted, 0.5),
    p90Ms: nearestRank(sorted, 0.9),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
    maxMs: sorted.at(-1),
    trimmedMeanMs: trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length,
  };
}

export function median(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error('median requires finite numeric values');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

export function geomean(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error('geomean requires positive finite numeric values');
  }
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

export function comfortableWinGate(ratios, maxGeomeanRatio, correctnessPassed) {
  if (
    typeof maxGeomeanRatio !== 'number' ||
    !Number.isFinite(maxGeomeanRatio) ||
    maxGeomeanRatio <= 0
  ) {
    throw new Error('comfortable-win gate requires a positive finite maximum ratio');
  }
  const geomeanRatio = geomean(ratios);
  return {
    geomeanRatio,
    gate: {
      passed: correctnessPassed && geomeanRatio <= maxGeomeanRatio,
      correctnessPassed,
      maxGeomeanRatio,
      requiredMinimumWinPercent: (1 - maxGeomeanRatio) * 100,
      observedWinPercent: (1 - geomeanRatio) * 100,
    },
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function findPackageManifest(entry, expectedName) {
  let directory = dirname(resolve(entry));
  for (;;) {
    const file = resolve(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (manifest.name === expectedName) return { file, manifest };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not locate ${expectedName} package.json from ${entry}`);
}

function validateWarmCases(value) {
  nonEmptyArray(value, 'plan.warmRtt');
  const ids = new Set();
  for (const [index, entryValue] of value.entries()) {
    const label = `plan.warmRtt[${index}]`;
    const entry = object(entryValue, label);
    exactKeys(entry, ['expectation', 'id', 'parameters', 'sql'], label);
    safeId(entry.id, `${label}.id`);
    if (ids.has(entry.id)) fail(`${label}.id must be unique`);
    ids.add(entry.id);
    nonEmptyString(entry.sql, `${label}.sql`);
    if (!Array.isArray(entry.parameters)) fail(`${label}.parameters must be an array`);
    for (const [parameterIndex, parameter] of entry.parameters.entries()) {
      if (!['boolean', 'number', 'string'].includes(typeof parameter) && parameter !== null) {
        fail(`${label}.parameters[${parameterIndex}] must be a JSON scalar`);
      }
    }
    const expectation = object(entry.expectation, `${label}.expectation`);
    if (expectation.kind === 'exact') {
      exactKeys(expectation, ['kind', 'result'], `${label}.expectation`);
      validateExpectedResult(expectation.result, `${label}.expectation.result`);
    } else if (expectation.kind === 'one-based-counter') {
      exactKeys(expectation, ['field', 'kind'], `${label}.expectation`);
      nonEmptyString(expectation.field, `${label}.expectation.field`);
    } else {
      fail(`${label}.expectation.kind is unsupported`);
    }
  }
}

function validateBulk(value) {
  nonEmptyArray(value, 'plan.bulk');
  const ids = new Set();
  let sourceRows;
  for (const [index, entryValue] of value.entries()) {
    const label = `plan.bulk[${index}]`;
    const entry = object(entryValue, label);
    const expectedKeys =
      entry.operation?.kind === 'aggregate-query'
        ? ['expectedResult', 'id', 'operation']
        : ['expectedResult', 'id', 'operation', 'validationSql'];
    exactKeys(entry, expectedKeys, label);
    safeId(entry.id, `${label}.id`);
    if (ids.has(entry.id)) fail(`${label}.id must be unique`);
    ids.add(entry.id);
    const operation = object(entry.operation, `${label}.operation`);
    if (!BULK_OPERATIONS.has(operation.kind)) fail(`${label}.operation.kind is unsupported`);
    if (operation.kind === 'create-and-insert-series') {
      exactKeys(operation, ['kind', 'rows'], `${label}.operation`);
      positiveInteger(operation.rows, `${label}.operation.rows`, 1000);
      sourceRows = operation.rows;
    } else if (operation.kind === 'reverse-indexed-prefix') {
      exactKeys(operation, ['kind', 'rows'], `${label}.operation`);
      positiveInteger(operation.rows, `${label}.operation.rows`, 1);
      if (sourceRows === undefined || operation.rows > sourceRows) {
        fail(`${label}.operation.rows must not exceed the preceding inserted row count`);
      }
    } else {
      exactKeys(operation, ['kind'], `${label}.operation`);
    }
    if (entry.validationSql !== undefined) {
      nonEmptyString(entry.validationSql, `${label}.validationSql`);
    }
    validateExpectedResult(entry.expectedResult, `${label}.expectedResult`);
    nonEmptyString(bulkSql(entry), `${label} generated SQL`);
  }
  if (sourceRows === undefined) fail('plan.bulk must create its deterministic source table');
}

function validateQuery(value, label, { allowPlaceholder = false } = {}) {
  const query = object(value, label);
  exactKeys(query, ['expectedResult', 'sql'], label);
  nonEmptyString(query.sql, `${label}.sql`);
  validateExpectedResult(query.expectedResult, `${label}.expectedResult`, { allowPlaceholder });
}

function validateExpectedResult(value, label, { allowPlaceholder = false } = {}) {
  const result = object(value, label);
  exactKeys(result, ['fields', 'rows'], label);
  nonEmptyArray(result.fields, `${label}.fields`);
  for (const [index, field] of result.fields.entries()) {
    nonEmptyString(field, `${label}.fields[${index}]`);
  }
  if (!Array.isArray(result.rows)) fail(`${label}.rows must be an array`);
  for (const [rowIndex, row] of result.rows.entries()) {
    if (!Array.isArray(row) || row.length !== result.fields.length) {
      fail(`${label}.rows[${rowIndex}] must contain exactly ${result.fields.length} values`);
    }
    for (const [columnIndex, column] of row.entries()) {
      if (column !== null && typeof column !== 'string') {
        fail(`${label}.rows[${rowIndex}][${columnIndex}] must be a string or null`);
      }
      if (typeof column === 'string' && column.startsWith('$') && !allowPlaceholder) {
        fail(`${label}.rows[${rowIndex}][${columnIndex}] must not contain a placeholder`);
      }
    }
  }
}

function writeI32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readI32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readI16(bytes, offset) {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readSignedI32(bytes, offset) {
  const value = readI32(bytes, offset);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function parseRawRowDescription(body, label) {
  if (body.length < 2) throw new Error(`${label} returned a truncated RowDescription`);
  const count = readI16(body, 0);
  const fields = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    const field = readRawCString(body, offset, `${label} RowDescription field ${index}`);
    fields.push(field.value);
    offset = field.next;
    if (offset + 18 > body.length) {
      throw new Error(`${label} returned a truncated RowDescription field`);
    }
    const format = readI16(body, offset + 16);
    if (format !== 0) throw new Error(`${label} returned a non-text RowDescription field`);
    offset += 18;
  }
  if (offset !== body.length) throw new Error(`${label} returned trailing RowDescription bytes`);
  return fields;
}

function parseRawDataRow(body, expectedColumns, label) {
  if (body.length < 2) throw new Error(`${label} returned a truncated DataRow`);
  const count = readI16(body, 0);
  if (count !== expectedColumns) {
    throw new Error(`${label} returned ${count} DataRow columns, expected ${expectedColumns}`);
  }
  const row = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > body.length) throw new Error(`${label} returned a truncated DataRow length`);
    const length = readSignedI32(body, offset);
    offset += 4;
    if (length === -1) {
      row.push(null);
      continue;
    }
    if (length < 0 || offset + length > body.length) {
      throw new Error(`${label} returned an invalid DataRow value length ${length}`);
    }
    row.push(decodeRawText(body.subarray(offset, offset + length), `${label} DataRow value`));
    offset += length;
  }
  if (offset !== body.length) throw new Error(`${label} returned trailing DataRow bytes`);
  return row;
}

function parseRawCommandTag(body, label) {
  const command = readRawCString(body, 0, `${label} CommandComplete`);
  if (command.next !== body.length) {
    throw new Error(`${label} returned trailing CommandComplete bytes`);
  }
  return command.value;
}

function validateRawParameterStatus(body, label) {
  const name = readRawCString(body, 0, `${label} ParameterStatus name`);
  if (name.value.length === 0) throw new Error(`${label} returned an empty ParameterStatus name`);
  const value = readRawCString(body, name.next, `${label} ParameterStatus value`);
  if (value.next !== body.length) {
    throw new Error(`${label} returned trailing ParameterStatus bytes`);
  }
}

function validateRawFieldResponse(body, kind, label) {
  let offset = 0;
  for (;;) {
    if (offset >= body.length) throw new Error(`${label} returned unterminated ${kind}`);
    const code = body[offset];
    offset += 1;
    if (code === 0) {
      if (offset !== body.length) throw new Error(`${label} returned trailing ${kind} bytes`);
      return;
    }
    const field = readRawCString(body, offset, `${label} ${kind} field 0x${code.toString(16)}`);
    offset = field.next;
  }
}

function readRawCString(bytes, offset, label) {
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new Error(`${label} is missing its NUL terminator`);
  return { value: decodeRawText(bytes.subarray(offset, end), label), next: end + 1 };
}

function decodeRawText(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${describeError(error)}`);
  }
}

function rawProtocolError(body, label) {
  let offset = 0;
  let message = 'PostgreSQL ErrorResponse';
  let sqlstate;
  while (offset < body.length) {
    const code = body[offset];
    offset += 1;
    if (code === 0) break;
    const end = body.indexOf(0, offset);
    if (end < 0) return new Error(`${label} returned a malformed PostgreSQL ErrorResponse`);
    const value = UTF8_DECODER.decode(body.subarray(offset, end));
    if (code === 0x43) sqlstate = value;
    if (code === 0x4d) message = value;
    offset = end + 1;
  }
  return new Error(
    `${label} returned PostgreSQL error${sqlstate === undefined ? '' : ` ${sqlstate}`}: ${message}`,
  );
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (stableJson(actual) !== stableJson(expected)) {
    fail(`${label} fields are ${stableJson(actual)}, expected ${stableJson(expected)}`);
  }
}

function exactStringList(value, expected, label) {
  if (!Array.isArray(value) || stableJson(value) !== stableJson(expected)) {
    fail(`${label} must be ${stableJson(expected)}`);
  }
}

function nonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function positiveInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value))
    fail(`${label} must be a safe kebab-case id`);
}

function equal(actual, expected, label) {
  if (actual !== expected)
    fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function fail(message) {
  throw new Error(`wasix-node benchmark plan: ${message}`);
}

function relative(file) {
  const value = relativePath(repositoryRoot, resolve(file));
  return value === '' || value.startsWith('..') || isAbsolute(value)
    ? resolve(file)
    : value.split('\\').join('/');
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
