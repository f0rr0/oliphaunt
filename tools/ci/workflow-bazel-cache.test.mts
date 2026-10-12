import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dir, '../..');
const action = Bun.YAML.parse(
  readFileSync(path.join(root, '.github/actions/bazel-cache/action.yml'), 'utf8'),
) as { runs: { steps: { id?: string; name: string; run?: string }[] } };
const script = (name: string) => {
  const step = action.runs.steps.find((step) => step.id === name || step.name === name);
  assert.ok(step?.run, `missing executable cache step ${name}`);
  return step.run;
};

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

test('cache identity follows the actual source, pinned Bazel and independent cohort', () => {
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
    assert.match(identities[0], /-portable-8\.8\.1\nsource=a{40}\n$/u);
    for (const variation of [{ PHASE: 'unknown' }, { COHORT: 'portable/../linux' }]) {
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
