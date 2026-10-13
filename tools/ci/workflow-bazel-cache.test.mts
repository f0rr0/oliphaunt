import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dir, '../..');
const action = Bun.YAML.parse(
  readFileSync(path.join(root, '.github/actions/bazel-cache/action.yml'), 'utf8'),
) as { runs: { steps: { id?: string; name: string; run?: string; with?: { key?: string } }[] } };
const script = (name: string) => {
  const step = action.runs.steps.find((step) => step.id === name || step.name === name);
  assert.ok(step?.run, `missing executable cache step ${name}`);
  return step.run;
};

// Render the actual action's output-only cache expression after executing its Shell step.
function cacheKey(name: string, output: string) {
  const step = action.runs.steps.find((step) => step.id === name || step.name === name);
  assert.ok(step?.with?.key);
  const values = Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  return step.with.key.replace(
    /\$\{\{\s*steps[.]identity[.]outputs[.](\w+)\s*\}\}/gu,
    (_match, name) => {
      assert.ok(
        Object.hasOwn(values, name),
        'Cache key references an absent actual identity output',
      );
      return values[name];
    },
  );
}

type FixtureEnvironment = NodeJS.ProcessEnv & {
  HOME: string;
  GITHUB_OUTPUT: string;
  SHUTDOWN_ARGS: string;
};

function fixture(run: (directory: string, env: FixtureEnvironment) => void) {
  const directory = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'bazel-cache-'));
  const home = path.join(directory, 'hosted home with spaces');
  const bin = path.join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(path.join(directory, 'tools/dev'), { recursive: true });
  writeFileSync(path.join(directory, '.bazelversion'), '8.8.1\r\n');
  writeFileSync(path.join(home, '.bazelrc'), '# existing hosted configuration\n');
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\nprintf "%s\\n" "$SOURCE_COMMIT"\n', {
    mode: 0o755,
  });
  writeFileSync(
    path.join(bin, 'cygpath'),
    '#!/usr/bin/env bash\ntest "$1" = -m\nprintf "%s\\n" "C:/hosted home/bazel-ci"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'du'),
    `#!/usr/bin/env bash\ncase "\${2##*/}" in disk) size="$DISK_KIB" ;; repositories) size="$REPOSITORY_KIB" ;; *) exit 1 ;; esac\nprintf "%s\\t%s\\n" "$size" "$2"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, 'tools/dev/bazel.sh'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SHUTDOWN_ARGS"\nexit "$SHUTDOWN_STATUS"\n',
  );
  const output = path.join(directory, 'outputs');
  writeFileSync(output, '');
  const env = {
    ...Object.fromEntries(
      ['TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GITHUB_OUTPUT: output,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    PHASE: 'restore',
    COHORT: 'portable',
    SOURCE_COMMIT: 'a'.repeat(40),
    REPOSITORY_GENERATION: 'c'.repeat(64),
    OUTPUT_BASE: '',
    JVM_ARGS: '',
    SERVER_LOG: '',
    DISK_CACHE_HIT: 'false',
    REPOSITORY_CACHE_HIT: 'false',
    DISK_KIB: '1',
    REPOSITORY_KIB: '1',
    SHUTDOWN_ARGS: path.join(directory, 'shutdown-args'),
    SHUTDOWN_STATUS: '0',
  };
  try {
    run(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const execute = (directory: string, env: NodeJS.ProcessEnv, source: string) =>
  execFileSync('bash', ['-eu', '-c', source], { cwd: directory, env, encoding: 'utf8' });

test('optional cache saves are bounded independently of qualification results', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(root, '.github/workflows/bazel.yml'), 'utf8'),
  );
  const saves = Object.values(workflow.jobs).flatMap((job: any) =>
    job.steps.filter(
      (step: any) => step.with?.phase === 'save' && step.uses === './.github/actions/bazel-cache',
    ),
  );
  assert.equal(saves.length, 8);
  for (const step of saves) {
    assert.equal(step['timeout-minutes'], 10);
    assert.equal(step['continue-on-error'], true);
    assert.equal(step.if, '$' + '{{ !cancelled() }}');
  }
});

test('action keys follow source while download keys reuse canonical acquisition generations', () => {
  fixture((directory, env) => {
    const identities = [];
    for (const variation of [
      {},
      { SOURCE_COMMIT: 'b'.repeat(40) },
      { COHORT: 'linux' },
      { RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' },
    ]) {
      writeFileSync(env.GITHUB_OUTPUT, '');
      execute(directory, { ...env, ...variation }, script('identity'));
      identities.push(readFileSync(env.GITHUB_OUTPUT, 'utf8'));
    }
    assert.equal(new Set(identities).size, identities.length);
    assert.match(identities[0], /-portable-8\.8\.1\nsource=a{40}\nrepository_generation=c{64}\n$/u);
    assert.notEqual(
      cacheKey('disk-restore', identities[0]),
      cacheKey('disk-restore', identities[1]),
    );
    assert.equal(
      cacheKey('repository-restore', identities[0]),
      cacheKey('repository-restore', identities[1]),
      'Source-only edits reuse the existing download cache',
    );
    assert.equal(
      cacheKey('repository-restore', identities[0]),
      cacheKey('Save bounded Bazel repository downloads', identities[0]),
    );
    writeFileSync(env.GITHUB_OUTPUT, '');
    execute(directory, { ...env, REPOSITORY_GENERATION: 'd'.repeat(64) }, script('identity'));
    const repinned = readFileSync(env.GITHUB_OUTPUT, 'utf8');
    assert.notEqual(
      cacheKey('repository-restore', repinned),
      cacheKey('repository-restore', identities[0]),
      'Changed acquisition generations persist new downloads',
    );
    assert.equal(cacheKey('disk-restore', repinned), cacheKey('disk-restore', identities[0]));
    for (const variation of [
      { PHASE: 'unknown' },
      { COHORT: 'portable/../linux' },
      { REPOSITORY_GENERATION: '' },
    ]) {
      const rejected = spawnSync('bash', ['-eu', '-c', script('identity')], {
        cwd: directory,
        env: { ...env, ...variation },
      });
      assert.notEqual(rejected.status, 0);
    }
  });
});

test('hosted cache configuration preserves user rc and quotes portable native paths', () => {
  for (const runnerOS of ['Linux', 'macOS', 'Windows']) {
    fixture((directory, env) => {
      execute(
        directory,
        { ...env, RUNNER_OS: runnerOS },
        script('Configure standard hosted Bazel caches'),
      );
      const rc = readFileSync(path.join(env.HOME, '.bazelrc'), 'utf8');
      assert.ok(rc.startsWith('# existing hosted configuration\n'));
      const cacheRoot =
        runnerOS === 'Windows'
          ? 'C:/hosted home/bazel-ci'
          : `${env.HOME}/.cache/oliphaunt/bazel-ci`;
      assert.ok(rc.includes(`build --disk_cache="${cacheRoot}/disk"\n`));
      assert.ok(rc.includes(`common --repository_cache="${cacheRoot}/repositories"\n`));
    });
  }
});

test('cache freeze stops exactly the configured writer before independent size decisions', () => {
  for (const scenario of [
    {
      name: 'default base',
      disk: '1',
      repositories: '1',
      expected: ['disk=true', 'repositories=true'],
    },
    {
      name: 'at both budgets',
      disk: '2097152',
      repositories: '2097152',
      expected: ['disk=true', 'repositories=true'],
    },
    { name: 'repository oversize', disk: '1', repositories: '2097153', expected: ['disk=true'] },
    {
      name: 'action oversize',
      disk: '2097153',
      repositories: '1',
      expected: ['repositories=true'],
    },
    {
      name: 'malformed repository size',
      disk: '1',
      repositories: 'invalid',
      expected: ['disk=true'],
    },
    {
      name: 'existing immutable action key',
      disk: '1',
      repositories: '1',
      diskHit: 'true',
      expected: ['repositories=true'],
    },
    { name: 'failed shutdown', disk: '1', repositories: '1', shutdown: '1', expected: [] },
  ]) {
    fixture((directory, env) => {
      execute(directory, env, script('Configure standard hosted Bazel caches'));
      const explicit = scenario.name !== 'default base';
      const outputBase = explicit ? path.join(directory, 'selected output base') : '';
      const serverLog = explicit ? path.join(directory, 'server output.log') : '';
      execute(
        directory,
        {
          ...env,
          OUTPUT_BASE: outputBase,
          JVM_ARGS: explicit ? '-Xmx3g' : '',
          SERVER_LOG: serverLog,
          DISK_CACHE_HIT: scenario.diskHit ?? 'false',
          DISK_KIB: scenario.disk,
          REPOSITORY_KIB: scenario.repositories,
          SHUTDOWN_STATUS: scenario.shutdown ?? '0',
        },
        script('ready'),
      );
      assert.deepEqual(
        readFileSync(env.SHUTDOWN_ARGS, 'utf8').trim().split('\n'),
        explicit
          ? [
              `--output_base=${outputBase}`,
              '--host_jvm_args=-Xmx3g',
              `--server_jvm_out=${serverLog}`,
              'shutdown',
            ]
          : ['shutdown'],
        scenario.name,
      );
      assert.deepEqual(
        readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n').filter(Boolean),
        scenario.expected,
        scenario.name,
      );
    });
  }
});
