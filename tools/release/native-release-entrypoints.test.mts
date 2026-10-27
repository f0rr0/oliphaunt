/** These dispatch fixtures grant no qualification or publication authority. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedGitHubTestEnvironment } from './testdata/isolated-github-test-environment.mts';
import { reconcileNativePrepare } from './native-prepare-continuation.mts';
import { nativePrepareContinuationFixture } from './testdata/native-prepare-continuation-fixture.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const invalidRuns = [undefined, '', '0', '01', '-1', '1.5', '12\n'];

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-release-entrypoints-'));
  let deferredCleanup = false;
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
    const result = run({ root, directory, log, output, source, git, command, write });
    if (result?.then) {
      deferredCleanup = true;
      return result.finally(() => rmSync(root, { recursive: true, force: true }));
    }
    return result;
  } finally {
    if (!deferredCleanup) rmSync(root, { recursive: true, force: true });
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

test('Prepare reuses successful Required proof and returns pending Native work without preparing', {
  timeout: 20_000,
}, () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  const prerequisite = workflow.jobs['qualify-prepare-source'];
  const prepare = workflow.jobs['prepare-release-pr'];
  assert.equal(prerequisite.permissions.actions, 'write');
  assert.equal(prepare.permissions.actions, 'read');
  assert.ok(prepare.needs.includes('qualify-prepare-source'));
  assert.match(prepare.if, /needs\.qualify-prepare-source\.outputs\.run_id != ''/u);
  assert.equal(
    prepare.steps.find((step) => step.id === 'prepare_candidate').env.NATIVE_QUALIFICATION_RUN_ID,
    '${{ needs.qualify-prepare-source.outputs.run_id }}',
  );
  const request = prerequisite.steps.find((step) => step.id === 'native_qualification');
  assert.equal(request.env.GH_TOKEN, '${{ github.token }}');
  assert.match(request.run, /--request-native-qualification/u);
  for (const mode of [
    'reuse',
    'active',
    'source',
    'absent',
    'feature',
    'failed',
    'dispatch-skipped',
    'advanced',
    'race',
    'ambiguous',
  ]) {
    fixture(({ root, source, command, write, directory }) => {
      const bin = path.join(root, '.git/bin');
      const output = path.join(root, '.git/native-output');
      const dispatch = path.join(root, '.git/native-dispatch.json');
      mkdirSync(bin);
      write(
        '.git/bin/gh',
        '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == api && "$2" == --method && "$3" == POST && ! -e "$FAKE_DISPATCH" ]] || exit 93\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --input ]]; then cp "$2" "$FAKE_DISPATCH"; break; fi; shift; done\n[[ "$FAKE_MODE" != native-ambiguous ]] || exit 95\nprintf \'{"workflow_run_id":88}\\n\'\n',
      );
      chmodSync(path.join(bin, 'gh'), 0o755);
      const result = spawnSync('bash', ['-c', request.run], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
        env: isolatedGitHubTestEnvironment({
          PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
          GH_TOKEN: 'test-token',
          GH_REPO: 'f0rr0/oliphaunt',
          GITHUB_SHA: source,
          GITHUB_OUTPUT: output,
          BUN_OPTIONS: `--preload=${ROOT}/tools/release/testdata/require-workflow-success-github.mts`,
          FAKE_NATIVE_SHA: source,
          FAKE_MODE: `native-${mode}`,
          FAKE_DISPATCH: dispatch,
          FAKE_LOG: path.join(root, '.git/native-reads'),
          OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '0',
          OLIPHAUNT_GITHUB_READ_DEADLINE_MS: '1000',
          OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '1',
          OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '0',
        }),
      });
      if (mode === 'reuse') {
        assert.equal(result.status, 0, result.stderr);
        const proof = /^run_id=(\d+)$/mu.exec(readFileSync(output, 'utf8'))?.[1];
        assert.equal(proof, '77');
        assert.equal(command('prepare-release-pr.sh', proof).status, 0);
        assert.ok(readFileSync(path.join(directory, 'required'), 'utf8').includes('true'));
      } else if (['active', 'source', 'absent', 'feature'].includes(mode)) {
        assert.equal(result.status, 0, result.stderr);
        const pending = readFileSync(output, 'utf8');
        assert.doesNotMatch(pending, /^run_id=/mu);
        assert.match(
          pending,
          new RegExp(`qualification_pending_run_id=${mode === 'active' ? 77 : 88}`),
        );
        assert.match(
          pending,
          /qualification_pending_run_url=https:\/\/github\.com\/f0rr0\/oliphaunt\/actions\/runs\//u,
        );
        assert.match(pending, /qualification_pending_run_attempt=1/u);
        assert.match(result.stderr, /resume automatically after qualification/u);
        assert.equal(command('prepare-release-pr.sh', undefined).status, 1);
      } else {
        assert.notEqual(result.status, 0);
        assert.ok(!existsSync(output), result.stdout);
      }
      if (['source', 'absent', 'feature', 'race', 'ambiguous'].includes(mode))
        assert.deepEqual(JSON.parse(readFileSync(dispatch, 'utf8')), { ref: 'main' });
      else assert.ok(!existsSync(dispatch));
    });
  }
});

test('one Prepare request retains pending Native intent and resumes the original producer after full proof', async () => {
  await fixture(async ({ root, source, git, write, command }) => {
    const workflow = Bun.YAML.parse(
      readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
    );
    const steps = workflow.jobs['qualify-prepare-source'].steps;
    const request = steps.find((step) => step.id === 'native_qualification');
    const record = steps.find((step) => step.id === 'prepare_intent');
    const upload = steps.find((step) => step.name === 'Retain pending Prepare intent');
    assert.equal(upload.with.name, '${{ steps.prepare_intent.outputs.artifact_name }}');
    assert.equal(upload.with['retention-days'], 30);
    const bin = path.join(root, '.git/bin');
    mkdirSync(bin);
    write(
      '.git/bin/gh',
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ ! -e "$FAKE_DISPATCH" ]] || exit 93\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --input ]]; then cp "$2" "$FAKE_DISPATCH"; break; fi; shift; done\nprintf \'{"workflow_run_id":88}\\n\'\n',
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const output = path.join(root, '.git/request-output');
    const env = isolatedGitHubTestEnvironment({
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
      GH_TOKEN: 'test-token',
      GH_REPO: 'f0rr0/oliphaunt',
      GITHUB_SHA: source,
      GITHUB_OUTPUT: output,
      BUN_OPTIONS: `--preload=${ROOT}/tools/release/testdata/require-workflow-success-github.mts`,
      FAKE_NATIVE_SHA: source,
      FAKE_MODE: 'native-absent',
      FAKE_DISPATCH: path.join(root, '.git/dispatch.json'),
      FAKE_LOG: path.join(root, '.git/reads'),
      OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '1',
    });
    const runRequest = () =>
      spawnSync('bash', ['-c', request.run], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, env });
    const pending = runRequest();
    assert.equal(pending.status, 0, pending.stderr);
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    assert.equal(outputs.run_id, undefined);
    assert.equal(outputs.qualification_pending_run_id, '88');
    assert.equal(command('prepare-release-pr.sh', undefined).status, 1);
    const intentFile = path.join(root, '.git/intent.json');
    const controller = nativePrepareContinuationFixture(
      source,
      git('rev-parse', 'HEAD^{tree}'),
      88,
    );
    const recorded = spawnSync(
      'bash',
      [
        '-c',
        record.run.replace(
          'tools/release/native-prepare-continuation.mts',
          `${ROOT}/tools/release/native-prepare-continuation.mts`,
        ),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: isolatedGitHubTestEnvironment({
          ...controller.state.environment,
          RUNNER_TEMP: path.dirname(intentFile),
          GITHUB_OUTPUT: path.join(root, '.git/intent-output'),
          NATIVE_PENDING_RUN_ID: outputs.qualification_pending_run_id,
          NATIVE_PENDING_RUN_ATTEMPT: outputs.qualification_pending_run_attempt,
        }),
      },
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(readFileSync(intentFile, 'utf8')), controller.state.intent);
    assert.equal(
      readFileSync(path.join(root, '.git/intent-output'), 'utf8'),
      'artifact_name=native-prepare-intent-1\n',
    );
    controller.state.native.status = 'in_progress';
    assert.deepEqual(await reconcileNativePrepare(controller.event('release'), controller.io), []);
    controller.state.native.status = 'completed';
    assert.equal((await reconcileNativePrepare(controller.event(), controller.io))[0].runId, 41);
    assert.deepEqual(controller.state.posts, [41]);
    assert.equal(controller.state.original.event, 'workflow_dispatch');
    assert.equal(controller.state.original.head_sha, source);
    env.FAKE_NATIVE_COMPLETE = 'true';
    env.GITHUB_OUTPUT = path.join(root, '.git/resumed-output');
    const resumed = runRequest();
    assert.equal(resumed.status, 0, resumed.stderr);
    const proof = /^run_id=(\d+)$/mu.exec(readFileSync(env.GITHUB_OUTPUT, 'utf8'))?.[1];
    assert.equal(proof, '88');
    assert.equal(command('prepare-release-pr.sh', proof).status, 0);
    assert.equal(git('rev-parse', 'HEAD'), source);
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_DISPATCH, 'utf8')), { ref: 'main' });
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
