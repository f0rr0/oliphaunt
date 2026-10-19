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
import { runInNewContext } from 'node:vm';

const workflow = Bun.YAML.parse(
  readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/bazel.yml'), 'utf8'),
) as { env: Record<string, string>; jobs: Record<string, any> };
const { jobs } = workflow;
const needs = (id: string): string[] =>
  jobs[id].needs === undefined
    ? []
    : Array.isArray(jobs[id].needs)
      ? jobs[id].needs
      : [jobs[id].needs];

function requestEnvironment(step: any, env: NodeJS.ProcessEnv, platform: string) {
  return {
    ...env,
    CI_PLATFORM: platform,
    ...Object.fromEntries(
      Object.entries(step.env ?? {})
        .filter(([name]) => name.startsWith('CI_'))
        .map(([name, value]) => [
          name,
          String(value).replace(/\$\{\{\s*matrix\.platform\s*\}\}/gu, platform),
        ]),
    ),
  };
}

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
    host.run.includes('"--repo_env=OLIPHAUNT_WASIX_SOURCE_COMMIT=$EXPECTED_SOURCE_COMMIT"'),
  );
  assert.ok(
    host.run.includes('"--repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS=$RUNNER_TEMP/wasix-cargo-inputs"'),
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

test('NAPI shipping shares the Linux WASIX producer and imported native host lanes', () => {
  const name = 'Qualify final WASIX addon on its native host';
  assert.ok(!jobs.portable.steps.some((step: any) => step.name === name));
  const producer = jobs.wasix.steps.find((step: any) =>
    step.run?.includes('--shipping-export //:wasix_shipping_export'),
  );
  assert.equal(producer.env.CI_REQUEST_ID, 'wasix/tools-sdk-browser');
  const root = readFileSync(path.resolve(import.meta.dir, '../../BUILD.bazel'), 'utf8');
  const wasix = root.match(/shipping_export\(\s*name = "wasix_shipping_export",([\s\S]*?)\n\)/u);
  assert.ok(wasix, 'missing actual WASIX shipping export');
  assert.ok(wasix[1].includes('"//src/wasix/node-addon:release_shipping_export"'));
  assert.ok(wasix[1].includes('"//src/wasix/sdks/rust:napi_release_compiled_shipping_export"'));
  assert.ok(wasix[1].includes('"//src/wasix/pgwire-server:napi_release_compiled_shipping_export"'));
  const combined = root.match(
    /shipping_export\(\s*name = "wasix_napi_shipping_export",([\s\S]*?)\n\)/u,
  );
  assert.ok(combined, 'missing combined NAPI and compiled SDK export');
  assert.ok(combined[1].includes('"//src/wasix/node-addon:release_shipping_export"'));
  assert.ok(combined[1].includes('"//src/wasix/sdks/rust:napi_release_compiled_shipping_export"'));
  assert.ok(
    combined[1].includes('"//src/wasix/pgwire-server:napi_release_compiled_shipping_export"'),
  );
  const host = jobs['wasix-host'].steps.find((step: any) => step.name === name);
  assert.ok(host, 'imported host NAPI qualification is missing');
  assert.equal(host.env.CI_REQUEST_ID, 'wasix-host/${{ matrix.platform }}/napi');
  assert.deepEqual(JSON.parse(host.env.CI_REQUIRES), ['wasix/tools-sdk-browser']);
  assert.deepEqual(
    JSON.parse(workflow.env.CI_FULL_MATRICES)
      ['wasix-host'].map((row: any) => row.platform)
      .sort(),
    ['linux-arm64', 'macos-arm64', 'windows-x64'],
  );
  const authentication = jobs['wasix-host'].steps.find(
    (step: any) => step.name === 'Authenticate current WASIX constructor inputs',
  );
  assert.ok(authentication, 'missing authenticated current WASIX constructor inputs');
  assert.ok(authentication.run.includes(`jq -nc '["oliphaunt-wasix-rust"]'`));
  assert.ok(
    authentication.run.includes('--consumer-products-json "$input_root/consumer-products.json"'),
  );
  assert.ok(authentication.run.includes('--stage-release-archives --run-id "$GITHUB_RUN_ID"'));
  assert.ok(authentication.run.includes('with-source.sh HEAD'));
  assert.ok(authentication.if.includes('needs.release-inputs.outputs.ci_selected_jobs'));
  assert.ok(authentication.if.includes("format('wasix-host/{0}', matrix.platform)"));
  assert.equal(authentication['continue-on-error'], undefined);
  for (const consumer of [
    host,
    jobs['wasix-host'].steps.find(
      (step: any) => step.name === 'Qualify imported AOT runtime on its native host',
    ),
  ])
    assert.ok(
      jobs['wasix-host'].steps.indexOf(authentication) < jobs['wasix-host'].steps.indexOf(consumer),
    );
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
  assert.ok(
    consumer.if.includes(
      "contains(fromJSON(needs.release-inputs.outputs.ci_selected_jobs), 'react-native')",
    ),
  );
  const qualify = consumer.steps.filter((step: any) =>
    step.run?.includes('qualify-native-shipping.mts'),
  );
  assert.equal(qualify.length, 1);
  assert.ok(qualify[0].if.includes('env.CI_REQUEST_ID'));
  assert.equal(qualify[0]['continue-on-error'], undefined);
  assert.deepEqual(
    [...qualify[0].run.matchAll(/--shipping-export\s+(\S+)/gu)].map((match) => match[1]),
    ['//:native_react_native_shipping_export'],
  );
  const evidence = consumer.steps.filter(
    (step: any) => step.with?.name === 'native-build-evidence-react-native-macos-arm64',
  );
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0].if.includes("ci_mode == 'full'"));
  assert.ok(evidence[0].if.includes("ci_capture_requests), 'react-native/installed-consumer'"));
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
    return new Set([...declaration[1].matchAll(/"((?:\/\/|:)[^"\n]+)"/gu)].map((row) => row[1]));
  };
  const early = exports('native_shipping_export');
  const publicSource = exports('public_source_shipping_export');
  const family = exports('release_family_shipping_export');
  const sourceOwners = [
    '//src/native/rust-bindings:shipping_export',
    '//src/native/sdks/rust:shipping_export',
    '//src/native/sdks/rust/crates/oliphaunt-build:shipping_export',
    '//src/native/broker:shipping_export',
  ];
  assert.deepEqual([...publicSource].sort(), [...sourceOwners].sort());
  assert.ok(family.has(':public_source_shipping_export'));
  for (const owner of sourceOwners) {
    assert.ok(
      !early.has(owner),
      `Cargo source owner escaped its separate source qualification: ${owner}`,
    );
    assert.ok(
      !family.has(owner),
      `Cargo source export was duplicated in its full aggregate: ${owner}`,
    );
  }
  for (const producer of [
    'portable',
    'linux',
    'wasix',
    'postmaster',
    'postmaster-host',
    'wasix-host',
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
  const sourceStep = jobs['release-families'].steps.find((step: any) =>
    step.run?.includes('--shipping-export //:public_source_shipping_export'),
  );
  const familyStep = jobs['release-families'].steps.find((step: any) =>
    step.run?.includes('--shipping-export //:release_family_shipping_export'),
  );
  assert.equal(sourceStep.env.CI_REQUEST_ID, 'release-families/public-source');
  assert.equal(sourceStep.env.CI_REQUIRES, undefined);
  assert.equal(sourceStep.env.CI_FULL_ONLY, undefined);
  assert.ok(!sourceStep.run.includes('OLIPHAUNT_NATIVE_RELEASE_ARCHIVES'));
  assert.equal(familyStep.env.CI_REQUEST_ID, 'release-families/checksums');
  assert.equal(familyStep.env.CI_FULL_ONLY, 'true');
  assert.equal(JSON.parse(familyStep.env.CI_REQUIRES).length, 13);
  for (const mode of ['source', 'full'])
    qualifierFixture((directory, env) => {
      const execute = (step: any, shippingExport: string) => {
        const result = spawnSync('bash', ['-eu', '-c', step.run], {
          cwd: directory,
          env: {
            ...requestEnvironment(step, env, 'x86_64'),
            CI_REQUEST_JOB: 'release-families',
            CI_MODE: mode,
          },
        });
        assert.equal(result.status, 0, result.stderr.toString());
        const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
        const argument = (flag: string) => args[args.indexOf(flag) + 1];
        assert.equal(argument('--shipping-export'), shippingExport);
        assert.equal(argument('--ci-request-id'), step.env.CI_REQUEST_ID);
        assert.equal(argument('--ci-job'), 'release-families');
        assert.equal(argument('--ci-mode'), mode);
        assert.equal(
          JSON.parse(readFileSync(argument('--github-json'), 'utf8')).job,
          'Native release families',
        );
        assert.deepEqual(
          JSON.parse(readFileSync(argument('--ci-requires-json'), 'utf8')),
          JSON.parse(step.env.CI_REQUIRES ?? '[]'),
        );
        assert.ok(
          existsSync(
            path.join(env.RUNNER_TEMP, 'ci-requests', step.env.CI_REQUEST_ID, 'ci-request.json'),
          ),
        );
        return JSON.parse(readFileSync(argument('--configuration-json'), 'utf8')) as string[];
      };
      const configuration = execute(sourceStep, '//:public_source_shipping_export');
      assert.deepEqual(configuration, [
        '-c',
        'opt',
        '--platforms=//build_defs/native:linux_x86_64_glibc_2_28',
        '--host_platform=//build_defs/native:linux_x86_64_glibc_2_28',
        '--jobs=2',
      ]);
      if (mode === 'full') {
        const complete = execute(familyStep, '//:release_family_shipping_export');
        assert.deepEqual(complete.slice(0, -1), configuration);
        assert.equal(
          complete.at(-1),
          `--repo_env=OLIPHAUNT_NATIVE_RELEASE_ARCHIVES=${directory}/target/native-release-archive-inputs`,
        );
        assert.ok(
          existsSync(
            path.join(
              env.RUNNER_TEMP,
              'ci-requests/release-families/public-source/ci-request.json',
            ),
          ),
        );
      }
    });
});

test('release-family archive acquisition is full-only while source qualification permits unrelated skipped jobs', () => {
  const family = jobs['release-families'];
  const acquisition = family.steps.find(
    (step: any) => step.name === "Authenticate this run's completed archive producers",
  );
  const aggregate = family.steps.find(
    (step: any) => step.env?.CI_REQUEST_ID === 'release-families/checksums',
  );
  const evidence = family.steps.filter((step: any) =>
    step.with?.name?.startsWith('native-build-evidence-'),
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].with.name, 'native-build-evidence-release-families');
  assert.equal(evidence[0].with.path, '${{ runner.temp }}/release-family-build-capture/evidence/');
  const evaluate = (expression: string, mode: string, requests: string[], results: string[]) =>
    runInNewContext(
      expression
        .replace(/^\$\{\{\s*|\s*\}\}$/gu, '')
        .replaceAll('needs.release-inputs', 'inputs')
        .replaceAll('needs.*.result', 'results'),
      {
        inputs: {
          result: 'success',
          outputs: {
            ci_mode: mode,
            ci_selected_requests: JSON.stringify(requests),
            ci_selected_jobs: JSON.stringify(requests.length ? ['release-families'] : []),
          },
        },
        results,
        env: aggregate.env,
        cancelled: () => false,
        contains: (values: string[], value: string) => values.includes(value),
        fromJSON: JSON.parse,
      },
    );
  const source = ['release-families/public-source'];
  const full = [...source, 'release-families/checksums'];
  assert.equal(evaluate(family.if, 'source', source, ['success', 'skipped']), true);
  for (const result of ['failure', 'cancelled'])
    assert.equal(evaluate(family.if, 'source', source, ['success', result]), false);
  assert.equal(evaluate(family.if, 'source', [], ['success', 'skipped']), false);
  for (const step of [acquisition, aggregate, evidence[0]]) {
    assert.equal(evaluate(step.if, 'source', source, ['success', 'skipped']), false);
    assert.equal(evaluate(step.if, 'source', full, ['success']), false);
    assert.equal(evaluate(step.if, 'full', source, ['success']), false);
    assert.equal(evaluate(step.if, 'full', full, ['success']), true);
  }
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
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == --output-directory ]]; then
        mkdir -p "$argument"
        printf '{}\\n' > "$argument/ci-request.json"
      fi
      previous="$argument"
    done
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
  assert.ok(step.if.includes("matrix.platform == 'x86_64'"));
  assert.ok(step.if.includes('env.CI_REQUEST_ID'));
  assert.equal(step['continue-on-error'], undefined);
  qualifierFixture((directory, env) => {
    const argsFile = path.join(env.RUNNER_TEMP, 'args');
    writeFileSync(
      path.join(directory, 'tools/dev/bun.sh'),
      `#!/usr/bin/env bash
[[ "$1" == tools/ci/run-configured-request.mts ]] || exit 71
while [[ "$#" -gt 1 ]]; do
  case "$1" in
    --command) command="$2" ;;
    --targets-json) targets="$2" ;;
    --configuration-json) configuration="$2" ;;
    --startup-json) startup="$2" ;;
    --output-directory) output="$2" ;;
  esac
  shift
done
mapfile -t startup_args < <(jq -r '.[]' "$startup")
mapfile -t target_args < <(jq -r '.[]' "$targets")
mapfile -t config_args < <(jq -r '.[]' "$configuration")
printf '%s\\0' "\${startup_args[@]}" "$command" "\${target_args[@]}" "\${config_args[@]}" > "$SOURCE_ARGS"
mkdir -p "$output"
printf '{}\\n' > "$output/ci-request.json"
exit "\${SOURCE_STATUS:-0}"
`,
    );
    const execute = (status = '0') =>
      spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: {
          ...requestEnvironment(step, env, 'x86_64'),
          SOURCE_ARGS: argsFile,
          SOURCE_STATUS: status,
        },
      });
    const passed = execute();
    assert.equal(passed.status, 0, passed.stderr.toString());
    const args = readFileSync(argsFile, 'utf8').split('\0');
    assert.equal(args[0], 'test');
    assert.equal(args.filter((value) => value === label).length, 1);
    assert.ok(args.includes('--platforms=//build_defs/native:linux_x86_64_glibc_2_28'));
    assert.equal(execute('7').status, 7);
  });
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
    CI_REQUEST_ID: 'fixture/qualification',
    CI_REQUEST_JOB: 'fixture',
    CI_MODE: 'full',
    CI_CAPTURE_REQUESTS: '[]',
    CI_SELECTED_REQUESTS: '["fixture/qualification"]',
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
previous=''
for argument in "$@"; do
  if [[ "$previous" == --output-directory ]]; then
    mkdir -p "$argument"
    printf '{}\\n' > "$argument/ci-request.json"
  fi
  previous="$argument"
done
`,
  );
  mkdirSync(path.join(directory, 'tools/release'), { recursive: true });
  writeFileSync(
    path.join(directory, 'tools/release/with-source.sh'),
    readFileSync(path.resolve(import.meta.dir, '../release/with-source.sh')),
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', 'tools');
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
        env: { ...requestEnvironment(step, env, 'macos-arm64'), NATIVE_PREPARED_INPUTS: input },
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
  assert.ok(step.if.includes("matrix.platform == 'x86_64'"));
  assert.ok(step.if.includes('env.CI_REQUEST_ID'));
  assert.equal(step['continue-on-error'], undefined);
  qualifierFixture((directory, env) => {
    const requestEnv = requestEnvironment(step, env, 'x86_64');
    const result = spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env: requestEnv });
    assert.equal(result.status, 0, result.stderr.toString());
    const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
    const targets = JSON.parse(readFileSync(args[args.indexOf('--targets-json') + 1], 'utf8'));
    for (const label of [
      '//src/examples/native/react-native-expo:android_release',
      '//src/examples/native/react-native-expo:autolinking_consumer_test',
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
    assert.notEqual(
      spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env: requestEnv }).status,
      0,
    );
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
  assert.ok(step.if.includes("matrix.platform == 'x86_64'"));
  assert.ok(step.if.includes("format('linux/{0}/android-packages', matrix.platform)"));
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
  const authentication = job.steps.find(
    (step: any) => step.name === 'Authenticate current Linux postmaster constructor inputs',
  );
  assert.ok(authentication, 'missing authenticated current Linux postmaster constructor inputs');
  assert.ok(authentication.run.includes(`'["liboliphaunt-wasix-postmaster"]'`));
  assert.ok(authentication.run.includes('with-source.sh HEAD'));
  assert.ok(authentication.run.includes('--stage-release-archives --run-id "$GITHUB_RUN_ID"'));
  assert.ok(authentication.run.includes('--ref "$GITHUB_REF"'));
  assert.ok(
    authentication.run.includes('--consumer-products-json "$input_root/consumer-products.json"'),
  );
  assert.ok(authentication.if.includes('needs.release-inputs.outputs.ci_selected_requests'));
  assert.ok(
    authentication.if.includes("format('postmaster-host/{0}/carrier-lifecycle', matrix.platform)"),
  );
  assert.equal(authentication['continue-on-error'], undefined);
  assert.ok(job.steps.indexOf(authentication) < job.steps.indexOf(step));
  assert.ok(
    !job.steps.some((candidate: any) => candidate.uses?.startsWith('actions/download-artifact@')),
  );
  assert.ok(!step.run.includes('native-build-files'));
  assert.deepEqual(JSON.parse(step.env.CI_REQUIRES), ['postmaster/linux-carrier-lifecycle']);
  const start = step.run.indexOf('archive="$(jq');
  const end = step.run.indexOf('ci_arguments=(', start);
  assert.ok(start >= 0 && end > start, 'Missing actual archive and host configuration selection');
  qualifierFixture((directory, env) => {
    const inputRoot = path.join(directory, 'host inputs');
    mkdirSync(inputRoot);
    const snapshot = path.join(inputRoot, 'native-publication-inputs.json');
    const archive = path.join(directory, 'original-linux-x64-gnu.tar.zst');
    const canonical = {
      product: 'liboliphaunt-wasix-postmaster',
      artifact: 'github-release:postmaster:postmaster-linux-x64-gnu.tar.zst',
      file: { path: archive },
    };
    const artifacts = [
      { ...canonical, product: 'another-product' },
      { ...canonical, artifact: 'github-release:postmaster:postmaster-macos-arm64.tar.zst' },
      { ...canonical, artifact: 'untrusted:postmaster:postmaster-linux-x64-gnu.tar.zst' },
      canonical,
    ];
    const execute = (platform: string, compiler: string, prefix: string, current = artifacts) => {
      writeFileSync(snapshot, JSON.stringify({ nativeCurrentArtifacts: current }));
      return spawnSync(
        'bash',
        ['-eu', '-c', `input_root="$HOST_INPUT_ROOT"\n${step.run.slice(start, end)}`],
        {
          cwd: directory,
          env: {
            ...requestEnvironment(step, env, platform),
            HOST_INPUT_ROOT: inputRoot,
            OLIPHAUNT_NATIVE_PUBLICATION_INPUTS: snapshot,
            TARGET_PLATFORM: platform,
            TARGET_COMPILER: compiler,
            TARGET_PREFIX: prefix,
          },
        },
      );
    };
    for (const platform of ['macos-arm64', 'linux-arm64']) {
      const compiler =
        platform === 'macos-arm64'
          ? '//src/wasix/postmaster:native_macos_arm64'
          : '//src/wasix/postmaster:compiler_linux_arm64';
      const prefix = platform === 'macos-arm64' ? 'macos_arm64' : 'linux_arm64_gnu';
      const result = execute(platform, compiler, prefix);
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
      assert.deepEqual(JSON.parse(readFileSync(path.join(inputRoot, 'targets.json'), 'utf8')), [
        `//src/wasix/postmaster:${prefix}_public_archive_test`,
        `//src/wasix/postmaster:${prefix}_runtime_test`,
      ]);
      assert.deepEqual(JSON.parse(readFileSync(path.join(inputRoot, 'ci-requires.json'), 'utf8')), [
        'postmaster/linux-carrier-lifecycle',
      ]);
    }
    for (const current of [artifacts.slice(0, -1), [...artifacts, canonical]])
      assert.notEqual(
        execute(
          'linux-arm64',
          '//src/wasix/postmaster:compiler_linux_arm64',
          'linux_arm64_gnu',
          current,
        ).status,
        0,
      );
  });
});

test('native controllers provision locked release tooling before their first dependent command', () => {
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
  const resolver = jobs['release-inputs'].steps;
  const resolverInstall = resolver.filter((step: any) => step.run?.trim() === command);
  assert.equal(resolverInstall.length, 1);
  assert.equal(resolverInstall[0].if, undefined);
  assert.equal(resolverInstall[0]['continue-on-error'], undefined);
  assert.ok(
    resolver.indexOf(resolverInstall[0]) <
      resolver.findIndex((step: any) => step.run?.includes('native-release-inputs.mts')),
  );
  for (const [id, job] of Object.entries(jobs)) {
    assert.equal(
      job.steps.filter((step: any) => step.run?.trim() === command).length,
      id === 'release-inputs' ? 1 : 0,
      'Each controller or acquisition job provisions tooling once',
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
  const release = Bun.YAML.parse(
    readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8'),
  ) as any;
  const planning = release.jobs['plan-candidate'].steps;
  const planningInstall = planning.filter((step: any) => step.run?.trim() === command);
  assert.equal(planningInstall.length, 1);
  assert.equal(planningInstall[0].if, undefined);
  assert.equal(planningInstall[0]['continue-on-error'], undefined);
  assert.ok(
    planning.indexOf(planningInstall[0]) <
      planning.findIndex((step: any) =>
        step.run?.includes('native-freeze-publication-candidate.mts'),
      ),
  );
});

test('Source CI verifies ordinary receipts while full qualification retains Required admission', () => {
  assert.ok(jobs.required.if.includes("ci_mode == 'full'"));
  const source = jobs['source-ci'];
  assert.ok(source.if.startsWith('always()'));
  assert.ok(needs('source-ci').includes('required'));
  const guard = source.steps[0];
  const results = Object.fromEntries(
    needs('source-ci').map((id) => [
      id,
      { result: id === 'release-inputs' ? 'success' : 'skipped' },
    ]),
  );
  const runGuard = () =>
    spawnSync('bash', ['-eu', '-c', guard.run], {
      env: { PATH: process.env.PATH, NEEDS_JSON: JSON.stringify(results) },
    }).status;
  assert.equal(runGuard(), 0, 'a verified empty ordinary selection needs no producer jobs');
  for (const id of ['portable', 'wasix-host']) {
    for (const status of ['failure', 'cancelled']) {
      results[id].result = status;
      assert.notEqual(runGuard(), 0, `Source CI must reject a ${status} selected ${id} job`);
    }
    results[id].result = 'skipped';
  }
  for (const status of ['failure', 'skipped']) {
    results['release-inputs'].result = status;
    assert.notEqual(runGuard(), 0, `Source CI must reject a ${status} planner`);
  }
  const verify = source.steps.find(
    (step: any) => step.name === 'Verify selected requests and every omission',
  );
  assert.ok(verify.run.includes('with-source.sh HEAD'));
  assert.ok(verify.run.includes('configured-scope.mts verify'));
  assert.ok(verify.run.includes(`--required-result '\${{ needs.required.result }}'`));
  assert.ok(verify.run.includes('--basis-output "$RUNNER_TEMP/native-ci-basis/basis.json"'));
  const upload = source.steps.find((step: any) => step.with?.name === 'native-ci-basis');
  assert.equal(
    upload.if,
    "needs.release-inputs.outputs.ci_mode == 'full' && needs.required.result == 'success'",
  );
  assert.equal(upload.with.path, `\${{ runner.temp }}/native-ci-basis/basis.json`);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.ok(
    source.steps
      .find((step: any) => step.with?.pattern === 'native-ci-requests-*')
      .if.includes("!= '[]'"),
  );
});

test('every configured request is annotated and opaque controller qualification executes once', () => {
  const matrices = JSON.parse(workflow.env.CI_FULL_MATRICES);
  for (const [id, rows] of Object.entries(matrices)) {
    assert.ok(Array.isArray(rows) && rows.length > 0);
    assert.equal(
      jobs[id].strategy.matrix,
      `\${{ fromJSON(needs.release-inputs.outputs.${id.replaceAll('-', '_')}_matrix) }}`,
    );
  }
  let controller = 0;
  for (const [id, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      const command = step.run ?? '';
      if (command.includes('release-check.sh --mutation-tests-only')) controller++;
      assert.ok(
        !/tools\/dev\/bazel[.]sh\s+(?:build|test)\s/u.test(command),
        `${id}/${step.name} bypasses configured request receipts`,
      );
      if (
        !command.includes('run-configured-request.mts') &&
        !command.includes('qualify-native-shipping.mts')
      )
        continue;
      assert.ok(
        step.env?.CI_REQUEST_ID || step.env?.CI_REQUEST_IDS,
        `${id}/${step.name} has no executable request identity`,
      );
      assert.equal(step['continue-on-error'], undefined);
      assert.ok(
        command.includes('"$CI_REQUEST_ID"') &&
          command.includes('"$CI_REQUEST_JOB"') &&
          command.includes('"$CI_MODE"'),
      );
      const receipts = job.steps.filter((value: any) =>
        value.with?.name?.startsWith('native-ci-requests-'),
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].with.path, `\${{ runner.temp }}/ci-requests/**/ci-request.json`);
      assert.equal(receipts[0].with['if-no-files-found'], 'error');
    }
  }
  assert.equal(controller, 1);
  assert.ok(
    jobs.portable.steps
      .find((step: any) => step.name === 'Exercise cold, incremental and coverage scenarios')
      .if.includes("ci_mode == 'full'"),
  );
});

test('source producer capture is enabled only for an actual workflow handoff', () => {
  const step = jobs['wasix-host'].steps.find(
    (value: any) => value.name === 'Qualify final WASIX addon on its native host',
  );
  qualifierFixture((directory, env) => {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      env,
      encoding: 'utf8',
    }).trim();
    for (const handoff of [false, true]) {
      for (const generated of [env.RUNNER_TEMP, env.QUALIFIER_ARGS, env.QUALIFIER_SOURCE])
        rmSync(generated, { recursive: true, force: true });
      const request = requestEnvironment(step, env, 'linux-arm64');
      const result = spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: {
          ...request,
          CI_REQUEST_JOB: 'wasix-host/linux-arm64',
          CI_MODE: 'source',
          TARGET_PLATFORM: 'linux-arm64',
          EXPECTED_SOURCE_COMMIT: source,
          QUALIFICATION_JOB_NAME: 'WASIX imported runtime (linux-arm64)',
          CI_CAPTURE_REQUESTS: JSON.stringify(handoff ? [request.CI_REQUEST_ID] : []),
        },
      });
      assert.equal(result.status, 0, result.stderr.toString());
      const args = readFileSync(env.QUALIFIER_ARGS, 'utf8').split('\0');
      assert.equal(args[args.indexOf('--ci-request-id') + 1], 'wasix-host/linux-arm64/napi');
      assert.equal(args[args.indexOf('--ci-mode') + 1], 'source');
      assert.equal(args.includes('--ci-handoff'), handoff);
      assert.equal(args[args.indexOf('--shipping-export') + 1], '//:wasix_napi_shipping_export');
      const configuration = JSON.parse(
        readFileSync(args[args.indexOf('--configuration-json') + 1], 'utf8'),
      );
      for (const flag of [
        '--platforms=//build_defs/native:linux_aarch64_glibc_2_28',
        '--host_platform=//build_defs/native:linux_aarch64_glibc_2_28',
        `--repo_env=OLIPHAUNT_WASIX_SOURCE_COMMIT=${source}`,
        `--repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS=${env.RUNNER_TEMP}/wasix-cargo-inputs`,
        '--jobs=1',
        '--local_test_jobs=1',
        '--test_env=OLIPHAUNT_WASM_AOT_VERIFY=full',
      ])
        assert.ok(configuration.includes(flag), `missing imported NAPI configuration: ${flag}`);
      assert.deepEqual(
        JSON.parse(readFileSync(args[args.indexOf('--ci-requires-json') + 1], 'utf8')),
        ['wasix/tools-sdk-browser'],
      );
      assert.equal(
        JSON.parse(readFileSync(args[args.indexOf('--github-json') + 1], 'utf8')).job,
        'WASIX imported runtime (linux-arm64)',
      );
      assert.ok(
        existsSync(
          path.join(env.RUNNER_TEMP, 'ci-requests/wasix-host/linux-arm64/napi/ci-request.json'),
        ),
      );
    }
  });
});

test('the actual Apple ABI loop runs exactly the selected configured request and preserves full construction', () => {
  const step = jobs.portable.steps.find(
    (value: any) => value.name === 'Construct native iOS device and simulator ABI consumers',
  );
  const ids: string[] = JSON.parse(step.env.CI_REQUEST_IDS)['macos-arm64'];
  qualifierFixture((directory, env) => {
    const calls = path.join(env.RUNNER_TEMP, 'abi-calls');
    writeFileSync(
      path.join(directory, 'tools/dev/bun.sh'),
      `#!/usr/bin/env bash
[[ "$1" == tools/ci/run-configured-request.mts ]] || exit 71
while [[ "$#" -gt 1 ]]; do
  case "$1" in
    --id) id="$2" ;;
    --command) command="$2" ;;
    --targets-json) targets="$2" ;;
    --configuration-json) configuration="$2" ;;
    --startup-json) startup="$2" ;;
    --output-directory) output="$2" ;;
  esac
  shift
done
jq -nc --arg id "$id" --arg command "$command" --slurpfile targets "$targets" --slurpfile config "$configuration" --slurpfile startup "$startup" \\
  '{id:$id,command:$command,targets:$targets[0],configuration:$config[0],startup:$startup[0]}' >> "$ABI_CALLS"
if [[ "\${ABI_STATUS:-0}" != 0 ]]; then exit "$ABI_STATUS"; fi
mkdir -p "$output"
printf '{}\\n' > "$output/ci-request.json"
`,
    );
    const execute = (selected: string[], status = '0') => {
      rmSync(calls, { force: true });
      const result = spawnSync('bash', ['-eu', '-c', step.run], {
        cwd: directory,
        env: {
          ...requestEnvironment(step, env, 'macos-arm64'),
          CI_SELECTED_REQUESTS: JSON.stringify(selected),
          ABI_CALLS: calls,
          ABI_STATUS: status,
        },
      });
      const records = existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((value) => JSON.parse(value))
        : [];
      return { result, records };
    };
    const selected = execute([ids[1]]);
    assert.equal(selected.result.status, 0, selected.result.stderr.toString());
    assert.deepEqual(
      selected.records.map((value) => value.id),
      [ids[1]],
    );
    const full = execute(ids);
    assert.equal(full.result.status, 0, full.result.stderr.toString());
    assert.deepEqual(
      full.records.map((value) => value.id),
      ids,
    );
    for (const record of full.records) {
      assert.equal(record.command, 'build');
      assert.ok(
        record.configuration.includes(
          `--platforms=//build_defs/host:${record.id.split('/abi-')[1]}`,
        ),
      );
      assert.deepEqual(record.startup, [
        `--output_base=${env.RUNNER_TEMP}/native-bazel`,
        '--host_jvm_args=-Xmx3g',
        `--server_jvm_out=${env.RUNNER_TEMP}/native-bazel-diagnostics/server-jvm.out`,
      ]);
      assert.ok(record.targets.includes('//build_defs/extensions/mobile:all_members_consumer'));
    }
    assert.equal(
      full.records[0].targets.filter(
        (value: string) => value === '//src/native/runtime:mobile_static_abi_consumer',
      ).length,
      1,
    );
    assert.equal(
      full.records[2].targets.includes('//src/native/runtime:mobile_static_abi_consumer'),
      false,
    );
    const failed = execute(ids, '7');
    assert.equal(failed.result.status, 7);
    assert.equal(failed.records.length, 1, 'failure must stop subsequent ABI requests');
    assert.deepEqual(execute([]).records, []);
  });
});

test('full module preflight follows source planning and retains strict failure propagation', () => {
  const steps = jobs['release-inputs'].steps;
  const index = (name: string) => steps.findIndex((step: any) => step.name === name);
  const context = steps.findIndex((step: any) => step.id === 'context');
  const versions = index('Check release-owned source versions');
  const controller = index('Qualify release controller and Git source policy');
  const planner = steps.findIndex((step: any) => step.id === 'scope');
  const preflight = index('Check every used module extension before producer fanout');
  assert.ok(context >= 0 && context < versions && versions < controller);
  assert.ok(controller < planner && planner < preflight);
  assert.ok(preflight < index('Upload source request plan'));
  assert.ok(preflight < index('Acquire completed public inputs once'));
  for (const position of [versions, controller, planner]) {
    assert.equal(steps[position].if, undefined);
    assert.equal(steps[position]['continue-on-error'], undefined);
  }
  const step = steps[preflight];
  assert.equal(step.if, "steps.scope.outputs.ci_mode == 'full'");
  assert.equal(step.run, 'bash tools/dev/bazel.sh mod deps --lockfile_mode=error');
  assert.equal(step['continue-on-error'], undefined);
  for (const mode of ['source', 'full', ''])
    assert.equal(
      runInNewContext(step.if, { steps: { scope: { outputs: { ci_mode: mode } } } }),
      mode === 'full',
    );
  qualifierFixture((directory, env) => {
    writeFileSync(path.join(directory, 'tools/dev/bazel.sh'), 'exit 7\n');
    const result = spawnSync('bash', ['-eu', '-c', step.run], { cwd: directory, env });
    assert.equal(result.status, 7, 'a strict full preflight failure must stop producer fanout');
  });
});

test('selected consumers reject failed producers while independent source families permit skipped jobs', () => {
  const producers: Record<string, string[]> = {
    'postmaster-host': ['postmaster'],
    'wasix-host': ['wasix'],
    'react-native': ['portable'],
    'release-families': [
      'portable',
      'linux',
      'wasix',
      'wasix-host',
      'postmaster',
      'postmaster-host',
    ],
  };
  for (const [id, required] of Object.entries(producers)) {
    assert.deepEqual([...needs(id)].sort(), [...required, 'release-inputs'].sort());
    const evaluate = (results: Record<string, string>, selected = true, cancelled = false) => {
      const outputs = {
        ci_mode: 'source',
        ci_selected_requests: JSON.stringify(selected ? ['release-families/public-source'] : []),
        ci_selected_jobs: JSON.stringify(selected ? [id] : []),
        postmaster_host_matrix: JSON.stringify({
          include: selected ? [{ platform: 'linux-arm64' }] : [],
        }),
        wasix_host_matrix: JSON.stringify({
          include: selected ? [{ platform: 'linux-arm64' }] : [],
        }),
      };
      const input = Object.fromEntries(
        needs(id).map((producer) => [
          producer,
          { result: results[producer] ?? 'success', outputs },
        ]),
      );
      const expression = jobs[id].if
        .slice(3, -2)
        .replace(/needs[.]\*[.]([\w-]+)/gu, "Object.values(needs).map(value => value['$1'])")
        .replace(/needs[.]([\w-]+)/gu, "needs['$1']");
      return runInNewContext(expression, {
        needs: input,
        cancelled: () => cancelled,
        fromJSON: JSON.parse,
        contains: (values: string[], value: string) => values.includes(value),
      });
    };
    assert.equal(evaluate({}), true, `${id}: successful selected producer chain`);
    assert.equal(evaluate({}, false), false, `${id}: omitted consumer`);
    assert.equal(evaluate({}, true, true), false, `${id}: cancelled workflow`);
    for (const producer of needs(id)) {
      for (const result of ['failure', 'cancelled'])
        assert.equal(evaluate({ [producer]: result }), false, `${id}: ${producer} ${result}`);
      assert.equal(
        evaluate({ [producer]: 'skipped' }),
        id === 'release-families' && producer !== 'release-inputs',
        `${id}: ${producer} skipped`,
      );
    }
    const skipped = Object.fromEntries(required.map((producer) => [producer, 'skipped']));
    assert.equal(evaluate(skipped), id === 'release-families', `${id}: all producers skipped`);
    for (const producer of required)
      for (const result of ['failure', 'cancelled'])
        assert.equal(
          evaluate({ ...skipped, [producer]: result }),
          false,
          `${id}: mixed skipped and ${producer} ${result}`,
        );
  }
});
