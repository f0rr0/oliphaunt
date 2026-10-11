import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedGitHubTestEnvironment as mutationTestEnvironment } from './testdata/isolated-github-test-environment.mts';

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

test('the local release check includes pins once and the mutation runner leaves them to Moon', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-test-ownership-'));
  const log = path.join(root, 'invocations.log');
  const script = readFileSync(new URL('./release-check.sh', import.meta.url), 'utf8');
  const write = (file: string, content: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    write('tools/release/release-check.sh', script);
    write('tools/dev/bun.sh', 'printf "%s\\n" "$TEST_RELEASE_CHECK_BUN"\n');
    write(
      'tools/release/release-metadata-check.sh',
      'echo metadata >> "$TEST_RELEASE_CHECK_LOG"\n',
    );
    write('tools/release/release-please-state.sh', 'shift 2\nexec "$@"\n');
    write('tools/release/with-source.sh', 'shift\nexec "$@"\n');
    write('tools/ci/with-projects.sh', 'printf "unit:%s\\n" "$*" >> "$TEST_RELEASE_CHECK_LOG"\n');
    write(
      'tools/release/independent-version-pins.test.sh',
      'echo pins >> "$TEST_RELEASE_CHECK_LOG"\n',
    );
    write('tools/release/independent-version-pins.test.mts', '');
    write('tools/release/prepare-release-candidate.test.mts', '');
    write('tools/release/unit.test.mts', '');
    write('tools/release/paired.test.mts', '');
    write('tools/release/paired.test.sh', 'echo paired >> "$TEST_RELEASE_CHECK_LOG"\n');

    for (const [arguments_, expected] of [
      [[], ['metadata', 'unit:test ./tools/release/unit.test.mts', 'paired', 'pins']],
      [['--mutation-tests-only'], ['unit:test ./tools/release/unit.test.mts', 'paired']],
    ] as const) {
      writeFileSync(log, '');
      const result = spawnSync('bash', ['tools/release/release-check.sh', ...arguments_], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...mutationTestEnvironment(),
          TEST_RELEASE_CHECK_BUN: process.execPath,
          TEST_RELEASE_CHECK_LOG: log,
        },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
