import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserPlanSummary,
  loadBrowserPlan,
  summarizeBrowserResult,
} from './plan.mjs';

const source = await loadBrowserPlan();

test('loads the exact browser plan and comparator pin', () => {
  const summary = browserPlanSummary(source);
  assert.equal(summary.id, 'browser-pglite-memory-v1');
  assert.match(summary.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(summary.engines.candidate.package, '@oliphaunt/wasix-ts');
  assert.equal(summary.engines.comparison.package, '@electric-sql/pglite');
  assert.equal(summary.engines.comparison.version, '0.5.4');
  assert.equal(summary.gate.maxGeomeanRatio, 0.8);
});

test('requires a comfortable aggregate win independently in both browser topologies', () => {
  const result = fixture('full', { directRatio: 0.6, workerRatio: 0.5 });
  const summary = summarizeBrowserResult(source, result);
  assert.ok(Math.abs(summary.topologies.direct.geomeanRatio - 0.6) < 1e-12);
  assert.ok(Math.abs(summary.topologies.worker.geomeanRatio - 0.5) < 1e-12);
  assert.equal(summary.correctness.passed, true);
  assert.equal(summary.gate.required, true);
  assert.equal(summary.gate.passed, true);
  assert.equal(summary.passed, true);
});

test('does not let one topology subsidize a losing topology', () => {
  const summary = summarizeBrowserResult(
    source,
    fixture('full', { directRatio: 0.5, workerRatio: 0.9 }),
  );
  assert.equal(summary.topologies.direct.gate.passed, true);
  assert.equal(summary.topologies.worker.gate.passed, false);
  assert.equal(summary.gate.passed, false);
  assert.equal(summary.passed, false);
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
    schema: 'oliphaunt-wasix-browser-engine-result-v1',
    plan: source.plan.id,
    mode,
    environment: { crossOriginIsolated: true },
    configuration: {
      ...profile,
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
