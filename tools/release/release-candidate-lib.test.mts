import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  affectedPlanBinding,
  assertBindingMatches,
  assertCandidateBindingShape,
  candidateQualificationMode,
  wasixEvidenceBinding,
} from '../../.github/scripts/release-candidate-lib.mts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-release-candidate-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cleanup };
}

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

test('candidate commands bind the actual Git checkout and reject changed plans or commits', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve('.github/scripts/release-candidate.sh');
  const { root, cleanup } = fixture();
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    );
    const sha = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const plan = path.join(root, 'plan.json'),
      candidate = path.join(root, 'candidate.json');
    writeFileSync(
      plan,
      JSON.stringify({ projects: [], jobs: ['affected'], extension_package_products: [] }),
    );
    const env = {
      ...process.env,
      CI_HEAD_SHA: sha,
      RELEASE_HEAD_SHA: sha,
      CI_PLAN_PATH: plan,
      CI_QUALIFICATION_MODE: 'full-payload',
      WASIX_RELEASE_REGRESSION_REQUIRED: 'false',
      GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_WORKFLOW_REF: 'f0rr0/oliphaunt/.github/workflows/ci.yml@refs/heads/main',
      GITHUB_RUN_ID: '123',
      CI_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      CI_CHECKED_OUT_SHA: 'b'.repeat(40),
      CI_SOURCE_TREE: 'c'.repeat(40),
    };
    const run = (args, overrides = {}) =>
      spawnSync('bash', [script, ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: 'utf8',
      });
    const written = run(['write', candidate]);
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(readFileSync(candidate, 'utf8'))).toMatchObject({ sha, tree });
    const verify = ['verify', candidate, '--plan', plan, '--wasix-evidence-required', 'false'];
    const verified = run(verify);
    expect(verified.status, verified.stderr).toBe(0);
    expect(run(['write', candidate], { CI_HEAD_SHA: 'a'.repeat(40) }).status).not.toBe(0);
    expect(run(verify, { RELEASE_HEAD_SHA: 'a'.repeat(40) }).status).not.toBe(0);
    writeFileSync(
      plan,
      JSON.stringify({ projects: ['changed'], jobs: ['affected'], extension_package_products: [] }),
    );
    expect(run(verify).status).not.toBe(0);
  } finally {
    cleanup();
  }
});
