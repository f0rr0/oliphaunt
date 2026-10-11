import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authenticateNativeBuildEvidence } from './authenticate-native-build-evidence.mts';

const expected = {
  source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  github: {
    repository: 'f0rr0/oliphaunt',
    workflow: 'Native Bazel qualification',
    workflowPath: '.github/workflows/bazel.yml',
    runId: 77,
    runAttempt: 1,
    job: 'Linux runtime (x86_64)',
  },
  event: 'workflow_dispatch' as const,
  ref: 'refs/heads/main',
  artifactName: 'native-build-evidence-x86_64',
};

async function fixture(run: (root: string) => Promise<void>, kind = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-auth-test-'));
  const keys = [
    'BUN_OPTIONS',
    'GH_TOKEN',
    'GH_REPO',
    'PATH',
    'FAKE_NATIVE_ORIGIN',
    'FAKE_NATIVE_CASE',
    'FAKE_ARTIFACT_ARCHIVE',
    'FAKE_GH_LOG',
    'FAKE_GH_STATE',
    'FAKE_MODE',
    'FAKE_RUN_CONCLUSION',
    'OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    mkdirSync(path.join(root, 'evidence'));
    // Synthetic transport bytes exercise this boundary; they are not a qualified or live-authenticated build packet.
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ synthetic: true }),
    );
    execFileSync('zip', ['-q', path.join(root, 'artifact.zip'), 'native-build-evidence.json'], {
      cwd: path.join(root, 'evidence'),
    });
    mkdirSync(path.join(root, 'untrusted-cache'));
    writeFileSync(
      path.join(root, 'untrusted-cache/run-77.json'),
      '{"untrusted":"downloaded fixture metadata"}',
    );
    Object.assign(process.env, {
      BUN_OPTIONS: `--preload=${path.resolve(import.meta.dir, 'testdata/download-build-artifacts-github.mts')}`,
      GH_TOKEN: 'test-token',
      GH_REPO: 'ignored/by-adapter',
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      FAKE_NATIVE_ORIGIN: 'true',
      FAKE_NATIVE_CASE: kind,
      FAKE_ARTIFACT_ARCHIVE: path.join(root, 'artifact.zip'),
      FAKE_GH_LOG: path.join(root, 'api.log'),
      FAKE_GH_STATE: path.join(root, 'download-count'),
      FAKE_MODE: 'success',
      FAKE_RUN_CONCLUSION: 'failure',
      OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: path.join(root, 'untrusted-cache'),
    });
    await run(root);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('native origin uses the existing exact-ID/digest transport and selected successful job, ignoring inherited fixture caches', async () => {
  await fixture(async (root) => {
    const origin = await authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected);
    expect(origin.github).toEqual(expected.github);
    expect(origin.artifact).toMatchObject({ id: 101, name: expected.artifactName });
    expect(origin.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(origin.evidence).toEqual({ synthetic: true });
    expect(origin.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ changedAfterAuthentication: true }),
    );
    expect(origin.evidence).toEqual({ synthetic: true });
    const endpoints: string[] = readFileSync(path.join(root, 'api.log'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(endpoints.some((url) => url.endsWith('/actions/artifacts/101/zip'))).toBe(true);
    expect(endpoints.some((url) => url.endsWith(`/git/commits/${expected.source.commit}`))).toBe(
      true,
    );
    expect(readFileSync(path.join(root, 'untrusted-cache/run-77.json'), 'utf8')).toContain(
      'untrusted',
    );
  });
});

test('native origin rejects stale source/tree/attempt/job, wrong workflow/event/ref and cross-attempt artifacts', async () => {
  for (const kind of [
    'source',
    'tree',
    'attempt',
    'job-attempt',
    'job-failure',
    'workflow',
    'run-workflow',
    'event',
    'ref',
    'stale-artifact',
    'artifact-source',
    'artifact-missing',
    'artifact-ambiguous',
    'artifact-window-missing',
    'artifact-head-missing',
    'job-window-missing',
  ]) {
    await fixture(async (root) => {
      await expect(
        authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
      ).rejects.toThrow();
      expect(existsSync(path.join(root, 'download-count'))).toBe(false);
    }, kind);
  }
});

test('authentication CLI emits bounded origin metadata and digest without the large parsed packet', async () => {
  await fixture(async (root) => {
    const context = path.join(root, 'github.json');
    writeFileSync(context, JSON.stringify(expected.github));
    const script = path.resolve(import.meta.dir, 'authenticate-native-build-evidence.mts');
    const output = execFileSync(
      process.execPath,
      [
        script,
        '--source-commit',
        expected.source.commit,
        '--source-tree',
        expected.source.tree,
        '--github-json',
        context,
        '--event',
        expected.event,
        '--ref',
        expected.ref,
        '--artifact-name',
        expected.artifactName,
        '--evidence-root',
        path.join(root, 'evidence'),
      ],
      { encoding: 'utf8', env: process.env },
    );
    const origin = JSON.parse(output);
    expect(Object.keys(origin).sort()).toEqual(['artifact', 'evidenceDigest', 'github']);
    expect(origin.github).toEqual(expected.github);
    expect(origin.artifact.id).toBe(101);
    expect(() =>
      execFileSync(process.execPath, [script, '--evidence-root', path.join(root, 'evidence')], {
        env: process.env,
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});

test('native origin rejects tampered downloaded archives and local evidence bytes', async () => {
  await fixture(async (root) => {
    await expect(
      authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
    ).rejects.toThrow(/ZIP identity mismatch/);
    expect(readFileSync(path.join(root, 'download-count'), 'utf8')).toBe('2');
  }, 'digest');
  await fixture(async (root) => {
    writeFileSync(
      path.join(root, 'evidence/native-build-evidence.json'),
      JSON.stringify({ tampered: true }),
    );
    await expect(
      authenticateNativeBuildEvidence(path.join(root, 'evidence'), expected),
    ).rejects.toThrow(/bytes differ/);
  });
});
