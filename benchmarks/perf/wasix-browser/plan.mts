import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  comfortableWinGate,
  median,
  pairedRatioSummary,
  sha256,
  validateComparisonIdentity,
} from '../wasix-node/plan.mts';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const defaultBrowserPlanFile = resolve(
  repositoryRoot,
  'benchmarks/wasix/browser-pglite-memory-v2.json',
);

const PLAN_SCHEMA = 'oliphaunt-wasix-browser-benchmark-plan-v2';
const RESULT_SCHEMA = 'oliphaunt-wasix-browser-engine-result-v2';
const PLAN_ID = 'browser-pglite-memory-v2';
const CANDIDATE_PACKAGE = '@oliphaunt/wasix-ts';
const ENGINE_NAMES = ['wasixDirect', 'wasixWorker', 'pgliteDirect', 'pgliteWorker'];
const PROFILE_FIELDS = [
  'startupRuns',
  'workloadRuns',
  'insertDiagnosticRuns',
  'pointSamples',
  'rangeSamples',
  'aggregateSamples',
  'transactionInserts',
  'qualificationEligible',
];
const MEASUREMENT = {
  rows: 10_000,
  storage: 'ephemeral-memory',
  order: 'rotating-engines-with-same-run-pairing',
  warmup: 'one-untimed-representative-workload-per-fresh-database',
  timingBoundary: 'browser-caller-end-to-end-around-public-api',
  pairing: 'same-run-oliphaunt-over-pglite',
  percentileMethod: 'nearest-rank',
};
const GATE_METRICS = [
  'startup.warmReadyMs',
  'workload.createTableMs',
  'workload.insert10kMs',
  'workload.pointMedianMs',
  'workload.pointP95Ms',
  'workload.range100MedianMs',
  'workload.range100P95Ms',
  'workload.aggregateMedianMs',
  'workload.aggregateP95Ms',
  'workload.scanAndDecode10kMs',
  'workload.transactionInsertBatchMs',
  'workload.update1kMs',
  'workload.delete1kMs',
];
const SURFACE_COMPARISONS = {
  direct: ['wasixDirect', 'pgliteDirect'],
  worker: ['wasixWorker', 'pgliteWorker'],
};
const CANDIDATE_EXECUTION_SURFACES = {
  direct: {
    entrypoint: '@oliphaunt/wasix-ts',
    callingContract: 'async',
    executionOwner: 'caller',
  },
  worker: {
    entrypoint: '@oliphaunt/wasix-ts/worker',
    callingContract: 'async',
    executionOwner: 'sdk-worker',
  },
};

export async function loadBrowserPlan(file = defaultBrowserPlanFile) {
  const bytes = await readFile(file);
  let plan;
  try {
    plan = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, file)} must contain JSON`, { cause: error });
  }
  validateBrowserPlan(plan);
  return { plan, file: resolve(file), sha256: sha256(bytes), size: bytes.length };
}

export function validateBrowserPlan(plan) {
  requireRecord(plan, 'plan');
  requireEqual(plan.schema, PLAN_SCHEMA, 'plan.schema');
  validatePlanEnvelope(plan);

  const engines = requireRecord(plan.engines, 'plan.engines');
  requireExactKeys(engines, ['candidate', 'comparison'], 'plan.engines');
  const candidate = requireRecord(engines.candidate, 'plan.engines.candidate');
  const comparison = requireRecord(engines.comparison, 'plan.engines.comparison');
  requireExactKeys(
    candidate,
    ['package', 'storage', 'surfaces', 'dependencies', 'runtimeBuild'],
    'plan.engines.candidate',
  );
  requireEqual(candidate.package, CANDIDATE_PACKAGE, 'plan.engines.candidate.package');
  requireEqual(candidate.storage, 'memory', 'plan.engines.candidate.storage');
  requireExactRecord(
    requireRecord(candidate.surfaces, 'plan.engines.candidate.surfaces').direct,
    {
      engine: 'wasixDirect',
      ...CANDIDATE_EXECUTION_SURFACES.direct,
    },
    'plan.engines.candidate.surfaces.direct',
  );
  requireExactRecord(
    candidate.surfaces.worker,
    {
      engine: 'wasixWorker',
      ...CANDIDATE_EXECUTION_SURFACES.worker,
    },
    'plan.engines.candidate.surfaces.worker',
  );
  requireExactKeys(candidate.surfaces, ['direct', 'worker'], 'plan.engines.candidate.surfaces');
  requireExactRecord(
    candidate.dependencies,
    { fzstd: '0.1.1' },
    'plan.engines.candidate.dependencies',
  );
  requireRecord(candidate.runtimeBuild, 'plan.engines.candidate.runtimeBuild');

  validateComparisonIdentity(comparison);
  const comparisonSurfaces = requireRecord(comparison.surfaces, 'plan.engines.comparison.surfaces');
  requireExactKeys(
    comparisonSurfaces,
    ['callerRealm', 'worker'],
    'plan.engines.comparison.surfaces',
  );
  requireExactRecord(
    comparisonSurfaces.callerRealm,
    {
      engine: 'pgliteDirect',
      entrypoint: '@electric-sql/pglite',
      callingContract: 'async',
      executionOwner: 'caller',
    },
    'plan.engines.comparison.surfaces.callerRealm',
  );
  requireExactRecord(
    comparisonSurfaces.worker,
    {
      engine: 'pgliteWorker',
      entrypoint: '@electric-sql/pglite/worker',
      callingContract: 'async',
      executionOwner: 'caller-provided-worker',
    },
    'plan.engines.comparison.surfaces.worker',
  );

  validateCommonPlan(plan);
}

function validatePlanEnvelope(plan) {
  requireExactKeys(
    plan,
    ['schema', 'id', 'description', 'engines', 'profiles', 'measurement', 'gate', 'postgres'],
    'plan',
  );
  requireEqual(plan.id, PLAN_ID, 'plan.id');
  requireNonEmptyString(plan.description, 'plan.description');
}

function validateCommonPlan(plan) {
  const profiles = requireRecord(plan.profiles, 'plan.profiles');
  requireExactKeys(profiles, ['quick', 'full'], 'plan.profiles');
  for (const name of ['quick', 'full']) {
    const profile = requireRecord(profiles[name], `plan.profiles.${name}`);
    requireExactKeys(profile, PROFILE_FIELDS, `plan.profiles.${name}`);
    for (const field of PROFILE_FIELDS.filter((field) => field !== 'qualificationEligible')) {
      requirePositiveInteger(profile[field], `plan.profiles.${name}.${field}`);
    }
    if (profile.startupRuns < 2) throw new Error('startupRuns must include cold and warm samples');
    requireEqual(
      profile.qualificationEligible,
      name === 'full',
      `plan.profiles.${name}.qualificationEligible`,
    );
  }
  const full = profiles.full;
  if (
    full.workloadRuns < ENGINE_NAMES.length * 2 ||
    full.workloadRuns % ENGINE_NAMES.length !== 0
  ) {
    throw new Error('plan.profiles.full.workloadRuns must be a multiple of 4 and at least 8');
  }

  requireExactRecord(plan.measurement, MEASUREMENT, 'plan.measurement');
  const gate = requireRecord(plan.gate, 'plan.gate');
  requireExactKeys(
    gate,
    [
      'maxGeomeanRatio',
      'requiresCorrectness',
      'requiresBothExecutionSurfaces',
      'metric',
      'metrics',
      'excluded',
    ],
    'plan.gate',
  );
  requireEqual(gate.maxGeomeanRatio, 0.8, 'plan.gate.maxGeomeanRatio');
  requireEqual(gate.requiresCorrectness, true, 'plan.gate.requiresCorrectness');
  requireEqual(gate.requiresBothExecutionSurfaces, true, 'plan.gate.requiresBothExecutionSurfaces');
  requireEqual(
    gate.metric,
    'geometric-mean-of-median-paired-oliphaunt-over-pglite-ratios-lower-is-better',
    'plan.gate.metric',
  );
  requireExactStringList(gate.metrics, GATE_METRICS, 'plan.gate.metrics');
  for (const metric of gate.metrics) validateMetricId(metric);

  const postgres = requireRecord(plan.postgres, 'plan.postgres');
  requireExactKeys(
    postgres,
    ['major', 'settings', 'indexedInsertWalTolerancePercent'],
    'plan.postgres',
  );
  requireEqual(postgres.major, 18, 'plan.postgres.major');
  requireExactKeys(
    requireRecord(postgres.settings, 'plan.postgres.settings'),
    ['fsync', 'synchronousCommit', 'fullPageWrites', 'walLevel'],
    'plan.postgres.settings',
  );
  requireEqual(
    postgres.indexedInsertWalTolerancePercent,
    0.1,
    'plan.postgres.indexedInsertWalTolerancePercent',
  );
}

export function qualifyingGitProvenance({ commit, tree, status }) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('browser benchmark qualification requires an exact Git commit');
  }
  if (!/^[0-9a-f]{40}$/u.test(tree)) {
    throw new Error('browser benchmark qualification requires an exact Git tree');
  }
  if (typeof status !== 'string') {
    throw new Error('browser benchmark qualification requires Git porcelain status text');
  }
  if (status !== '') {
    throw new Error('browser benchmark qualification requires a clean Git worktree');
  }
  return { commit, tree, dirty: false };
}

export function summarizeBrowserResult(planSource, result) {
  const plan = planSource.plan;
  validateBrowserResult(plan, result);
  const correctness = summarizeCorrectness(plan, result);
  const comparisons = Object.fromEntries(
    Object.entries(SURFACE_COMPARISONS).map(([surface, [candidate, comparison]]) => {
      const metrics = plan.gate.metrics.map((id) => {
        const candidateSamplesMs = metricSamples(result, candidate, id);
        const comparisonSamplesMs = metricSamples(result, comparison, id);
        const paired = pairedRatioSummary(candidateSamplesMs, comparisonSamplesMs);
        return {
          id,
          candidateSamplesMs,
          comparisonSamplesMs,
          candidateMedianMs: median(candidateSamplesMs),
          comparisonMedianMs: median(comparisonSamplesMs),
          pairs: paired.pairedRatios.map((ratio, repeat) => ({
            repeat,
            candidateMs: candidateSamplesMs[repeat],
            comparisonMs: comparisonSamplesMs[repeat],
            ratio,
          })),
          pairedRatioMedian: paired.medianRatio,
        };
      });
      const aggregate = comfortableWinGate(
        metrics.map((metric) => metric.pairedRatioMedian),
        plan.gate.maxGeomeanRatio,
        correctness.passed,
      );
      return [surface, { metrics, ...aggregate }];
    }),
  );
  const qualificationEligible = plan.profiles[result.mode].qualificationEligible;
  const performancePassed = Object.values(comparisons).every(
    (comparison) => comparison.gate.passed,
  );
  return {
    correctness,
    comparisons,
    gate: {
      required: qualificationEligible,
      passed: qualificationEligible ? performancePassed && correctness.passed : null,
      maxGeomeanRatio: plan.gate.maxGeomeanRatio,
      requiresBothExecutionSurfaces: true,
      metric: plan.gate.metric,
      excluded: plan.gate.excluded,
    },
    passed: correctness.passed && (!qualificationEligible || performancePassed),
  };
}

export function browserPlanSummary(source) {
  return {
    id: source.plan.id,
    schema: source.plan.schema,
    sha256: source.sha256,
    size: source.size,
    engines: source.plan.engines,
    profiles: source.plan.profiles,
    measurement: source.plan.measurement,
    gate: source.plan.gate,
    postgres: source.plan.postgres,
  };
}

function validateBrowserResult(plan, result) {
  requireRecord(result, 'browser result');
  requireEqual(result.schema, RESULT_SCHEMA, 'result.schema');
  requireEqual(result.plan, plan.id, 'result.plan');
  if (!['quick', 'full'].includes(result.mode)) throw new Error('result.mode is invalid');
  const expected = plan.profiles[result.mode];
  const configuration = requireRecord(result.configuration, 'result.configuration');
  for (const field of [
    'startupRuns',
    'workloadRuns',
    'insertDiagnosticRuns',
    'pointSamples',
    'rangeSamples',
    'aggregateSamples',
    'transactionInserts',
  ]) {
    requireEqual(configuration[field], expected[field], `result.configuration.${field}`);
  }
  requireEqual(configuration.rows, plan.measurement.rows, 'result.configuration.rows');
  requireEqual(configuration.storage, plan.measurement.storage, 'result.configuration.storage');
  requireNestedExactRecord(
    configuration.executionSurfaces,
    CANDIDATE_EXECUTION_SURFACES,
    'result.configuration.executionSurfaces',
  );
  requireEqual(result.correctness?.assertionsPassed, true, 'result correctness');
  requireEqual(result.environment?.crossOriginIsolated, true, 'cross-origin isolation');

  for (const engine of ENGINE_NAMES) {
    requireArrayLength(
      result.samples?.startup?.[engine],
      expected.startupRuns,
      `${engine} startup`,
    );
    requireArrayLength(
      result.samples?.workload?.[engine],
      expected.workloadRuns,
      `${engine} workloads`,
    );
    requireArrayLength(
      result.insertDiagnostic?.samples?.[engine],
      expected.insertDiagnosticRuns,
      `${engine} insert diagnostics`,
    );
  }
}

function summarizeCorrectness(plan, result) {
  const settings = plan.postgres.settings;
  const durability = Object.fromEntries(
    Object.entries(SURFACE_COMPARISONS).map(([surface, [candidate, comparison]]) => {
      const candidateProfile = result.postgresProfiles[candidate];
      const comparisonProfile = result.postgresProfiles[comparison];
      const candidateValid = profileMatches(candidateProfile, settings, plan.postgres.major);
      const comparisonValid = profileMatches(comparisonProfile, settings, plan.postgres.major);
      const parity = Object.keys(settings).every(
        (setting) => candidateProfile?.[setting] === comparisonProfile?.[setting],
      );
      return [
        surface,
        {
          passed: candidateValid && comparisonValid && parity,
          candidateProfile,
          comparisonProfile,
        },
      ];
    }),
  );
  durability.passed = durability.direct.passed && durability.worker.passed;

  const wal = result.insertDiagnostic.summary.indexedInsertWalBytes;
  const indexedInsertWal = Object.fromEntries(
    Object.entries(SURFACE_COMPARISONS).map(([surface, [candidate, comparison]]) => {
      const candidateBytes = positiveNumber(wal[candidate], `${candidate} WAL bytes`);
      const comparisonBytes = positiveNumber(wal[comparison], `${comparison} WAL bytes`);
      const deltaPercent = (Math.abs(candidateBytes - comparisonBytes) / comparisonBytes) * 100;
      return [
        surface,
        {
          passed: deltaPercent <= plan.postgres.indexedInsertWalTolerancePercent,
          candidateBytes,
          comparisonBytes,
          deltaBytes: candidateBytes - comparisonBytes,
          deltaPercent,
          tolerancePercent: plan.postgres.indexedInsertWalTolerancePercent,
        },
      ];
    }),
  );
  indexedInsertWal.passed = indexedInsertWal.direct.passed && indexedInsertWal.worker.passed;
  const workloadAssertionsPassed = result.correctness.assertionsPassed === true;
  return {
    passed: workloadAssertionsPassed && durability.passed && indexedInsertWal.passed,
    workloadAssertionsPassed,
    durability,
    indexedInsertWal,
  };
}

function metricSamples(result, engine, id) {
  if (id === 'startup.warmReadyMs') {
    return result.samples.startup[engine]
      .slice(1)
      .map((value, index) => positiveNumber(value, `${engine} ${id} sample ${index}`));
  }
  const match = /^workload\.([A-Za-z][A-Za-z0-9]*)$/u.exec(id);
  if (match === null) throw new Error(`unsupported browser benchmark metric ${id}`);
  return result.samples.workload[engine].map((run, index) =>
    positiveNumber(run?.metrics?.[match[1]], `${engine} ${id} sample ${index}`),
  );
}

function validateMetricId(id) {
  if (id === 'startup.warmReadyMs') return;
  if (!/^workload\.(?!readyMs$|closeMs$)[A-Za-z][A-Za-z0-9]*$/u.test(id)) {
    throw new Error(`unsupported gated browser benchmark metric ${JSON.stringify(id)}`);
  }
}

function profileMatches(profile, settings, major) {
  return (
    profile !== null &&
    typeof profile === 'object' &&
    new RegExp(`^${major}\\.`).test(profile.version) &&
    Object.entries(settings).every(([name, expected]) => profile[name] === expected)
  );
}

function requireArrayLength(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} must contain exactly ${length} entries`);
  }
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactRecord(value, expected, label) {
  const record = requireRecord(value, label);
  requireExactKeys(record, Object.keys(expected), label);
  for (const [field, expectedValue] of Object.entries(expected)) {
    requireEqual(record[field], expectedValue, `${label}.${field}`);
  }
  return record;
}

function requireNestedExactRecord(value, expected, label) {
  const record = requireRecord(value, label);
  requireExactKeys(record, Object.keys(expected), label);
  for (const [field, expectedValue] of Object.entries(expected)) {
    requireExactRecord(record[field], expectedValue, `${label}.${field}`);
  }
  return record;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} must contain exactly ${JSON.stringify(required)}`);
  }
}

function requireExactStringList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} must contain exactly ${expected.length} entries`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    requireEqual(value[index], expected[index], `${label}[${index}]`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
