import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assertCurrentBrowserPlan,
  browserMarkdownReport,
  browserPlanSummary,
  loadBrowserPlan,
  qualifyingGitProvenance,
  repositoryRoot,
  summarizeBrowserResult,
  validateBrowserPlan,
} from './plan.mjs';

const source = await loadBrowserPlan();
const legacySource = await loadBrowserPlan(
  resolve(repositoryRoot, 'benchmarks/wasix/browser-pglite-memory-v1.json'),
);

test('loads the exact browser plan and comparator pin', () => {
  const summary = browserPlanSummary(source);
  assert.equal(summary.id, 'browser-pglite-memory-v2');
  assert.match(summary.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(summary.engines.candidate.package, '@oliphaunt/wasix-ts');
  assert.deepEqual(summary.engines.candidate.surfaces.blocking, {
    engine: 'wasixBlocking',
    entrypoint: '@oliphaunt/wasix-ts/blocking',
    callingContract: 'blocking',
    executionOwner: 'caller',
  });
  assert.deepEqual(summary.engines.candidate.surfaces.default, {
    engine: 'wasixWorker',
    entrypoint: '@oliphaunt/wasix-ts',
    callingContract: 'async',
    executionOwner: 'package-worker',
  });
  assert.equal(summary.engines.comparison.package, '@electric-sql/pglite');
  assert.equal(summary.engines.comparison.version, '0.5.4');
  assert.equal(summary.profiles.full.workloadRuns, 8);
  assert.equal(summary.gate.maxGeomeanRatio, 0.8);
  assert.doesNotThrow(() => assertCurrentBrowserPlan(source.plan));
});

test('reads the versioned v1 plan and result without mutating historical bytes', () => {
  assert.equal(legacySource.plan.schema, 'oliphaunt-wasix-browser-benchmark-plan-v1');
  assert.equal(legacySource.plan.id, 'browser-pglite-memory-v1');
  assert.throws(
    () => assertCurrentBrowserPlan(legacySource.plan),
    /historical input and cannot drive a new benchmark/u,
  );
  const result = legacyFixture('full', { blockingRatio: 0.6, workerRatio: 0.5 });
  const before = JSON.stringify(result);

  const summary = summarizeBrowserResult(legacySource, result);

  assert.equal(JSON.stringify(result), before);
  assert.ok(Math.abs(summary.callingContracts.blocking.geomeanRatio - 0.6) < 1e-12);
  assert.ok(Math.abs(summary.callingContracts.worker.geomeanRatio - 0.5) < 1e-12);
  assert.equal(summary.passed, true);
  assert.throws(
    () => summarizeBrowserResult(source, result),
    /result\.schema must be "oliphaunt-wasix-browser-engine-result-v2"/u,
  );
});

test('rejects omitted metrics, settings, measurement fields, and execution surfaces', () => {
  const cases = [
    {
      label: 'gated metric',
      mutate(plan) {
        plan.gate.metrics.pop();
      },
      expected: /plan\.gate\.metrics must contain exactly/u,
    },
    {
      label: 'PostgreSQL setting',
      mutate(plan) {
        delete plan.postgres.settings.fsync;
      },
      expected: /plan\.postgres\.settings must contain exactly/u,
    },
    {
      label: 'measurement rule',
      mutate(plan) {
        delete plan.measurement.timingBoundary;
      },
      expected: /plan\.measurement must contain exactly/u,
    },
    {
      label: 'candidate surface',
      mutate(plan) {
        delete plan.engines.candidate.surfaces.blocking.entrypoint;
      },
      expected: /plan\.engines\.candidate\.surfaces\.blocking must contain exactly/u,
    },
    {
      label: 'comparison surface',
      mutate(plan) {
        delete plan.engines.comparison.surfaces.worker.executionOwner;
      },
      expected: /plan\.engines\.comparison\.surfaces\.worker must contain exactly/u,
    },
  ];

  for (const { label, mutate, expected } of cases) {
    const plan = structuredClone(source.plan);
    mutate(plan);
    assert.throws(() => validateBrowserPlan(plan), expected, label);
  }
});

test('balances full workload rotation across all four engines', () => {
  assert.equal(source.plan.profiles.full.workloadRuns, 8);
  assert.equal(source.plan.profiles.full.workloadRuns % 4, 0);

  for (const workloadRuns of [4, 6, 7, 9]) {
    const plan = structuredClone(source.plan);
    plan.profiles.full.workloadRuns = workloadRuns;
    assert.throws(
      () => validateBrowserPlan(plan),
      /workloadRuns must be a multiple of 4 and at least 8/u,
    );
  }

  const strongerPlan = structuredClone(source.plan);
  strongerPlan.profiles.full.workloadRuns = 12;
  assert.doesNotThrow(() => validateBrowserPlan(strongerPlan));
});

test('requires a clean exact Git commit and tree for benchmark qualification', () => {
  const clean = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    status: '',
  };
  assert.deepEqual(qualifyingGitProvenance(clean), {
    commit: clean.commit,
    tree: clean.tree,
    dirty: false,
  });
  assert.throws(
    () => qualifyingGitProvenance({ ...clean, status: ' M benchmark.ts' }),
    /requires a clean Git worktree/u,
  );
});

test('requires a comfortable aggregate win independently in both calling contracts', () => {
  const result = fixture('full', { blockingRatio: 0.6, workerRatio: 0.5 });
  const summary = summarizeBrowserResult(source, result);
  assert.ok(Math.abs(summary.callingContracts.blocking.geomeanRatio - 0.6) < 1e-12);
  assert.ok(Math.abs(summary.callingContracts.worker.geomeanRatio - 0.5) < 1e-12);
  assert.equal(summary.correctness.passed, true);
  assert.equal(summary.gate.required, true);
  assert.equal(summary.gate.passed, true);
  assert.equal(summary.passed, true);
});

test('does not let one calling contract subsidize a losing contract', () => {
  const summary = summarizeBrowserResult(
    source,
    fixture('full', { blockingRatio: 0.5, workerRatio: 0.9 }),
  );
  assert.equal(summary.callingContracts.blocking.gate.passed, true);
  assert.equal(summary.callingContracts.worker.gate.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

test('renders reports with the explicit blocking and Worker contract names', () => {
  const result = fixture('quick', { blockingRatio: 0.5, workerRatio: 0.5 });
  result.environment.userAgent = 'benchmark-test';
  const markdown = browserMarkdownReport({
    plan: browserPlanSummary(source),
    result,
    summary: summarizeBrowserResult(source, result),
  });

  assert.match(markdown, /## Blocking calling contract/u);
  assert.match(markdown, /## Worker calling contract/u);
  assert.doesNotMatch(markdown, /Direct topology/u);
});

test('makes quick runs correctness smoke evidence rather than performance qualification', () => {
  const summary = summarizeBrowserResult(
    source,
    fixture('quick', { blockingRatio: 0.95, workerRatio: 0.95 }),
  );
  assert.equal(summary.gate.required, false);
  assert.equal(summary.gate.passed, null);
  assert.equal(summary.passed, true);
});

test('rejects durability drift even when both performance gates win', () => {
  const result = fixture('full', { blockingRatio: 0.5, workerRatio: 0.5 });
  result.postgresProfiles.pgliteWorker.fsync = 'on';
  const summary = summarizeBrowserResult(source, result);
  assert.equal(summary.correctness.durability.worker.passed, false);
  assert.equal(summary.correctness.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

test('rejects WAL-volume drift even when workload results and speed agree', () => {
  const result = fixture('full', { blockingRatio: 0.5, workerRatio: 0.5 });
  result.insertDiagnostic.summary.indexedInsertWalBytes.wasixBlocking = 1100;
  const summary = summarizeBrowserResult(source, result);
  assert.equal(summary.correctness.indexedInsertWal.blocking.passed, false);
  assert.equal(summary.correctness.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

function fixture(mode, { blockingRatio, workerRatio }) {
  const profile = source.plan.profiles[mode];
  const metrics = source.plan.gate.metrics
    .filter((id) => id.startsWith('workload.'))
    .map((id) => id.slice('workload.'.length));
  const runs = (ratio) =>
    Array.from({ length: profile.workloadRuns }, () => ({
      metrics: Object.fromEntries([
        ...metrics.map((metric) => [metric, 10 * ratio]),
        ['readyMs', 10 * ratio],
        ['closeMs', 1_000_000],
      ]),
    }));
  const startup = (ratio) => [10, ...Array.from({ length: profile.startupRuns - 1 }, () => 10 * ratio)];
  const diagnostics = () =>
    Array.from({ length: profile.insertDiagnosticRuns }, () => ({ indexedInsertWalBytes: 1000 }));
  const postgres = () => ({
    version: '18.4',
    fsync: 'off',
    synchronousCommit: 'on',
    fullPageWrites: 'on',
    walLevel: 'replica',
  });
  return {
    schema: 'oliphaunt-wasix-browser-engine-result-v2',
    plan: source.plan.id,
    mode,
    environment: { crossOriginIsolated: true },
    configuration: {
      ...profile,
      callingContracts: ['caller-owned-blocking', 'package-worker-async'],
      rows: source.plan.measurement.rows,
      storage: source.plan.measurement.storage,
    },
    correctness: { assertionsPassed: true },
    postgresProfiles: {
      wasixBlocking: postgres(),
      wasixWorker: postgres(),
      pgliteDirect: postgres(),
      pgliteWorker: postgres(),
    },
    samples: {
      startup: {
        wasixBlocking: startup(blockingRatio),
        wasixWorker: startup(workerRatio),
        pgliteDirect: startup(1),
        pgliteWorker: startup(1),
      },
      workload: {
        wasixBlocking: runs(blockingRatio),
        wasixWorker: runs(workerRatio),
        pgliteDirect: runs(1),
        pgliteWorker: runs(1),
      },
    },
    insertDiagnostic: {
      summary: {
        indexedInsertWalBytes: {
          wasixBlocking: 1000,
          wasixWorker: 1000,
          pgliteDirect: 1000,
          pgliteWorker: 1000,
        },
      },
      samples: {
        wasixBlocking: diagnostics(),
        wasixWorker: diagnostics(),
        pgliteDirect: diagnostics(),
        pgliteWorker: diagnostics(),
      },
    },
  };
}

function legacyFixture(mode, ratios) {
  const current = fixture(mode, ratios);
  const configuration = { ...current.configuration };
  delete configuration.callingContracts;
  return {
    ...current,
    schema: 'oliphaunt-wasix-browser-engine-result-v1',
    plan: legacySource.plan.id,
    configuration,
    postgresProfiles: legacyEngineRecord(current.postgresProfiles),
    samples: {
      ...current.samples,
      startup: legacyEngineRecord(current.samples.startup),
      workload: legacyEngineRecord(current.samples.workload),
    },
    insertDiagnostic: {
      ...current.insertDiagnostic,
      summary: {
        ...current.insertDiagnostic.summary,
        indexedInsertWalBytes: legacyEngineRecord(
          current.insertDiagnostic.summary.indexedInsertWalBytes,
        ),
      },
      samples: legacyEngineRecord(current.insertDiagnostic.samples),
    },
  };
}

function legacyEngineRecord(record) {
  return {
    wasixDirect: record.wasixBlocking,
    wasixWorker: record.wasixWorker,
    pgliteDirect: record.pgliteDirect,
    pgliteWorker: record.pgliteWorker,
  };
}
