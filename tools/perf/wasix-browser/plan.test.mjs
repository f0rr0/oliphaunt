import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserMarkdownReport,
  browserPlanSummary,
  loadBrowserPlan,
  qualifyingGitProvenance,
  summarizeBrowserResult,
  validateBrowserPlan,
} from './plan.mjs';

const source = await loadBrowserPlan();

test('loads the exact browser plan and comparator pin', () => {
  const summary = browserPlanSummary(source);
  assert.equal(summary.id, 'browser-pglite-memory-v2');
  assert.match(summary.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(summary.engines.candidate.package, '@oliphaunt/wasix-ts');
  assert.deepEqual(summary.engines.candidate.surfaces.direct, {
    engine: 'wasixDirect',
    entrypoint: '@oliphaunt/wasix-ts',
    callingContract: 'async',
    executionOwner: 'caller',
  });
  assert.deepEqual(summary.engines.candidate.surfaces.worker, {
    engine: 'wasixWorker',
    entrypoint: '@oliphaunt/wasix-ts/worker',
    callingContract: 'async',
    executionOwner: 'sdk-worker',
  });
  assert.equal(summary.engines.comparison.package, '@electric-sql/pglite');
  assert.equal(summary.engines.comparison.version, '0.5.4');
  assert.equal(summary.profiles.full.workloadRuns, 8);
  assert.equal(summary.gate.maxGeomeanRatio, 0.8);
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
        delete plan.engines.candidate.surfaces.direct.entrypoint;
      },
      expected: /plan\.engines\.candidate\.surfaces\.direct must contain exactly/u,
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

test('requires a comfortable aggregate win independently on both execution surfaces', () => {
  const result = fixture('full', { directRatio: 0.6, workerRatio: 0.5 });
  const summary = summarizeBrowserResult(source, result);
  assert.ok(Math.abs(summary.comparisons.direct.geomeanRatio - 0.6) < 1e-12);
  assert.ok(Math.abs(summary.comparisons.worker.geomeanRatio - 0.5) < 1e-12);
  assert.equal(summary.correctness.passed, true);
  assert.equal(summary.gate.required, true);
  assert.equal(summary.gate.passed, true);
  assert.equal(summary.passed, true);
});

test('requires independent calling-contract and execution-owner fields in v2 results', () => {
  const result = fixture('quick', { directRatio: 0.6, workerRatio: 0.5 });
  assert.doesNotThrow(() => summarizeBrowserResult(source, result));

  const flattened = structuredClone(result);
  flattened.configuration.executionSurfaces = ['direct', 'worker'];
  assert.throws(
    () => summarizeBrowserResult(source, flattened),
    /result\.configuration\.executionSurfaces must be an object/u,
  );

  const wrongOwner = structuredClone(result);
  wrongOwner.configuration.executionSurfaces.worker.executionOwner = 'caller';
  assert.throws(
    () => summarizeBrowserResult(source, wrongOwner),
    /result\.configuration\.executionSurfaces\.worker\.executionOwner/u,
  );
});

test('does not let one execution surface subsidize a losing surface', () => {
  const summary = summarizeBrowserResult(
    source,
    fixture('full', { directRatio: 0.5, workerRatio: 0.9 }),
  );
  assert.equal(summary.comparisons.direct.gate.passed, true);
  assert.equal(summary.comparisons.worker.gate.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

test('renders reports with the direct and Worker comparison names', () => {
  const result = fixture('quick', { directRatio: 0.5, workerRatio: 0.5 });
  result.environment.userAgent = 'benchmark-test';
  const markdown = browserMarkdownReport({
    plan: browserPlanSummary(source),
    result,
    summary: summarizeBrowserResult(source, result),
  });

  assert.match(markdown, /## Direct comparison/u);
  assert.match(markdown, /## Worker comparison/u);
});

test('makes quick runs correctness smoke evidence rather than performance qualification', () => {
  const summary = summarizeBrowserResult(
    source,
    fixture('quick', { directRatio: 0.95, workerRatio: 0.95 }),
  );
  assert.equal(summary.gate.required, false);
  assert.equal(summary.gate.passed, null);
  assert.equal(summary.passed, true);
});

test('rejects durability drift even when both performance gates win', () => {
  const result = fixture('full', { directRatio: 0.5, workerRatio: 0.5 });
  result.postgresProfiles.pgliteWorker.fsync = 'on';
  const summary = summarizeBrowserResult(source, result);
  assert.equal(summary.correctness.durability.worker.passed, false);
  assert.equal(summary.correctness.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

test('rejects WAL-volume drift even when workload results and speed agree', () => {
  const result = fixture('full', { directRatio: 0.5, workerRatio: 0.5 });
  result.insertDiagnostic.summary.indexedInsertWalBytes.wasixDirect = 1100;
  const summary = summarizeBrowserResult(source, result);
  assert.equal(summary.correctness.indexedInsertWal.direct.passed, false);
  assert.equal(summary.correctness.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
});

function fixture(mode, { directRatio, workerRatio }) {
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
      executionSurfaces: {
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
      },
      rows: source.plan.measurement.rows,
      storage: source.plan.measurement.storage,
    },
    correctness: { assertionsPassed: true },
    postgresProfiles: {
      wasixDirect: postgres(),
      wasixWorker: postgres(),
      pgliteDirect: postgres(),
      pgliteWorker: postgres(),
    },
    samples: {
      startup: {
        wasixDirect: startup(directRatio),
        wasixWorker: startup(workerRatio),
        pgliteDirect: startup(1),
        pgliteWorker: startup(1),
      },
      workload: {
        wasixDirect: runs(directRatio),
        wasixWorker: runs(workerRatio),
        pgliteDirect: runs(1),
        pgliteWorker: runs(1),
      },
    },
    insertDiagnostic: {
      summary: {
        indexedInsertWalBytes: {
          wasixDirect: 1000,
          wasixWorker: 1000,
          pgliteDirect: 1000,
          pgliteWorker: 1000,
        },
      },
      samples: {
        wasixDirect: diagnostics(),
        wasixWorker: diagnostics(),
        pgliteDirect: diagnostics(),
        pgliteWorker: diagnostics(),
      },
    },
  };
}
