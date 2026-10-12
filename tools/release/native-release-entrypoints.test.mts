/** These dispatch fixtures grant no qualification or publication authority. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedGitHubTestEnvironment } from './testdata/isolated-github-test-environment.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const invalidRuns = [undefined, '', '0', '01', '-1', '1.5', '12\n'];

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-release-entrypoints-'));
  const log = path.join(root, '.git/commands');
  const directory = path.join(root, '.git/candidate');
  const output = path.join(root, '.git/outputs');
  const write = (file, content) => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '--quiet');
    for (const file of ['prepare-release-pr.sh', 'close-release-candidate.sh'])
      write(`tools/release/${file}`, readFileSync(path.join(ROOT, 'tools/release', file)));
    write('tools/ci/with-projects.sh', 'echo legacy-selector-invoked >&2\nexit 97\n');
    for (const [file, count] of [
      ['with-source.sh', 1],
      ['with-product-history.sh', 4],
      ['release-please-state.sh', 2],
      ['with-release-history.sh', 2],
    ])
      write(`tools/release/${file}`, `shift ${count}\nexec "$@"\n`);
    write(
      'tools/dev/bun.sh',
      'printf "%s\\n" "$*" >> "$TEST_COMMAND_LOG"\n' +
        'if [[ "$1" == tools/release/prepare-release-candidate.mts ]]; then\n' +
        '  mkdir -p "$2"\n' +
        '  printf "%s\\n" "$TEST_CANDIDATE_REQUIRED" > "$2/required"\n' +
        '  if [[ "$TEST_NATIVE_PACKET" == true ]]; then\n' +
        '    mkdir -p "$2/native-release-inputs"\n' +
        '    touch "$2/native-release-inputs/native-version-source.json" "$2/native-release-inputs/native-publication-inputs.json"\n' +
        '  fi\n' +
        'fi\n',
    );
    git('add', '.');
    git(
      '-c',
      'user.name=Release Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'test: release entrypoints',
    );
    const source = git('rev-parse', 'HEAD');
    const env = isolatedGitHubTestEnvironment({
      TEST_COMMAND_LOG: log,
      TEST_CANDIDATE_REQUIRED: 'true',
      TEST_NATIVE_PACKET: 'true',
      GITHUB_OUTPUT: output,
    });
    delete env.NATIVE_QUALIFICATION_RUN_ID;
    const command = (file, qualification, additions = {}) =>
      spawnSync('bash', [`tools/release/${file}`, directory], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...env,
          ...(qualification === undefined ? {} : { NATIVE_QUALIFICATION_RUN_ID: qualification }),
          ...additions,
        },
      });
    return run({ root, directory, log, output, source, git, command, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('release shell entrypoints reject missing or malformed native proof before reads or mutation', () => {
  fixture(({ command, git, source, log }) => {
    for (const file of ['prepare-release-pr.sh', 'close-release-candidate.sh']) {
      for (const run of invalidRuns) {
        const result = command(file, run);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /exact positive qualification run ID/u);
        assert.equal(git('rev-parse', 'HEAD'), source);
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
      }
    }
    assert.throws(() => readFileSync(log), { code: 'ENOENT' });
  });
});

test('native preparation routes once without Moon and requires its retained packet for a release', () => {
  for (const [required, packet, status] of [
    ['false', 'false', 0],
    ['true', 'true', 0],
    ['true', 'false', 1],
  ])
    fixture(({ command, directory, log, output }) => {
      const result = command('prepare-release-pr.sh', '123', {
        TEST_CANDIDATE_REQUIRED: required,
        TEST_NATIVE_PACKET: packet,
      });
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
        'tools/release/release-please-pr-lifecycle.mts assert-clean --base main',
        `tools/release/prepare-release-candidate.mts ${directory}`,
      ]);
      if (status === 0)
        assert.equal(
          readFileSync(output, 'utf8'),
          `required=${required}\nnative_inputs=${required}\n`,
        );
      else assert.match(result.stderr, /did not retain its completed input packet/u);
    });
});

test('native close verifies the already committed candidate without another source commit', () => {
  fixture(({ command, directory, log, write, git, source }) => {
    write('.git/candidate/required', 'true\n');
    const result = command('close-release-candidate.sh', '123');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'tools/release/check_release_please_config.mts',
      'tools/release/check_artifact_targets.mts',
      `tools/release/native-close-release-candidate.mts ${directory}`,
    ]);
    assert.equal(git('rev-parse', 'HEAD'), source);
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  });
});

test('direct TypeScript preparation cannot fall back when its native coordinator is absent', () => {
  for (const qualification of [...invalidRuns, '9007199254740993']) {
    const env = isolatedGitHubTestEnvironment({
      RELEASE_SOURCE_SHA: 'a'.repeat(40),
      GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
    });
    delete env.NATIVE_QUALIFICATION_RUN_ID;
    if (qualification !== undefined) env.NATIVE_QUALIFICATION_RUN_ID = qualification;
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'tools/release/prepare-release-candidate.mts'),
        '/not-created/native-candidate',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 10_000, env },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /native preparation requires an exact positive qualification run ID/u,
    );
    assert.doesNotMatch(result.stderr, /source date|fetch|Moon|ENOTFOUND/u);
  }
});
