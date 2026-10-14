import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = Bun.YAML.parse(
  readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/bazel.yml'), 'utf8'),
) as { jobs: Record<string, any> };
const { jobs } = workflow;
const needs = (id: string): string[] =>
  jobs[id].needs === undefined
    ? []
    : Array.isArray(jobs[id].needs)
      ? jobs[id].needs
      : [jobs[id].needs];

function predecessors(id: string, active = new Set<string>()): Set<string> {
  assert.ok(Object.hasOwn(jobs, id), `Unknown native workflow prerequisite: ${id}`);
  assert.ok(!active.has(id), `Native workflow dependency cycle: ${id}`);
  const stack = new Set(active).add(id);
  return new Set(needs(id).flatMap((parent) => [parent, ...predecessors(parent, stack)]));
}

test('native AOT hosts consume source-bound side-module and tools inputs and stay required', () => {
  assert.ok(predecessors('required').has('wasix-host'));
  assert.ok(predecessors('wasix-host').has('wasix'));
  const host = jobs['wasix-host'].steps.find((step: any) =>
    step.run?.includes('EXPECTED_SOURCE_COMMIT'),
  );
  assert.ok(host.run.includes('//src/wasix/sdks/rust:postgres_regression_test'));
  assert.ok(host.run.includes('//build_defs/wasix:host_aot_smoke_test'));
  assert.ok(
    host.run.includes('--repo_env=OLIPHAUNT_WASIX_SOURCE_COMMIT="$EXPECTED_SOURCE_COMMIT"'),
  );
  assert.ok(
    host.run.includes('--repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS="$RUNNER_TEMP/wasix-cargo-inputs"'),
  );
  const capture = jobs.wasix.steps.find(
    (step: any) => step.name === 'Capture final WASIX Cargo inputs for native hosts',
  );
  const expression = capture.run.match(/jq '([\s\S]*?)' /u)?.[1];
  assert.ok(expression, 'WASIX construction capture needs its actual source-owned root filter');
  const expected = [
    ['liboliphaunt-wasix', 'liboliphaunt-wasix-portable'],
    ['liboliphaunt-wasix', 'liboliphaunt-wasix-aot-aarch64-apple-darwin'],
    ['liboliphaunt-wasix', 'oliphaunt-extension-contrib-pg18-wasix'],
    ['liboliphaunt-wasix', 'oliphaunt-extension-contrib-pg18-aot-macos-arm64'],
    ['postgres-tools-wasix', 'oliphaunt-wasix-tools'],
    ['postgres-tools-wasix', 'oliphaunt-wasix-tools-aot-aarch64-apple-darwin'],
  ].map(([product, name]) => ({ package: { product, name, ecosystem: 'cargo' } }));
  const source = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
  const cohort = {
    executionRoot: '/actual/execution/root',
    aquery: { actions: [] },
    roots: [
      ...expected,
      { package: { product: 'oliphaunt-wasix-rust', name: 'oliphaunt-wasix', ecosystem: 'cargo' } },
      {
        package: {
          product: 'liboliphaunt-wasix',
          name: 'liboliphaunt-wasix-portable',
          ecosystem: 'npm',
        },
      },
      {
        package: { product: 'different-owner', name: 'oliphaunt-wasix-tools', ecosystem: 'cargo' },
      },
    ],
  };
  const filtered = JSON.parse(
    execFileSync('jq', [expression], {
      input: JSON.stringify({ source, cohorts: [cohort] }),
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(filtered, [{ ...cohort, source, roots: expected }]);
});

test('native package consumers follow their producers and remain required for admission', () => {
  for (const id of Object.keys(jobs)) predecessors(id);
  assert.ok(predecessors('react-native').has('portable'));
  assert.ok(predecessors('react-native').has('release-inputs'));
  assert.ok(!predecessors('release-families').has('react-native'));
  const required = predecessors('required');
  for (const [id, job] of Object.entries(jobs)) {
    if (job.steps.some((step: any) => step.run?.includes('qualify-native-shipping.mts')))
      assert.ok(required.has(id), `Native shipping producer omitted from admission: ${id}`);
  }
  const admission = jobs.required.steps.find(
    (step: any) => step.name === 'Require every native qualification job',
  );
  for (const [subject, outcome] of [
    ['', 'success'],
    ['react-native', 'failure'],
    ['release-families', 'failure'],
    ['wasix-host', 'failure'],
    ['react-native', 'skipped'],
    ['release-families', 'skipped'],
    ['wasix-host', 'skipped'],
  ]) {
    const results = Object.fromEntries(
      needs('required').map((id) => [id, { result: id === subject ? outcome : 'success' }]),
    );
    const result = spawnSync('bash', ['-eu', '-c', admission.run], {
      env: { ...process.env, NEEDS_JSON: JSON.stringify(results) },
    });
    assert.equal(result.status === 0, subject === '', result.stderr.toString());
  }
  const consumer = jobs['react-native'];
  assert.equal(consumer.if, undefined);
  const qualify = consumer.steps.filter((step: any) =>
    step.run?.includes('qualify-native-shipping.mts'),
  );
  assert.equal(qualify.length, 1);
  assert.equal(qualify[0].if, undefined);
  assert.equal(qualify[0]['continue-on-error'], undefined);
  assert.deepEqual(
    [...qualify[0].run.matchAll(/--shipping-export\s+(\S+)/gu)].map((match) => match[1]),
    ['//:native_react_native_shipping_export'],
  );
  const evidence = consumer.steps.filter(
    (step: any) => step.with?.name === 'native-build-evidence-react-native-macos-arm64',
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].if, undefined);
  assert.equal(evidence[0].with['if-no-files-found'], 'error');
  const linux = jobs.linux.steps.map((step: any) => step.run ?? '').join('\n');
  for (const name of ['package_test', 'installed_consumer_test'])
    assert.ok(!linux.includes(`//src/native/sdks/react-native:${name}`));
  assert.ok(linux.includes('//src/native/sdks/react-native:lifecycle_test'));
  const source = readFileSync(path.resolve(import.meta.dir, '../../BUILD.bazel'), 'utf8');
  const exports = (owner: string) => {
    const declaration = source.match(
      new RegExp(`shipping_export\\(\\n\\s*name = "${owner}",\\n([\\s\\S]*?)\\n\\)`, 'u'),
    );
    assert.ok(declaration, `Missing source-owned shipping export: ${owner}`);
    return new Set([...declaration[1].matchAll(/"(\/\/[^"\n]+)"/gu)].map((row) => row[1]));
  };
  const early = exports('native_shipping_export');
  const family = exports('release_family_shipping_export');
  for (const owner of [
    '//src/native/rust-bindings:shipping_export',
    '//src/native/sdks/rust:shipping_export',
    '//src/native/sdks/rust/crates/oliphaunt-build:shipping_export',
    '//src/native/broker:shipping_export',
  ]) {
    assert.ok(
      !early.has(owner),
      `Cargo installed consumer requested before all carriers: ${owner}`,
    );
    assert.ok(family.has(owner), `Cargo source owner lost its final qualification: ${owner}`);
  }
  for (const producer of [
    'portable',
    'linux',
    'wasix',
    'postmaster',
    'postmaster-host',
    'release-inputs',
  ])
    assert.ok(predecessors('release-families').has(producer));
  for (const owner of [
    '//src/native/rust-bindings:compiled_shipping_export',
    '//src/native/broker:native_shipping_export',
    '//src/query/rust:shipping_export',
    '//src/query/ts:shipping_export',
  ])
    assert.ok(early.has(owner), `Early source/compiled owner was unnecessarily deferred: ${owner}`);
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'release-families') continue;
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n');
    assert.ok(!commands.includes('//build_defs/languages/installed:consumer_test'));
    assert.ok(!commands.includes('//build_defs/languages/installed:consumer_minimum_test'));
  }
  qualifierFixture((directory, env) => {
    const step = jobs['release-families'].steps.find((step: any) =>
      step.run?.includes('--shipping-export //:release_family_shipping_export'),
    );
    const result = spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env });
    assert.equal(result.status, 0, result.stderr.toString());
    const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
    assert.equal(args[args.indexOf('--shipping-export') + 1], '//:release_family_shipping_export');
    const configuration = JSON.parse(
      readFileSync(
        path.join(env.RUNNER_TEMP, 'release-family-build-inputs/configuration.json'),
        'utf8',
      ),
    );
    assert.ok(configuration.includes('--platforms=//build_defs/native:linux_x86_64_glibc_2_28'));
    assert.ok(
      configuration.includes('--host_platform=//build_defs/native:linux_x86_64_glibc_2_28'),
    );
  });
});

test('WASIX probes share the complete opt qualification invocation', () => {
  const steps = jobs.wasix.steps.filter(
    (step: any) =>
      step.run?.includes('qualify-native-shipping.mts') ||
      step.run?.includes('tools/dev/bazel.sh test'),
  );
  qualifierFixture((directory, env) => {
    const calls = path.join(directory, 'wasix-calls');
    const chrome = path.join(directory, 'chrome');
    mkdirSync(env.RUNNER_TEMP, { recursive: true });
    writeFileSync(path.join(directory, 'tools/dev/bazel.sh'), 'exit 71\n');
    writeFileSync(
      path.join(directory, 'tools/dev/bun.sh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$WASIX_CALLS"
case "$1" in
  build_defs/wasix/browser/chrome-receipt.mts)
    printf '{}\\n' > "$2"
    printf '%s\\n' "$WASIX_CHROME" ;;
  tools/release/qualify-native-shipping.mts)
    printf '%s\\0' "$@" > "$QUALIFIER_ARGS"
    printf '%s\\n' "$OLIPHAUNT_NATIVE_PUBLICATION_INPUTS" > "$QUALIFIER_SOURCE"
    exit "\${QUALIFIER_STATUS:-0}" ;;
  *) exit 72 ;;
esac
`,
    );
    const execute = (status = '0') =>
      spawnSync('bash', ['-eu', '-c', steps.map((step: any) => step.run).join('\n')], {
        cwd: directory,
        env: {
          ...env,
          QUALIFICATION_JOB_NAME: jobs.wasix.name,
          WASIX_CALLS: calls,
          WASIX_CHROME: chrome,
          QUALIFIER_STATUS: status,
          OLIPHAUNT_NATIVE_PUBLICATION_INPUTS: path.join(directory, 'native-inputs.json'),
          ImageOS: 'ubuntu24',
          ImageVersion: 'fixture',
        },
      });
    const result = execute();
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
      'build_defs/wasix/browser/chrome-receipt.mts',
      'tools/release/qualify-native-shipping.mts',
    ]);
    const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
    const argument = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(argument('--shipping-export'), '//:wasix_shipping_export');
    assert.deepEqual(JSON.parse(readFileSync(argument('--complete-products-json'), 'utf8')), [
      'postgres-tools-wasix',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(argument('--targets-json'), 'utf8')), [
      '//build_defs/wasix:bridge_abi_test',
      '//build_defs/wasix:initdb_shim_abi_test',
      '//build_defs/wasix/postmaster:source_modes_test',
    ]);
    const configuration = JSON.parse(readFileSync(argument('--configuration-json'), 'utf8'));
    assert.deepEqual(configuration.slice(0, 3), ['-c', 'opt', '--config=wasix-aot']);
    assert.ok(!configuration.some((flag: string) => flag.startsWith('--jobs=')));
    assert.ok(configuration.includes('--local_test_jobs=1'));
    assert.ok(configuration.includes('--test_env=RUST_TEST_THREADS=1'));
    for (const flag of [
      '--platforms=//build_defs/native:linux_x86_64_glibc_2_28',
      '--host_platform=//build_defs/native:linux_x86_64_glibc_2_28',
      '--test_env=OLIPHAUNT_WASM_AOT_VERIFY=full',
      `--test_env=OLIPHAUNT_BROWSER_CHROME=${chrome}`,
      '--test_env=OLIPHAUNT_BROWSER_CHROME_RECEIPT=' +
        path.join(env.RUNNER_TEMP, 'chrome-host.json'),
    ])
      assert.ok(configuration.includes(flag), `Missing WASIX qualification option: ${flag}`);
    assert.ok(existsSync(path.join(env.RUNNER_TEMP, 'chrome-host.json')));
    assert.equal(
      readFileSync(env.QUALIFIER_SOURCE, 'utf8').trim(),
      path.join(directory, 'native-inputs.json'),
    );
    assert.equal(execute('7').status, 7);
  });
});

test('private Rust packaging source tests execute once on Linux x64', () => {
  const label = '//src/native/runtime/packaging:source_tests';
  const callers = Object.entries(jobs).flatMap(([id, job]) =>
    job.steps.filter((step: any) => step.run?.includes(label)).map((step: any) => ({ id, step })),
  );
  assert.equal(callers.length, 1);
  assert.equal(callers[0].id, 'linux');
  const { step } = callers[0];
  assert.equal(step.if, "matrix.platform == 'x86_64'");
  assert.equal(step['continue-on-error'], undefined);
  const directory = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-source-'));
  const argsFile = path.join(directory, 'args');
  try {
    mkdirSync(path.join(directory, 'tools/dev'), { recursive: true });
    writeFileSync(
      path.join(directory, 'tools/dev/bazel.sh'),
      `#!/usr/bin/env bash
printf "%s\\0" "$@" > "$SOURCE_ARGS"
exit "\${SOURCE_STATUS:-0}"
`,
    );
    const execute = (status = '0') =>
      spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: { PATH: process.env.PATH, SOURCE_ARGS: argsFile, SOURCE_STATUS: status },
      });
    const passed = execute();
    assert.equal(passed.status, 0, passed.stderr.toString());
    const args = readFileSync(argsFile, 'utf8').split('\0');
    assert.equal(args[0], 'test');
    assert.equal(args.filter((value) => value === label).length, 1);
    assert.ok(args.includes('--platforms=//build_defs/native:linux_x86_64_glibc_2_28'));
    assert.equal(execute('7').status, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('merge queue guards use resolved release commit facts and still reject unauthorized version changes', () => {
  const steps = jobs['release-inputs'].steps;
  const contextIndex = steps.findIndex((step: any) => step.id === 'context');
  const guardIndex = steps.findIndex(
    (step: any) => step.name === 'Check release-owned source versions',
  );
  const acquireIndex = steps.findIndex(
    (step: any) => step.name === 'Acquire completed public inputs once',
  );
  assert.ok(contextIndex >= 0 && contextIndex < guardIndex && guardIndex < acquireIndex);
  const step = steps[guardIndex];
  assert.equal(step.if, undefined);
  assert.equal(step.env.SOURCE_POLICY_HEAD, '$' + '{{ steps.context.outputs.source_policy_head }}');
  qualifierFixture((directory, env) => {
    mkdirSync(path.join(directory, '.github/scripts'), { recursive: true });
    mkdirSync(path.join(directory, 'bin'));
    symlinkSync(process.execPath, path.join(directory, 'bin/bun'));
    for (const file of ['check-release-intent.sh', 'release-intent-data.mts'])
      cpSync(
        path.resolve(import.meta.dir, '../../.github/scripts', file),
        path.join(directory, '.github/scripts', file),
      );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    const commit = (subject: string) => {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', subject);
      return git('rev-parse', 'HEAD');
    };
    writeFileSync(
      path.join(directory, 'release-please-config.json'),
      JSON.stringify({ 'changelog-sections': [{ type: 'fix' }] }),
    );
    writeFileSync(
      path.join(directory, '.release-please-manifest.json'),
      JSON.stringify({ owner: '1.0.0' }),
    );
    const base = commit('fix: source');
    const baseTree = git('rev-parse', 'HEAD^{tree}');
    writeFileSync(
      path.join(directory, '.release-please-manifest.json'),
      JSON.stringify({ owner: '1.0.1' }),
    );
    const prepared = commit('chore(release): owner 1.0.1');
    const queued = (tree: string) =>
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        'commit-tree',
        tree,
        '-p',
        base,
        '-m',
        'Merge queue synthetic title',
      );
    const releaseQueue = queued(git('rev-parse', 'HEAD^{tree}'));
    const ordinaryQueue = queued(baseTree);
    const execute = (head: string, policy = {}) =>
      spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: {
          ...env,
          PATH: `${path.join(directory, 'bin')}${path.delimiter}${env.PATH}`,
          PR_TITLE: '',
          BASE_REF: base,
          HEAD_REF: head,
          HEAD_BRANCH: 'gh-readonly-queue/main/pr-295-aabbcc',
          CI_EVENT_NAME: 'merge_group',
          CI_FULL_REF: 'refs/heads/gh-readonly-queue/main/pr-295-aabbcc',
          SOURCE_POLICY_SUBJECT: '',
          SOURCE_POLICY_BASE: '',
          SOURCE_POLICY_HEAD: '',
          SOURCE_POLICY_BRANCH: '',
          ...policy,
        },
      });
    const ordinary = execute(ordinaryQueue);
    assert.equal(ordinary.status, 0, ordinary.stderr.toString());
    assert.notEqual(execute(releaseQueue).status, 0);
    const policy = {
      SOURCE_POLICY_SUBJECT: 'chore(release): owner 1.0.1',
      SOURCE_POLICY_BASE: base,
      SOURCE_POLICY_HEAD: prepared,
      SOURCE_POLICY_BRANCH: 'release-please--branches--main',
    };
    const release = execute(releaseQueue, policy);
    assert.equal(release.status, 0, release.stderr.toString());
    assert.notEqual(
      execute(releaseQueue, { ...policy, SOURCE_POLICY_BRANCH: 'feature' }).status,
      0,
    );
  });
});

type FixtureEnvironment = NodeJS.ProcessEnv & {
  RUNNER_TEMP: string;
  QUALIFIER_ARGS: string;
  QUALIFIER_SOURCE: string;
};

function qualifierFixture(run: (directory: string, env: FixtureEnvironment) => void) {
  const directory = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-workflow-'));
  const env = {
    PATH: process.env.PATH,
    RUNNER_TEMP: path.join(directory, 'runner temp'),
    GITHUB_WORKSPACE: directory,
    GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
    GITHUB_WORKFLOW: 'Native Bazel qualification',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    QUALIFICATION_JOB_NAME: 'Portable packages (macos-arm64)',
    QUALIFIER_ARGS: path.join(directory, 'qualifier-args'),
    QUALIFIER_SOURCE: path.join(directory, 'qualifier-source'),
  };
  mkdirSync(path.join(directory, 'tools/dev'), { recursive: true });
  writeFileSync(
    path.join(directory, 'tools/dev/bun.sh'),
    `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$QUALIFIER_ARGS"
printf '%s\\n' "\${OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT-}" "\${OLIPHAUNT_MOBILE_CANDIDATE_SHA-}" "\${OLIPHAUNT_MOBILE_CANDIDATE_TREE-}" > "$QUALIFIER_SOURCE"
`,
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', 'tools/dev/bun.sh');
  git(
    '-c',
    'user.name=Workflow fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  try {
    run(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Apple preparation and final admission use the authenticated input phase', () => {
  const step = jobs.portable.steps.find(
    (step: any) =>
      step.name === 'Qualify complete Apple runtime, resources, SDK and extension packages',
  );
  assert.equal(
    step.env.NATIVE_PREPARED_INPUTS,
    '$' + '{{ needs.release-inputs.outputs.native_inputs }}',
  );
  for (const [input, target] of [
    ['false', '//:native_apple_preparation_export'],
    ['true', '//:native_apple_shipping_export'],
    ['unverified', undefined],
  ]) {
    qualifierFixture((directory, env) => {
      const result = spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: { ...env, NATIVE_PREPARED_INPUTS: input },
      });
      if (!target) {
        assert.notEqual(result.status, 0);
        return;
      }
      assert.equal(result.status, 0, result.stderr.toString());
      const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
      assert.equal(args[args.indexOf('--shipping-export') + 1], target);
    });
  }
});

test('Android qualification constructs ARM and installs the exact x64 APK once', () => {
  const step = jobs.linux.steps.find((step: any) =>
    step.run?.includes('--shipping-export //:native_android_shipping_export'),
  );
  assert.equal(step.if, "matrix.platform == 'x86_64'");
  assert.equal(step['continue-on-error'], undefined);
  qualifierFixture((directory, env) => {
    const result = spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env });
    assert.equal(result.status, 0, result.stderr.toString());
    const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
    const targets = JSON.parse(readFileSync(args[args.indexOf('--targets-json') + 1], 'utf8'));
    for (const label of [
      '//src/examples/native/react-native-expo:android_release',
      '//src/examples/native/react-native-expo:android_installed_test',
    ])
      assert.equal(targets.filter((target: string) => target === label).length, 1);
    assert.ok(!targets.includes('//src/examples/native/react-native-expo:android_release_x86_64'));
    const configuration = JSON.parse(
      readFileSync(
        path.join(env.RUNNER_TEMP, 'android-extension-build-inputs/configuration.json'),
        'utf8',
      ),
    );
    assert.ok(configuration.every((flag: string) => !flag.startsWith('--test_env=')));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, env, encoding: 'utf8' }).trim();
    assert.deepEqual(readFileSync(env.QUALIFIER_SOURCE, 'utf8').trim().split('\n'), [
      directory,
      git('rev-parse', 'HEAD'),
      git('rev-parse', 'HEAD^{tree}'),
    ]);
    writeFileSync(path.join(directory, 'tools/dev/bun.sh'), '# tracked mutation\n');
    assert.notEqual(spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env }).status, 0);
    assert.ok(predecessors('required').has('linux'));
  });
});

test('Required audits completed construction only after every producer succeeds', () => {
  const required = jobs.required;
  const [guard, checkout, runtime, inputs, audit] = required.steps;
  assert.equal(required.steps.length, 5);
  assert.equal(guard.env.NEEDS_JSON, '$' + '{{ toJSON(needs) }}');
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/u);
  assert.equal(checkout.with.ref, '$' + '{{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(runtime.uses, './.github/actions/setup-node-bun');
  assert.equal(inputs.uses, './.github/actions/native-release-inputs');
  assert.deepEqual(
    inputs.with,
    jobs.linux.steps.find((step: any) => step.uses === inputs.uses).with,
  );
  assert.equal(audit.env.GH_TOKEN, '$' + '{{ github.token }}');
  for (const step of required.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
  qualifierFixture((directory, env) => {
    const wrapperArgs = path.join(directory, 'wrapper-args');
    const acquisition = path.join(directory, 'acquisition-started');
    const snapshot = path.join(directory, 'native-inputs.json');
    mkdirSync(path.join(directory, 'tools/release'), { recursive: true });
    writeFileSync(
      path.join(directory, 'tools/release/with-source.sh'),
      `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$AUDIT_WRAPPER_ARGS"
shift
exec "$@"
`,
    );
    writeFileSync(
      path.join(directory, 'tools/dev/bun.sh'),
      `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$QUALIFIER_ARGS"
printf '%s\\n' "$OLIPHAUNT_NATIVE_PUBLICATION_INPUTS" > "$QUALIFIER_SOURCE"
exit "\${AUDIT_STATUS:-0}"
`,
    );
    const execute = (result: string, status = '0') => {
      for (const file of [wrapperArgs, acquisition, env.QUALIFIER_ARGS, env.QUALIFIER_SOURCE])
        rmSync(file, { force: true });
      return spawnSync(
        'bash',
        ['-eu', '-c', `${guard.run}\nprintf acquired > "$AUDIT_ACQUISITION"\n${audit.run}`],
        {
          cwd: directory,
          env: {
            ...env,
            NEEDS_JSON: JSON.stringify(
              Object.fromEntries(
                needs('required').map((id, index) => [
                  id,
                  { result: index === 1 ? result : 'success' },
                ]),
              ),
            ),
            GITHUB_REF: 'refs/pull/42/merge',
            OLIPHAUNT_NATIVE_PUBLICATION_INPUTS: snapshot,
            AUDIT_WRAPPER_ARGS: wrapperArgs,
            AUDIT_ACQUISITION: acquisition,
            AUDIT_STATUS: status,
          },
        },
      );
    };
    const passed = execute('success');
    assert.equal(passed.status, 0, passed.stderr.toString());
    assert.equal(readFileSync(wrapperArgs, 'utf8').split('\0')[0], 'HEAD');
    assert.deepEqual(readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0').slice(0, -1), [
      'tools/release/audit-native-construction.mts',
      '--run-id',
      env.GITHUB_RUN_ID,
      '--ref',
      'refs/pull/42/merge',
      '--output-directory',
      path.join(env.RUNNER_TEMP, 'native-construction-audit'),
    ]);
    assert.equal(readFileSync(env.QUALIFIER_SOURCE, 'utf8').trim(), snapshot);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.notEqual(execute(result).status, 0);
      assert.equal(existsSync(acquisition), false);
      assert.equal(existsSync(wrapperArgs), false);
    }
    assert.equal(execute('success', '7').status, 7);
  });
});

test('only the installed mobile test receives the actual clean candidate checkout identity', () => {
  const step = jobs['react-native'].steps.find(
    (step: any) => step.name === 'Qualify final React Native package and installed iOS consumer',
  );
  qualifierFixture((directory, env) => {
    mkdirSync(path.join(env.RUNNER_TEMP, 'react-native-build-inputs'), { recursive: true });
    const execute = () => spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env });
    const passed = execute();
    assert.equal(passed.status, 0, passed.stderr.toString());
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, env, encoding: 'utf8' }).trim();
    assert.deepEqual(readFileSync(env.QUALIFIER_SOURCE, 'utf8').trim().split('\n'), [
      directory,
      git('rev-parse', 'HEAD'),
      git('rev-parse', 'HEAD^{tree}'),
    ]);
    const configuration = JSON.parse(
      readFileSync(
        path.join(env.RUNNER_TEMP, 'react-native-build-inputs/configuration.json'),
        'utf8',
      ),
    );
    assert.ok(configuration.every((flag: string) => !flag.startsWith('--test_env=')));
    writeFileSync(path.join(directory, 'tools/dev/bun.sh'), '# tracked mutation\n');
    assert.notEqual(execute().status, 0);
  });
});

test('the Linux installed APK owns its emulator and requires provisioned KVM', () => {
  const step = jobs.linux.steps.find(
    (step: any) => step.name === 'Provision KVM for the exact installed Android APK test',
  );
  assert.equal(step.if, "matrix.platform == 'x86_64'");
  assert.equal(step['continue-on-error'], undefined);
  assert.ok(step.run.includes('test -c /dev/kvm'));
  assert.ok(step.run.includes('test -r /dev/kvm && test -w /dev/kvm'));
  assert.ok(!step.run.includes('sdkmanager') && !step.run.includes('emulator -'));
});

test('native qualification supports protected merge groups with the same required construction gate', () => {
  const source = Bun.YAML.parse(
    readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/bazel.yml'), 'utf8'),
  ) as any;
  assert.deepEqual(source.on.merge_group.types, ['checks_requested']);
  assert.equal(jobs.required.name, 'Required');
  assert.ok(predecessors('required').has('release-inputs'));
});

test('postmaster host scheduling keeps native tests serial and Linux guest inputs unchanged', () => {
  const job = jobs['postmaster-host'];
  const diagnostics = job.steps.find(
    (step: any) => step.name === 'Upload native postmaster build and query diagnostics',
  );
  assert.equal(diagnostics.if, 'always()');
  assert.equal(
    diagnostics.with.path,
    '$' + '{{ runner.temp }}/postmaster-build-capture/diagnostics/',
  );
  assert.equal(
    job['timeout-minutes'],
    '$' + "{{ matrix.platform == 'macos-arm64' && 180 || 120 }}",
  );
  const step = job.steps.find(
    (step: any) => step.name === 'Qualify native carrier from authenticated Linux guest',
  );
  const start = step.run.indexOf('jq -nc --arg compiler "$TARGET_COMPILER"');
  const end = step.run.indexOf('jq -nc --arg prefix "$TARGET_PREFIX"', start);
  assert.ok(start >= 0 && end > start, 'Missing actual host configuration generator');
  qualifierFixture((directory, env) => {
    const inputRoot = path.join(directory, 'host inputs');
    mkdirSync(inputRoot);
    for (const platform of ['macos-arm64', 'linux-arm64']) {
      const compiler =
        platform === 'macos-arm64'
          ? '//src/wasix/postmaster:native_macos_arm64'
          : '//src/wasix/postmaster:compiler_linux_arm64';
      const archive = path.join(directory, 'original-linux-x64-gnu.tar.zst');
      const result = spawnSync(
        'bash',
        ['-eu', '-c', `input_root="$HOST_INPUT_ROOT"\n${step.run.slice(start, end)}`],
        {
          cwd: directory,
          env: {
            ...env,
            HOST_INPUT_ROOT: inputRoot,
            TARGET_PLATFORM: platform,
            TARGET_COMPILER: compiler,
            archive,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(inputRoot, 'configuration.json'), 'utf8')),
        [
          '-c',
          'opt',
          '--platforms=//build_defs/wasix:portable',
          `--host_platform=${compiler}`,
          `--extra_execution_platforms=${compiler}`,
          platform === 'macos-arm64' ? '--jobs=2' : '--jobs=1',
          '--local_test_jobs=1',
          `--repo_env=OLIPHAUNT_POSTMASTER_GUEST_ARCHIVE=${archive}`,
          ...(platform === 'macos-arm64' ? ['--config=macos-sandbox'] : []),
        ],
        `${platform} actual qualification configuration`,
      );
    }
  });
});

test('every native CLI producer installs the conventional frozen release-tools workspace before capture', () => {
  const action = Bun.YAML.parse(
    readFileSync(
      path.resolve(import.meta.dir, '../../.github/actions/native-release-inputs/action.yml'),
      'utf8',
    ),
  ) as any;
  const command =
    'bash tools/dev/bun.sh install --frozen-lockfile --filter @oliphaunt/release-tools --ignore-scripts';
  const installs = action.runs.steps.filter((step: any) => step.run?.trim() === command);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].if, undefined);
  assert.equal(installs[0]['continue-on-error'], undefined);
  const firstImport = action.runs.steps.findIndex((step: any) =>
    step.run?.includes('native-release-inputs.mts'),
  );
  assert.ok(action.runs.steps.indexOf(installs[0]) < firstImport);
  for (const job of Object.values(jobs)) {
    assert.ok(
      !job.steps.some((step: any) => step.run?.includes(command)),
      'Shared tooling must install once per job',
    );
    const capture = job.steps.findIndex((step: any) =>
      step.run?.includes('qualify-native-shipping.mts'),
    );
    if (capture < 0) continue;
    const acquisition = job.steps.findIndex(
      (step: any) => step.uses === './.github/actions/native-release-inputs',
    );
    assert.ok(acquisition >= 0 && acquisition < capture);
  }
});
