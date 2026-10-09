import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  affectedPlanBinding,
  assertBindingMatches,
  assertCandidateBindingShape,
  assertQualificationProductCoverage,
  candidateQualificationMode,
  wasixEvidenceBinding,
} from '../../.github/scripts/release-candidate-lib.mts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-release-candidate-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cleanup };
}

test('selected-product evidence binds scope and candidate SHA and rejects uncovered publication', () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, 'plan.json');
    const sha = 'a'.repeat(40);
    writeFileSync(
      planPath,
      JSON.stringify({
        qualification_mode: 'selected-products',
        qualification_base_sha: null,
        qualification_head_sha: sha,
        qualification_products: ['oliphaunt-js'],
        tasks: ['oliphaunt-js:package', 'oliphaunt-js:test-consumer', 'oliphaunt-query-ts:package'],
        projects: ['oliphaunt-js'],
        jobs: ['affected', 'js-sdk-package'],
        extension_package_products: [],
        package_bindings: [
          {
            consumer: 'oliphaunt-js',
            consumerVersion: '1.2.3',
            producer: 'liboliphaunt-native',
            producerVersion: '2.3.4',
            origin: 'published',
          },
        ],
        qualification_task_modes: [
          { task: 'oliphaunt-js:test-consumer', mode: 'installed-pinned' },
        ],
      }),
    );
    const candidate = {
      schemaVersion: 2,
      sha,
      affectedPlan: affectedPlanBinding(planPath, false),
      evidenceRequirements: { wasixReleaseRegression: false, artifacts: [] },
      evidence: { wasixReleaseRegression: null },
    };
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();
    expect(candidate.affectedPlan.packageBindings).toHaveLength(1);
    expect(candidate.affectedPlan.taskModes).toEqual([
      { task: 'oliphaunt-js:test-consumer', mode: 'installed-pinned' },
    ]);
    expect(() => assertQualificationProductCoverage(candidate, ['oliphaunt-js'])).not.toThrow();
    expect(() => assertQualificationProductCoverage(candidate, ['liboliphaunt-native'])).toThrow(
      /missing qualification/,
    );
    expect(() => assertQualificationProductCoverage(candidate, [])).toThrow(/non-empty/);
    expect(() => assertCandidateBindingShape({ ...candidate, sha: 'b'.repeat(40) })).toThrow(
      /candidate SHA/,
    );
  } finally {
    cleanup();
  }
});

test('selected-product evidence rejects contradictory package origins and task modes', () => {
  const { root, cleanup } = fixture();
  const sha = 'a'.repeat(40);
  const base = {
    qualification_mode: 'selected-products',
    qualification_base_sha: null,
    qualification_head_sha: sha,
    qualification_products: ['oliphaunt-js'],
    tasks: ['oliphaunt-js:test-consumer'],
    projects: ['oliphaunt-js'],
    jobs: ['affected', 'js-sdk-package'],
    extension_package_products: [],
    package_bindings: [],
    qualification_task_modes: [],
  };
  try {
    for (const [name, change, message] of [
      [
        'unselected-candidate-producer',
        {
          package_bindings: [
            {
              consumer: 'oliphaunt-js',
              consumerVersion: '1.2.3',
              producer: 'liboliphaunt-native',
              producerVersion: '2.3.4',
              origin: 'candidate',
            },
          ],
        },
        'candidate bindings must name selected qualification products',
      ],
      [
        'unselected-mode-task',
        {
          qualification_task_modes: [{ task: 'oliphaunt-js:unselected', mode: 'installed-pinned' }],
        },
        'task modes must describe selected qualification tasks',
      ],
      [
        'unknown-mode',
        {
          qualification_task_modes: [
            { task: 'oliphaunt-js:test-consumer', mode: 'current-workspace' },
          ],
        },
        'mode is invalid',
      ],
    ]) {
      const planPath = path.join(root, `${name}.json`);
      writeFileSync(planPath, JSON.stringify({ ...base, ...change }));
      expect(() => affectedPlanBinding(planPath, false)).toThrow(message);
    }

    const candidate = {
      schemaVersion: 2,
      sha,
      affectedPlan: {
        digest: `sha256:${'b'.repeat(64)}`,
        jobs: base.jobs,
        projects: base.projects,
        extensionPackageProducts: [],
        packageBindings: [],
        taskModes: [{ task: 'oliphaunt-js:unselected', mode: 'installed-pinned' }],
        wasixReleaseRegressionRequired: false,
        qualification: {
          mode: 'selected-products',
          baseSha: null,
          headSha: sha,
          products: base.qualification_products,
          tasks: base.tasks,
        },
      },
      evidenceRequirements: { wasixReleaseRegression: false, artifacts: [] },
      evidence: { wasixReleaseRegression: null },
    };
    expect(() => assertCandidateBindingShape(candidate)).toThrow(
      'task modes must describe selected qualification tasks',
    );
  } finally {
    cleanup();
  }
});

function publicExtensions() {
  const catalog = JSON.parse(
    readFileSync('src/extensions/generated/extensions.catalog.json', 'utf8'),
  );
  return catalog.extensions.map((extension) => extension.id).sort();
}

function writeEvidence(
  root,
  {
    extensions = publicExtensions(),
    runAttempt = 1,
    job = 'wasix-release-regression',
    runtimeModeStatuses = {
      direct: 'passed',
      server: 'passed',
      restart: 'passed',
      'dump-restore': 'passed',
    },
  } = {},
) {
  const runDirectory = path.join(root, 'src/extensions/evidence/runs');
  mkdirSync(runDirectory, { recursive: true });
  const run = {
    schema: 'oliphaunt-extension-evidence-v1',
    id: '2026-07-14T120000Z-ci-123456789-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    evidenceTier: 'wasix-full-lifecycle-v1',
    status: 'passed',
    sourceDigest: `sha256:${'b'.repeat(64)}`,
    sourceDigestInputs: ['z-input', 'a-input'],
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'c'.repeat(40),
    observedAt: '2026-07-14T12:00:00Z',
    collector: 'src/extensions/tools/collect-wasix-evidence.sh',
    github: {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: 123456789,
      runAttempt,
      job,
    },
    results: extensions.map((extension) => ({
      extension,
      sqlName: extension,
      postgresMajor: 18,
      artifactFamily: 'wasix-runtime',
      platformTarget: 'portable',
      runtimeModeStatuses,
    })),
  };
  writeFileSync(path.join(runDirectory, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

test('binds the canonical affected plan and conditional WASIX evidence', () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, 'ci-plan.json');
    writeFileSync(
      planPath,
      `${JSON.stringify(
        {
          projects: ['liboliphaunt-wasix'],
          jobs: ['affected', 'liboliphaunt-wasix-runtime'],
          extension_package_products: [],
          reason: 'test',
        },
        null,
        2,
      )}\n`,
    );
    const plan = affectedPlanBinding(planPath, true);
    writeEvidence(root);
    const evidence = wasixEvidenceBinding(root, {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: '123456789',
      runAttempt: 1,
      sha: 'a'.repeat(40),
      tree: 'c'.repeat(40),
    });
    const candidate = {
      schemaVersion: 2,
      affectedPlan: plan,
      evidenceRequirements: {
        wasixReleaseRegression: true,
        artifacts: ['wasix-release-regression-evidence'],
      },
      evidence: { wasixReleaseRegression: evidence },
    };
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();
    expect(evidence.github.runId).toBe(123456789);
    expect(evidence.resultCount).toBe(publicExtensions().length);
  } finally {
    cleanup();
  }
});

test('physical backup evidence requires both restoration and materialization to pass', () => {
  const { root, cleanup } = fixture();
  const provenance = {
    repository: 'f0rr0/oliphaunt',
    workflow: 'CI',
    runId: '123456789',
    runAttempt: 1,
    sha: 'a'.repeat(40),
    tree: 'c'.repeat(40),
  };
  const modes = {
    direct: 'passed',
    server: 'passed',
    restart: 'passed',
    'backup-restore': 'passed',
    materialization: 'passed',
  };
  try {
    writeEvidence(root, { runtimeModeStatuses: modes });
    expect(wasixEvidenceBinding(root, provenance).resultCount).toBe(publicExtensions().length);
    for (const mode of ['backup-restore', 'materialization']) {
      for (const status of ['failed', undefined]) {
        writeEvidence(root, { runtimeModeStatuses: { ...modes, [mode]: status } });
        expect(() => wasixEvidenceBinding(root, provenance)).toThrow('status mismatch');
      }
    }
  } finally {
    cleanup();
  }
});

test('rejects an incomplete WASIX evidence result set', () => {
  const { root, cleanup } = fixture();
  try {
    writeEvidence(root, { extensions: publicExtensions().slice(1) });
    expect(() =>
      wasixEvidenceBinding(root, {
        repository: 'f0rr0/oliphaunt',
        workflow: 'CI',
        runId: '123456789',
        runAttempt: 1,
        sha: 'a'.repeat(40),
        tree: 'c'.repeat(40),
      }),
    ).toThrow('every and only public extension');
  } finally {
    cleanup();
  }
});

test('rejects a plan requirement that disagrees with selected jobs', () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, 'ci-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        projects: ['oliphaunt-js'],
        jobs: ['affected', 'js-sdk-package'],
        extension_package_products: [],
      }),
    );
    expect(() => affectedPlanBinding(planPath, true)).toThrow('jobs imply false');
  } finally {
    cleanup();
  }
});

test('rejects substituted evidence bytes even when provenance fields still match', () => {
  const { root, cleanup } = fixture();
  try {
    writeEvidence(root);
    const expected = wasixEvidenceBinding(root, {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: '123456789',
      runAttempt: 1,
      sha: 'a'.repeat(40),
      tree: 'c'.repeat(40),
    });
    const evidencePath = path.join(root, expected.file);
    const substituted = JSON.parse(readFileSync(evidencePath, 'utf8'));
    substituted.notes = 'substituted bytes with otherwise matching provenance';
    writeFileSync(evidencePath, `${JSON.stringify(substituted, null, 2)}\n`);
    const actual = wasixEvidenceBinding(root, {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: '123456789',
      runAttempt: 1,
      sha: 'a'.repeat(40),
      tree: 'c'.repeat(40),
    });
    expect(() => assertBindingMatches(expected, actual, 'WASIX evidence')).toThrow(
      'does not match',
    );
  } finally {
    cleanup();
  }
});

test('accepts WASIX evidence from an earlier attempt of the same run and source', () => {
  const { root, cleanup } = fixture();
  try {
    writeEvidence(root, { runAttempt: 1 });
    const evidence = wasixEvidenceBinding(root, {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: '123456789',
      runAttempt: 2,
      sha: 'a'.repeat(40),
      tree: 'c'.repeat(40),
    });
    expect(evidence.github.runAttempt).toBe(1);
  } finally {
    cleanup();
  }
});

test('rejects newer-attempt or provenance-mismatched WASIX evidence', () => {
  const attemptFixture = fixture();
  try {
    writeEvidence(attemptFixture.root, { runAttempt: 2 });
    expect(() =>
      wasixEvidenceBinding(attemptFixture.root, {
        repository: 'f0rr0/oliphaunt',
        workflow: 'CI',
        runId: '123456789',
        runAttempt: 1,
        sha: 'a'.repeat(40),
        tree: 'c'.repeat(40),
      }),
    ).toThrow('must not be newer than the candidate attempt');
  } finally {
    attemptFixture.cleanup();
  }

  const provenanceFixture = fixture();
  try {
    writeEvidence(provenanceFixture.root);
    const expected = {
      repository: 'f0rr0/oliphaunt',
      workflow: 'CI',
      runId: '123456789',
      runAttempt: 1,
      sha: 'a'.repeat(40),
      tree: 'c'.repeat(40),
    };
    expect(() =>
      wasixEvidenceBinding(provenanceFixture.root, {
        ...expected,
        runId: '987654321',
      }),
    ).toThrow('GitHub runId mismatch');
    expect(() =>
      wasixEvidenceBinding(provenanceFixture.root, {
        ...expected,
        sha: 'd'.repeat(40),
      }),
    ).toThrow('sourceCommit mismatch');
    expect(() =>
      wasixEvidenceBinding(provenanceFixture.root, {
        ...expected,
        tree: 'd'.repeat(40),
      }),
    ).toThrow('sourceTree mismatch');
  } finally {
    provenanceFixture.cleanup();
  }
});

test('rejects a changed selected-product set even when WASIX remains required', () => {
  const { root, cleanup } = fixture();
  try {
    const firstPath = path.join(root, 'first-plan.json');
    const secondPath = path.join(root, 'second-plan.json');
    const base = {
      projects: ['extensions'],
      jobs: ['affected', 'liboliphaunt-wasix-runtime'],
    };
    writeFileSync(
      firstPath,
      JSON.stringify({
        ...base,
        extension_package_products: ['oliphaunt-extension-vector'],
      }),
    );
    writeFileSync(
      secondPath,
      JSON.stringify({
        ...base,
        extension_package_products: ['oliphaunt-extension-postgis'],
      }),
    );
    const expected = affectedPlanBinding(firstPath, true);
    const actual = affectedPlanBinding(secondPath, true);
    expect(() => assertBindingMatches(expected, actual, 'affected plan')).toThrow('does not match');
  } finally {
    cleanup();
  }
});

test('keeps legacy F4 qualification plans backward-compatible as full-payload', () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, 'legacy-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        projects: [],
        jobs: ['affected'],
        extension_package_products: [],
      }),
    );
    const affectedPlan = affectedPlanBinding(planPath, false);
    const candidate = {
      schemaVersion: 2,
      affectedPlan,
      evidenceRequirements: {
        wasixReleaseRegression: false,
        artifacts: [],
      },
      evidence: { wasixReleaseRegression: null },
    };
    expect(affectedPlan.qualification).toBeUndefined();
    expect(candidateQualificationMode(candidate)).toBe('full-payload');
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();
  } finally {
    cleanup();
  }
});
