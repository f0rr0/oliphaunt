import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  comfortableWinGate,
  median,
  pairedRatioSummary,
  sha256,
} from '../wasix-node/plan.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const defaultBrowserPlanFile = resolve(
  repositoryRoot,
  'benchmarks/wasix/browser-pglite-memory-v1.json',
);

const PLAN_SCHEMA = 'oliphaunt-wasix-browser-benchmark-plan-v1';
const RESULT_SCHEMA = 'oliphaunt-wasix-browser-engine-result-v1';
const CANDIDATE_PACKAGE = '@oliphaunt/wasix-ts';
const COMPARISON_PACKAGE = '@electric-sql/pglite';
const COMPARISON_VERSION = '0.5.4';
const COMPARISON_INTEGRITY =
  'sha512-yYZUyyXrHU7tPlCjwZQJ6hIG9DscdCCn7Uk0mYKwC1FeHX286AbcmFveMiRBEak8e9iPupjsoVImN3yJZVed2g==';
const COMPARISON_COMMIT = '25d0a55e1f1e4c59f26d9e125150dda88a33fd00';
const COMPARISON_TREE_SHA256 =
  'b3925de04c386f51859c1bf18c143b225e3850616718140dd32e8eb48e9a2c84';
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
const QUICK_PROFILE = {
  startupRuns: 2,
  workloadRuns: 1,
  insertDiagnosticRuns: 1,
  pointSamples: 20,
  rangeSamples: 10,
  aggregateSamples: 5,
  transactionInserts: 20,
  qualificationEligible: false,
};
const FULL_PROFILE = {
  startupRuns: 5,
  insertDiagnosticRuns: 5,
  pointSamples: 200,
  rangeSamples: 50,
  aggregateSamples: 30,
  transactionInserts: 100,
  qualificationEligible: true,
};
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
const GATE_EXCLUSIONS = {
  'startup.firstReadyMs':
    'descriptive because the implementations use different compilation caches',
  'workload.readyMs': 'duplicates the independently sampled warm-start metric',
  'workload.closeMs':
    'descriptive because the public close methods make different worker-reclamation guarantees',
  'insertDiagnostic.*Ms':
    'diagnostic decomposition would otherwise overweight the primary insert workload',
  'insertDiagnostic.indexedInsertWalBytes':
    'semantic parity constraint rather than a speed metric',
};
const POSTGRES_SETTINGS = {
  fsync: 'off',
  synchronousCommit: 'on',
  fullPageWrites: 'on',
  walLevel: 'replica',
};
const RUNTIME_BUILD = {
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
};
const TOPOLOGIES = {
  direct: ['wasixDirect', 'pgliteDirect'],
  worker: ['wasixWorker', 'pgliteWorker'],
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
  requireExactKeys(
    plan,
    ['schema', 'id', 'description', 'engines', 'profiles', 'measurement', 'gate', 'postgres'],
    'plan',
  );
  requireEqual(plan.schema, PLAN_SCHEMA, 'plan.schema');
  requireEqual(plan.id, 'browser-pglite-memory-v1', 'plan.id');
  requireNonEmptyString(plan.description, 'plan.description');
  const engines = requireRecord(plan.engines, 'plan.engines');
  requireExactKeys(engines, ['candidate', 'comparison'], 'plan.engines');
  const candidate = requireRecord(engines.candidate, 'plan.engines.candidate');
  const comparison = requireRecord(engines.comparison, 'plan.engines.comparison');
  requireExactKeys(
    candidate,
    ['package', 'storage', 'directBoundary', 'workerBoundary', 'dependencies', 'runtimeBuild'],
    'plan.engines.candidate',
  );
  requireEqual(candidate.package, CANDIDATE_PACKAGE, 'plan.engines.candidate.package');
  requireEqual(candidate.storage, 'memory', 'plan.engines.candidate.storage');
  requireEqual(
    candidate.directBoundary,
    'browser-caller-realm',
    'plan.engines.candidate.directBoundary',
  );
  requireEqual(
    candidate.workerBoundary,
    'package-owned-web-worker',
    'plan.engines.candidate.workerBoundary',
  );
  requireExactRecord(
    candidate.dependencies,
    { fzstd: '0.1.1' },
    'plan.engines.candidate.dependencies',
  );
  requireExactRecord(
    candidate.runtimeBuild,
    RUNTIME_BUILD,
    'plan.engines.candidate.runtimeBuild',
  );
  requireExactRecord(
    comparison,
    {
      package: COMPARISON_PACKAGE,
      version: COMPARISON_VERSION,
      integrity: COMPARISON_INTEGRITY,
      homepage: 'https://pglite.dev',
      sourceRepository: 'https://github.com/electric-sql/pglite',
      sourceCommit: COMPARISON_COMMIT,
      installedTreeHashSchema: 'oliphaunt-path-size-content-sha256-v1',
      installedTreeSha256: COMPARISON_TREE_SHA256,
      storage: 'memory',
      directBoundary: 'browser-caller-realm',
      workerBoundary: 'official-pglite-web-worker',
    },
    'plan.engines.comparison',
  );

  const profiles = requireRecord(plan.profiles, 'plan.profiles');
  requireExactKeys(profiles, ['quick', 'full'], 'plan.profiles');
  requireExactRecord(profiles.quick, QUICK_PROFILE, 'plan.profiles.quick');
  const full = requireRecord(profiles.full, 'plan.profiles.full');
  requireExactKeys(full, PROFILE_FIELDS, 'plan.profiles.full');
  for (const [field, expected] of Object.entries(FULL_PROFILE)) {
    requireEqual(full[field], expected, `plan.profiles.full.${field}`);
  }
  requirePositiveInteger(full.workloadRuns, 'plan.profiles.full.workloadRuns');
  if (full.workloadRuns < ENGINE_NAMES.length * 2 || full.workloadRuns % ENGINE_NAMES.length !== 0) {
    throw new Error('plan.profiles.full.workloadRuns must be a multiple of 4 and at least 8');
  }

  requireExactRecord(plan.measurement, MEASUREMENT, 'plan.measurement');
  const gate = requireRecord(plan.gate, 'plan.gate');
  requireExactKeys(
    gate,
    [
      'maxGeomeanRatio',
      'requiresCorrectness',
      'requiresBothTopologies',
      'metric',
      'metrics',
      'excluded',
    ],
    'plan.gate',
  );
  requireEqual(gate.maxGeomeanRatio, 0.8, 'plan.gate.maxGeomeanRatio');
  requireEqual(gate.requiresCorrectness, true, 'plan.gate.requiresCorrectness');
  requireEqual(gate.requiresBothTopologies, true, 'plan.gate.requiresBothTopologies');
  requireEqual(
    gate.metric,
    'geometric-mean-of-median-paired-oliphaunt-over-pglite-ratios-lower-is-better',
    'plan.gate.metric',
  );
  requireExactStringList(gate.metrics, GATE_METRICS, 'plan.gate.metrics');
  for (const metric of gate.metrics) validateMetricId(metric);
  requireExactRecord(gate.excluded, GATE_EXCLUSIONS, 'plan.gate.excluded');

  const postgres = requireRecord(plan.postgres, 'plan.postgres');
  requireExactKeys(
    postgres,
    ['major', 'settings', 'indexedInsertWalTolerancePercent'],
    'plan.postgres',
  );
  requireEqual(postgres.major, 18, 'plan.postgres.major');
  requireExactRecord(postgres.settings, POSTGRES_SETTINGS, 'plan.postgres.settings');
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
  const topologies = Object.fromEntries(
    Object.entries(TOPOLOGIES).map(([topology, [candidate, comparison]]) => {
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
      return [topology, { metrics, ...aggregate }];
    }),
  );
  const qualificationEligible = plan.profiles[result.mode].qualificationEligible;
  const performancePassed = Object.values(topologies).every((topology) => topology.gate.passed);
  return {
    correctness,
    topologies,
    gate: {
      required: qualificationEligible,
      passed: qualificationEligible ? performancePassed && correctness.passed : null,
      maxGeomeanRatio: plan.gate.maxGeomeanRatio,
      requiresBothTopologies: true,
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

export function browserMarkdownReport(report) {
  const topologySections = Object.entries(report.summary.topologies)
    .map(([name, topology]) => {
      const rows = topology.metrics
        .map(
          (metric) =>
            `| \`${metric.id}\` | ${metric.candidateMedianMs.toFixed(3)} | ` +
            `${metric.comparisonMedianMs.toFixed(3)} | ${metric.pairedRatioMedian.toFixed(3)} |`,
        )
        .join('\n');
      const gateLabel = report.summary.gate.required
        ? `Comfortable-win gate: **${topology.gate.passed ? 'PASS' : 'FAIL'}**`
        : `Comfortable-win statistic: **${topology.gate.passed ? 'would pass' : 'would fail'} (advisory quick profile)**`;
      return `## ${name[0].toUpperCase()}${name.slice(1)} topology

- ${gateLabel}
- Geometric-mean ratio: **${topology.geomeanRatio.toFixed(4)}** (required <= ${topology.gate.maxGeomeanRatio.toFixed(2)})
- Observed aggregate win: **${topology.gate.observedWinPercent.toFixed(2)}%**

| Metric (lower is better) | Oliphaunt median ms | PGlite median ms | Median paired ratio |
| --- | ---: | ---: | ---: |
${rows}`;
    })
    .join('\n\n');
  return `# WASIX browser benchmark report

- Plan: \`${report.plan.id}\` (\`${report.plan.sha256}\`)
- Candidate: \`${report.plan.engines.candidate.package}\`
- Comparison: \`${report.plan.engines.comparison.package}@${report.plan.engines.comparison.version}\`
- Browser: \`${report.result.environment.userAgent}\`
- Cross-origin isolated: **${report.result.environment.crossOriginIsolated ? 'yes' : 'no'}**
- Workload assertions: **${report.summary.correctness.workloadAssertionsPassed ? 'PASS' : 'FAIL'}**
- PostgreSQL durability parity: **${report.summary.correctness.durability.passed ? 'PASS' : 'FAIL'}**
- Indexed-insert WAL parity: **${report.summary.correctness.indexedInsertWal.passed ? 'PASS' : 'FAIL'}**
- Overall qualification: **${report.summary.gate.required ? (report.summary.gate.passed ? 'PASS' : 'FAIL') : 'NOT GATED (quick profile)'}**

${topologySections}

First cold open, duplicated workload-open time, close, and insert decomposition remain in the JSON report but are not speed-gated. Close is descriptive because the public APIs make different worker-reclamation guarantees. The gate requires the geometric mean of median same-run Oliphaunt/PGlite ratios to be at most 0.80 independently in both matched topologies, after workload assertions and PostgreSQL durability/WAL parity pass.
`;
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
  requireEqual(result.correctness?.assertionsPassed, true, 'result correctness');
  requireEqual(result.environment?.crossOriginIsolated, true, 'cross-origin isolation');

  for (const engine of ENGINE_NAMES) {
    requireArrayLength(result.samples?.startup?.[engine], expected.startupRuns, `${engine} startup`);
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
    Object.entries(TOPOLOGIES).map(([topology, [candidate, comparison]]) => {
      const candidateProfile = result.postgresProfiles[candidate];
      const comparisonProfile = result.postgresProfiles[comparison];
      const candidateValid = profileMatches(candidateProfile, settings, plan.postgres.major);
      const comparisonValid = profileMatches(comparisonProfile, settings, plan.postgres.major);
      const parity = Object.keys(settings).every(
        (setting) => candidateProfile?.[setting] === comparisonProfile?.[setting],
      );
      return [
        topology,
        { passed: candidateValid && comparisonValid && parity, candidateProfile, comparisonProfile },
      ];
    }),
  );
  durability.passed = durability.direct.passed && durability.worker.passed;

  const wal = result.insertDiagnostic.summary.indexedInsertWalBytes;
  const indexedInsertWal = Object.fromEntries(
    Object.entries(TOPOLOGIES).map(([topology, [candidate, comparison]]) => {
      const candidateBytes = positiveNumber(wal[candidate], `${candidate} WAL bytes`);
      const comparisonBytes = positiveNumber(wal[comparison], `${comparison} WAL bytes`);
      const deltaPercent = (Math.abs(candidateBytes - comparisonBytes) / comparisonBytes) * 100;
      return [
        topology,
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
    return result.samples.startup[engine].slice(1).map((value, index) =>
      positiveNumber(value, `${engine} ${id} sample ${index}`),
    );
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
    throw new Error(`${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
