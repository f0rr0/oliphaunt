import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dir, '../..');
const action = Bun.YAML.parse(
  readFileSync(path.join(root, '.github/actions/bazel-cache/action.yml'), 'utf8'),
) as {
  inputs: Record<string, unknown>;
  runs: {
    steps: {
      id?: string;
      name: string;
      uses?: string;
      if?: string;
      run?: string;
      with?: { key?: string; path?: string };
    }[];
  };
};
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
  COMMAND_TRACE: string;
  GC_ARGS: string;
  GC_TOOL: string;
};

function fixture(run: (directory: string, env: FixtureEnvironment) => void) {
  const directory = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'bazel-cache-'));
  const home = path.join(directory, 'hosted home with spaces');
  const bin = path.join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  const disk = path.join(home, '.cache/oliphaunt/bazel-ci/disk/cas');
  mkdirSync(disk, { recursive: true });
  writeFileSync(path.join(disk, 'retained-result'), 'completed partial cache entry');
  mkdirSync(path.join(directory, 'tools/dev'), { recursive: true });
  writeFileSync(path.join(directory, '.bazelversion'), '8.8.1\r\n');
  writeFileSync(path.join(home, '.bazelrc'), '# existing hosted configuration\n');
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\nprintf "%s\\n" "$SOURCE_COMMIT"\n', {
    mode: 0o755,
  });
  writeFileSync(
    path.join(bin, 'cygpath'),
    '#!/usr/bin/env bash\ntest "$1" = -m\ncase "${2##*/}" in disk) printf "%s\\n" "C:/hosted home/bazel-ci/disk" ;; *) printf "%s\\n" "C:/hosted home/bazel-ci" ;; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, 'du'),
    `#!/usr/bin/env bash\ntest "\${2##*/}" = disk\nsize="$DISK_KIB"\n[[ ! -f "$DISK_SIZE_FILE" ]] || size="$(cat "$DISK_SIZE_FILE")"\nprintf "%s\\t%s\\n" "$size" "$2"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, 'tools/dev/bazel.sh'),
    `#!/usr/bin/env bash
set -eu
for argument in "$@"; do
  case "$argument" in build|cquery|shutdown) fixture_command="$argument"; break ;; esac
done
printf '%s\\n' "$fixture_command" >> "$COMMAND_TRACE"
case "$fixture_command" in
  build) printf '%s\\n' "$@" > "$BUILD_ARGS"; exit "$BUILD_STATUS" ;;
  cquery) printf '%s\\n' "$@" > "$QUERY_ARGS"; printf '%s\\n' "$GC_TOOL"; exit "$QUERY_STATUS" ;;
  shutdown)
    printf '%s\\n' "$@" > "$SHUTDOWN_ARGS"
    fixture_shutdowns=0
    while read -r fixture_line; do
      [[ "$fixture_line" != shutdown ]] || fixture_shutdowns=$((fixture_shutdowns + 1))
    done < "$COMMAND_TRACE"
    [[ "$fixture_shutdowns" != 2 ]] || exit "$SECOND_SHUTDOWN_STATUS"
    exit "$SHUTDOWN_STATUS" ;;
esac
`,
  );
  const gcTool = path.join(bin, 'stock gc fixture');
  writeFileSync(
    gcTool,
    `#!/usr/bin/env bash
set -eu
test "$(tail -n 1 "$COMMAND_TRACE")" = shutdown
test -z "\${JAVABIN:-}"
printf '%s\\n' "$@" > "$GC_ARGS"
printf 'gc begin\\n' >> "$COMMAND_TRACE"
if [[ "$GC_STATUS" != 0 ]]; then exit "$GC_STATUS"; fi
sleep 0.03
printf '%s\\n' "$GC_DISK_KIB" > "$DISK_SIZE_FILE"
printf 'gc done\\n' >> "$COMMAND_TRACE"
`,
    { mode: 0o755 },
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
    COHORT: 'react-native',
    SOURCE_COMMIT: 'a'.repeat(40),
    OUTPUT_BASE: '',
    JVM_ARGS: '',
    SERVER_LOG: '',
    DISK_KIB: '1',
    SHUTDOWN_ARGS: path.join(directory, 'shutdown-args'),
    SHUTDOWN_STATUS: '0',
    SECOND_SHUTDOWN_STATUS: '0',
    COMMAND_TRACE: path.join(directory, 'command-trace'),
    GC_ARGS: path.join(directory, 'gc-args'),
    GC_TOOL: gcTool,
    GC_STATUS: '0',
    GC_DISK_KIB: '1',
    DISK_SIZE_FILE: path.join(directory, 'disk-size'),
    BUILD_ARGS: path.join(directory, 'build-args'),
    BUILD_STATUS: '0',
    QUERY_ARGS: path.join(directory, 'query-args'),
    QUERY_STATUS: '0',
  };
  try {
    run(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Supply the same internal outputs that Actions passes between the real Shell steps.
function selectedBudget(directory: string, env: NodeJS.ProcessEnv) {
  const output = path.join(directory, 'budget-outputs');
  writeFileSync(output, '');
  execFileSync('bash', ['-eu', '-c', script('identity')], {
    cwd: directory,
    env: { ...env, GITHUB_OUTPUT: output },
  });
  const selected = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  return {
    ...env,
    GC_MAX_SIZE: selected.gc_max_size,
    CACHE_LIMIT_KIB: selected.cache_limit_kib,
  };
}

const execute = (directory: string, env: NodeJS.ProcessEnv, source: string) =>
  execFileSync('bash', ['-eu', '-c', source], {
    cwd: directory,
    env: source === script('identity') ? env : selectedBudget(directory, env),
    encoding: 'utf8',
  });

test('optional terminal cache saves preserve restore policy, writer bounds and source identity', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(root, '.github/workflows/bazel.yml'), 'utf8'),
  );
  const callers = Object.values(workflow.jobs).flatMap((job: any) =>
    job.steps.filter((step: any) => step.uses === './.github/actions/bazel-cache'),
  );
  for (const step of callers) {
    for (const name of Object.keys(step.with))
      assert.ok(Object.hasOwn(action.inputs, name), `Unknown cache action input: ${name}`);
  }
  const transports = action.runs.steps.filter((step) => step.uses?.startsWith('actions/cache/'));
  assert.equal(transports.length, 2);
  for (const step of transports) assert.equal(step.with?.path, '~/.cache/oliphaunt/bazel-ci/disk');
  assert.equal(
    action.runs.steps.find((step) => step.id === 'ready')?.if,
    '$' +
      "{{ always() && inputs.phase == 'save' && steps.identity.outcome == 'success' && inputs.disk-cache-hit != 'true' }}",
  );
  assert.equal(
    action.runs.steps.find((step) => step.id === 'identity')?.if,
    '$' + "{{ inputs.phase == 'save' || !cancelled() }}",
  );
  assert.equal(
    action.runs.steps.find((step) => step.id === 'disk-restore')?.if,
    "inputs.phase == 'restore'",
  );
  assert.equal(
    action.runs.steps.find((step) => step.name === 'Configure standard hosted Bazel caches')?.if,
    "inputs.phase == 'restore'",
  );
  assert.equal(
    action.runs.steps.find((step) => step.name === 'Save bounded Bazel action cache')?.if,
    '$' + "{{ always() && inputs.phase == 'save' && steps.ready.outputs.disk == 'true' }}",
  );
  const saves = callers.filter((step: any) => step.with.phase === 'save');
  assert.equal(saves.length, 8);
  for (const step of saves) {
    assert.equal(step['timeout-minutes'], 10);
    assert.equal(step['continue-on-error'], true);
    assert.equal(step.if, '$' + '{{ always() }}');
  }
});

test('action keys retain source, cohort and platform separation', () => {
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
    assert.match(identities[0], /-react-native-8\.8\.1\nsource=a{40}\n/u);
    assert.equal(
      new Set(identities.map((identity) => cacheKey('disk-restore', identity))).size,
      identities.length,
    );
    assert.equal(
      cacheKey('disk-restore', identities[0]),
      cacheKey('Save bounded Bazel action cache', identities[0]),
    );
    for (const variation of [
      { PHASE: 'unknown' },
      { COHORT: 'portable/../linux' },
      { SOURCE_COMMIT: 'invalid' },
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
  const cacheConfiguration = readFileSync(path.join(root, '.bazelrc'), 'utf8')
    .split('\n')
    .filter((line) => /^build:ci-cache\s/u.test(line))
    .join('\n');
  assert.doesNotMatch(cacheConfiguration, /--experimental_disk_cache_gc_/u);
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
      assert.doesNotMatch(rc, /--experimental_disk_cache_gc_/u);
    });
  }
});

test('cache freeze stops exactly the configured writer before the action archive size decision', () => {
  for (const scenario of [
    { name: 'default base', disk: '1', expected: ['disk=true'] },
    { name: 'at allocated budget', disk: '3145728', expected: ['disk=true'] },
    { name: 'observed WASIX allocation overhead', disk: '2118144', expected: ['disk=true'] },
    { name: 'action oversize', disk: '3145729', expected: [] },
    { name: 'malformed action size', disk: 'invalid', expected: [] },
    { name: 'missing action cache', disk: '1', missing: true, expected: [] },
    { name: 'allocated empty cache', disk: '4', empty: true, expected: [] },
    { name: 'directory-only cache', disk: '8', empty: true, nested: true, expected: [] },
    { name: 'unused macOS cache', disk: '4', empty: true, os: 'macOS', expected: [] },
    { name: 'unused Windows cache', disk: '4', empty: true, os: 'Windows', expected: [] },
    { name: 'failed shutdown', disk: '1', shutdown: '1', expected: [] },
  ]) {
    fixture((directory, env) => {
      const hosted = { ...env, RUNNER_OS: scenario.os ?? env.RUNNER_OS };
      execute(directory, hosted, script('Configure standard hosted Bazel caches'));
      const disk = path.join(env.HOME, '.cache/oliphaunt/bazel-ci/disk');
      if (scenario.empty) {
        rmSync(disk, { recursive: true });
        mkdirSync(scenario.nested ? path.join(disk, 'cas/empty') : disk, { recursive: true });
      }
      if (scenario.missing) rmSync(disk, { recursive: true });
      const explicit = scenario.name !== 'default base';
      const outputBase = explicit ? path.join(directory, 'selected output base') : '';
      const serverLog = explicit ? path.join(directory, 'server output.log') : '';
      execute(
        directory,
        {
          ...hosted,
          OUTPUT_BASE: outputBase,
          JVM_ARGS: explicit ? '-Xmx3g' : '',
          SERVER_LOG: serverLog,
          DISK_KIB: scenario.disk,
          GC_DISK_KIB: scenario.disk,
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
      if (scenario.disk !== '3145729')
        assert.equal(readFileSync(env.COMMAND_TRACE, 'utf8'), 'shutdown\n', scenario.name);
      assert.deepEqual(
        readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n').filter(Boolean),
        scenario.expected,
        scenario.name,
      );
    });
  }
});

test('oversized snapshots use completed stock GC after freezing its utility writer', () => {
  for (const runnerOS of ['Linux', 'macOS', 'Windows']) {
    fixture((directory, env) => {
      execute(directory, env, script('Configure standard hosted Bazel caches'));
      execute(
        directory,
        {
          ...env,
          RUNNER_OS: runnerOS,
          DISK_KIB: '5865772',
          GC_DISK_KIB: '2118144',
          JAVABIN: '/ambient/java',
        },
        script('ready'),
      );
      assert.equal(
        readFileSync(env.COMMAND_TRACE, 'utf8'),
        'shutdown\nbuild\ncquery\nshutdown\ngc begin\ngc done\n',
      );
      assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'disk=true\n');
      assert.deepEqual(readFileSync(env.GC_ARGS, 'utf8').trim().split('\n'), [
        `--disk_cache=${runnerOS === 'Windows' ? 'C:/hosted home/bazel-ci/disk' : path.join(env.HOME, '.cache/oliphaunt/bazel-ci/disk')}`,
        '--max_size=2G',
      ]);
      assert.deepEqual(
        readFileSync(path.join(directory, 'build-args'), 'utf8').trim().split('\n'),
        ['build', '--jobs=2', '//tools/ci:bazel_disk_cache_gc'],
      );
    });
  }
});

test('GC failures and logical-versus-allocated overage do not authorize transport', () => {
  for (const scenario of [
    { BUILD_STATUS: '1' },
    { QUERY_STATUS: '1' },
    { SECOND_SHUTDOWN_STATUS: '1' },
    { GC_STATUS: '1' },
    { GC_DISK_KIB: '3145729' },
    { GC_DISK_KIB: 'invalid' },
  ]) {
    fixture((directory, env) => {
      execute(directory, env, script('Configure standard hosted Bazel caches'));
      const result = spawnSync('bash', ['-eu', '-c', script('ready')], {
        cwd: directory,
        env: selectedBudget(directory, { ...env, DISK_KIB: '5865772', ...scenario }),
      });
      if (scenario.BUILD_STATUS || scenario.QUERY_STATUS || scenario.GC_STATUS)
        assert.notEqual(result.status, 0);
      assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), '');
    });
  }
});

test('measured cohorts retain their observed cache population within a bounded archive', () => {
  for (const cohort of [
    { RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', COHORT: 'portable' },
    { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', COHORT: 'portable' },
    { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', COHORT: 'linux' },
  ]) {
    for (const scenario of [
      { name: '3.6 GiB allocated snapshot', disk: '3774874', gc: false, saved: true },
      { name: 'allocated boundary', disk: '5242880', gc: false, saved: true },
      {
        name: 'completed collection',
        disk: '5242881',
        gc: true,
        collected: '4404019',
        saved: true,
      },
      {
        name: 'allocated overage after collection',
        disk: '5242881',
        gc: true,
        collected: '5242881',
        saved: false,
      },
      { name: 'failed collection', disk: '5242881', gc: true, status: '1', saved: false },
    ]) {
      fixture((directory, env) => {
        const label = `${cohort.COHORT} ${cohort.RUNNER_OS} ${scenario.name}`;
        const measured = { ...env, ...cohort };
        execute(directory, measured, script('Configure standard hosted Bazel caches'));
        const result = spawnSync('bash', ['-eu', '-c', script('ready')], {
          cwd: directory,
          env: selectedBudget(directory, {
            ...measured,
            DISK_KIB: scenario.disk,
            GC_DISK_KIB: scenario.collected ?? scenario.disk,
            GC_STATUS: scenario.status ?? '0',
          }),
        });
        assert.equal(result.status, scenario.status ? 1 : 0, label);
        assert.equal(
          readFileSync(env.GITHUB_OUTPUT, 'utf8'),
          scenario.saved ? 'disk=true\n' : '',
          label,
        );
        const commands = readFileSync(env.COMMAND_TRACE, 'utf8');
        if (scenario.gc) {
          assert.ok(commands.startsWith('shutdown\nbuild\ncquery\nshutdown\ngc begin\n'), label);
          assert.equal(
            readFileSync(env.GC_ARGS, 'utf8').trim().split('\n').at(-1),
            '--max_size=4G',
          );
        } else {
          assert.equal(commands, 'shutdown\n', label);
        }
      });
    }
  }
});

test('other Apple cohorts keep the standard hosted cache budget', () => {
  fixture((directory, env) => {
    const other = {
      ...env,
      RUNNER_OS: 'macOS',
      RUNNER_ARCH: 'ARM64',
      COHORT: 'react-native',
    };
    execute(directory, other, script('Configure standard hosted Bazel caches'));
    execute(directory, { ...other, DISK_KIB: '3565159', GC_DISK_KIB: '2118144' }, script('ready'));
    assert.equal(readFileSync(env.GC_ARGS, 'utf8').trim().split('\n').at(-1), '--max_size=2G');
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'disk=true\n');
  });
});
