import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedGitHubTestEnvironment as mutationTestEnvironment } from '../test/isolated-github-test-environment.mts';
import { uniqueValueFlag } from './release-cli-utils.mts';

test('release CLI value flags reject ambiguous duplicate identities', () => {
  assert.equal(uniqueValueFlag(['--head-ref', 'a'.repeat(40)], '--head-ref'), 'a'.repeat(40));
  assert.equal(uniqueValueFlag(['--products-json=["sdk"]'], '--products-json'), '["sdk"]');
  assert.throws(
    () =>
      uniqueValueFlag(['--head-ref', 'a'.repeat(40), `--head-ref=${'b'.repeat(40)}`], '--head-ref'),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () =>
      uniqueValueFlag(
        ['--products-json=["sdk"]', '--products-json', '["extension"]'],
        '--products-json',
      ),
    /--products-json must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(['--head-ref', `--head-ref=${'b'.repeat(40)}`], '--head-ref'),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(['--head-ref'], '--head-ref'),
    /--head-ref requires a value/u,
  );
});

test('deleted product registry routes fail before publication lock access', () => {
  for (const step of ['crates-io', 'npm', 'maven-central']) {
    const result = spawnSync(
      process.execPath,
      ['tools/release/release-publish.mts', 'publish', '--product', 'oliphaunt-js', '--step', step],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        encoding: 'utf8',
        env: { ...process.env, OLIPHAUNT_PUBLICATION_LOCK: '/does/not/exist' },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /normal product\/ecosystem registry steps are disabled/u,
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /cannot read publication lock/u);
  }
});

test('release mutation tests cannot consume a live publish request journal', () => {
  assert.deepEqual(
    mutationTestEnvironment(
      {},
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
        GITHUB_RUN_ID: '30593859032',
        KEEP_ME: 'preserved',
        OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: '/live/journal.json',
        OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: 'true',
        RELEASE_HEAD_SHA: 'a'.repeat(40),
      },
    ),
    { KEEP_ME: 'preserved' },
  );
});

test('Shell dry run uses qualified evidence and stops before registry checks when it fails', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-dry-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  for (const directory of ['tools/release', 'tools/dev', '.github/scripts'])
    mkdirSync(path.join(root, directory), { recursive: true });
  const script = path.join(root, 'tools/release/release-dry-run.sh');
  copyFileSync(path.resolve(import.meta.dirname, 'release-dry-run.sh'), script);
  writeFileSync(path.join(root, 'tools/dev/bun.sh'), 'printf "%s\\n" "$*" >> "$TEST_LOG"\n');
  for (const [file, name] of [
    ['tools/release/release-check.sh', 'tests'],
    ['tools/release/qualified-release-replay.sh', 'qualified'],
    ['tools/release/release-check-registries.sh', 'registries'],
    ['.github/scripts/release-candidate.sh', 'candidate'],
  ]) {
    writeFileSync(
      path.join(root, file),
      'echo ' +
        name +
        ' >> "$TEST_LOG"\n' +
        (name === 'candidate' ? 'exit "$TEST_CANDIDATE_STATUS"\n' : ''),
    );
  }
  const log = path.join(root, 'commands');
  const products = '["oliphaunt-js"]';
  const env = mutationTestEnvironment({
    TEST_LOG: log,
    WASIX_EVIDENCE_REQUIRED: 'false',
    TEST_CANDIDATE_STATUS: '0',
  });
  const run = (args, overrides = {}) => {
    writeFileSync(log, '');
    return spawnSync('bash', [script, ...args], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 10000,
    });
  };
  assert.equal(run(['--products-json', products]).status, 0);
  assert.match(readFileSync(log, 'utf8'), /tests\nregistries\n$/u);
  assert.equal(
    run(['--qualified-ci', '--products-json', products, '--head-ref', 'HEAD']).status,
    0,
  );
  assert.match(readFileSync(log, 'utf8'), /qualified\ncandidate\nregistries\n$/u);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /tests/u);
  assert.equal(
    run(['--qualified-ci', '--products-json', products], { TEST_CANDIDATE_STATUS: '7' }).status,
    7,
  );
  assert.doesNotMatch(readFileSync(log, 'utf8'), /registries/u);
  for (const args of [
    ['--qualified-ci', '--allow-dirty'],
    ['--products-json', products, '--products-json', products],
    ['--head-ref', 'HEAD', '--head-ref=HEAD'],
    ['--unknown'],
  ]) {
    assert.notEqual(run(args).status, 0);
    assert.equal(readFileSync(log, 'utf8'), '');
  }
});
