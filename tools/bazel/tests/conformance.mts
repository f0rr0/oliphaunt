import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../packaging/portable-archive.mts';
import {
  buildShippingInputView,
  canonicalShippingLabel,
  type ShippingInputView,
  selectShippingChanges,
} from '../../release/bazel-shipping-inputs.mts';
import { executedFixtureSpawns, parseExecutionLog, type SpawnExecution } from './execution-log.mts';

const sourceRoot =
  process.env.BUILD_WORKSPACE_DIRECTORY ?? path.resolve(import.meta.dir, '../../..');
const fixturePath = 'tools/bazel/tests/fixtures/action-graph';
const label = `//${fixturePath}`;
const products = ['alpha', 'beta', 'gamma'] as const;
type Product = (typeof products)[number];
const scratch = mkdtempSync(path.join(tmpdir(), 'oliphaunt-bazel-conformance-'));
const workspace = path.join(scratch, 'source');
const outputBase = path.join(scratch, 'output');
const fixture = path.join(workspace, fixturePath);
const wrapper = path.join(workspace, 'tools/dev/bazel.sh');
const records: { scenario: string; production: Record<string, number>; tests: string[] }[] = [];
const queryRecords: { scenario: string; producerSpawns: number }[] = [];
const model = { shared: 10, config: 0, alpha: 1, beta: 2, gamma: 3, legal: 1 };
let invocation = 0;
let completed = false;
let priorView: ShippingInputView;
// BEP includes Bazel's client environment. Keep credentials, local SDK selectors
// and user shell configuration out of both the build and its evidence files.
const subprocessEnvironment = Object.fromEntries(
  ['PATH', 'HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot'].flatMap(
    (key) => (process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
  ),
);
const startupOptions = ['--nosystem_rc', '--nohome_rc', `--output_base=${outputBase}`];

function removePrivateScratch(directory: string) {
  const makeDirectoriesWritable = (current: string) => {
    const stat = lstatSync(current);
    if (!stat.isDirectory()) return;
    // Bazel makes tree outputs read-only. Change only private directories;
    // files may be hardlinked, and symlinks may point outside this workspace.
    chmodSync(current, (stat.mode & 0o7777) | 0o700);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) makeDirectoriesWritable(path.join(current, entry.name));
    }
  };
  makeDirectoriesWritable(directory);
  rmSync(directory, { recursive: true, force: true });
}

function snapshot() {
  const files = execFileSync(
    'git',
    ['-C', sourceRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', env: subprocessEnvironment },
  );
  const captured = [];
  for (const file of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    const input = path.join(sourceRoot, file);
    if (!existsSync(input)) continue;
    const output = path.join(workspace, file);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(input, output, { dereference: false });
    const stat = lstatSync(output);
    captured.push({
      path: file,
      mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644',
      sha256: createHash('sha256')
        .update(stat.isSymbolicLink() ? readlinkSync(output) : readFileSync(output))
        .digest('hex'),
    });
  }
  console.log(
    JSON.stringify({
      sourceSnapshot: {
        head: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          env: subprocessEnvironment,
        }).trim(),
        files: captured.length,
        treeSha256: createHash('sha256').update(JSON.stringify(captured)).digest('hex'),
      },
    }),
  );
}

function bazel(command: string, args: string[], expectFailure = false, base = outputBase) {
  const result = spawnSync(
    'bash',
    [
      wrapper,
      ...startupOptions.map((option) =>
        option.startsWith('--output_base=') ? `--output_base=${base}` : option,
      ),
      ...(base === outputBase ? [] : ['--host_jvm_args=-Xmx768m']),
      command,
      '--repo_env=DO_NOT_TRACK=1',
      ...args,
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      timeout: command === 'shutdown' ? 30_000 : 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: subprocessEnvironment,
    },
  );
  if (result.error || (expectFailure ? result.status === 0 : result.status !== 0)) {
    throw new Error(
      `Bazel ${command} ${args.join(' ')} returned ${result.status}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function externalBunEntrypoints() {
  const repository = path.join(scratch, 'external-bun');
  cpSync(path.join(workspace, 'build_defs/foundation/fixtures/bun_external'), repository, {
    recursive: true,
  });
  const build = readFileSync(path.join(repository, 'fixture.BUILD.bazel'));
  writeFileSync(path.join(repository, 'BUILD.bazel'), build);
  mkdirSync(path.join(repository, 'nested'));
  writeFileSync(
    path.join(repository, 'nested/BUILD.bazel'),
    readFileSync(path.join(repository, 'nested.fixture.BUILD.bazel')),
  );
  writeFileSync(path.join(repository, 'WORKSPACE.bazel'), '');
  const injection = `--inject_repository=conformance_external_bun=${repository}`;
  const packages = ['@conformance_external_bun//', '@conformance_external_bun//nested'];
  bazel('test', [
    '//build_defs/foundation:bun_toolchain_test',
    '//build_defs/foundation:native_entry_test',
    '//build_defs/foundation:toolchain_metadata_test',
    ...packages.flatMap((pkg) =>
      ['test', 'script_test', 'toolchain_test'].map((name) => `${pkg}:${name}`),
    ),
    injection,
    '--test_output=errors',
    '--noshow_progress',
  ]);
  for (const pkg of packages) {
    const result = bazel('run', [`${pkg}:binary`, injection, '--noshow_progress']);
    assert.equal(result.stdout.trim(), 'external Bun entrypoint');
  }
  for (const name of ['missing_entry_argument_test', 'wrong_entry_argument_test']) {
    const result = bazel(
      'build',
      [`//build_defs/foundation/fixtures/bun_imports:${name}`, '--nobuild', '--noshow_progress'],
      true,
    );
    assert.match(result.stderr, /Bun entrypoint requires args\[0\]/u);
  }
  console.log(
    JSON.stringify({
      externalBunEntrypoints: {
        mainTests: 3,
        externalTests: 6,
        binaries: 2,
        rejectedEntryArguments: 2,
      },
    }),
  );
}

function ignoreGeneratedOutputDirectories() {
  const queryArguments = [
    'labels(srcs, //:root_quality_sources)',
    '--output=label',
    '--noshow_progress',
  ];
  const original = bazel('query', queryArguments).stdout;
  const generated = path.join(workspace, 'bazel-incomplete-output');
  mkdirSync(generated);
  writeFileSync(path.join(generated, 'generated.json'), '{}');
  symlinkSync(
    path.join(scratch, 'missing-generated-output'),
    path.join(generated, 'dangling'),
    'dir',
  );
  assert.equal(
    bazel('query', queryArguments).stdout,
    original,
    'source discovery must prune incomplete generated outputs and keep the source input graph unchanged',
  );
  rmSync(generated, { recursive: true });
  const authored = [
    'build_defs/quality/fixtures/bazel-authored.ts',
    'build_defs/quality/fixtures/bazel-authored/nested.ts',
  ];
  try {
    for (const file of authored) {
      mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
      writeFileSync(path.join(workspace, file), 'export const fixture = true;\n');
    }
    const qualitySources = new Set(
      bazel('query', [
        'labels(srcs, //build_defs/quality:quality_sources)',
        '--output=label',
        '--noshow_progress',
      ])
        .stdout.split(/\r?\n/u)
        .filter(Boolean)
        .map(canonicalShippingLabel),
    );
    for (const file of authored)
      assert.ok(
        qualitySources.has(
          `//build_defs/quality:${path.posix.relative('build_defs/quality', file)}`,
        ),
        'authored bazel-* files and nested directories must remain quality sources',
      );
  } finally {
    rmSync(path.join(workspace, authored[0]), { force: true });
    rmSync(path.dirname(path.join(workspace, authored[1])), { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({ generatedOutputDiscovery: 'pruned', nestedBazelSources: 'included' }),
  );
}

function cargoBuildScriptParity() {
  const repository = path.join(scratch, 'external-cargo-build-script');
  cpSync(path.join(workspace, 'tools/bazel/tests/fixtures/cargo-build-script'), repository, {
    recursive: true,
  });
  cpSync(path.join(repository, 'fixture.BUILD.bazel'), path.join(repository, 'BUILD.bazel'));
  writeFileSync(path.join(repository, 'WORKSPACE.bazel'), '');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(path.join(workspace, file), path.join(repository, file));
  }
  const version = Bun.TOML.parse(
    readFileSync(path.join(workspace, 'src/query/rust/Cargo.toml'), 'utf8'),
  ).package.version;
  const manifest = path.join(repository, 'Cargo.toml');
  writeFileSync(
    manifest,
    readFileSync(path.join(repository, 'fixture.Cargo.toml'), 'utf8').replace(
      /^version = .*$/m,
      `version = "${version}"`,
    ),
  );
  const pkg = '@conformance_cargo_build_script//';
  bazel('test', [
    `${pkg}:unit_test`,
    `${pkg}:installed_consumer_test`,
    `--inject_repository=conformance_cargo_build_script=${repository}`,
    '--jobs=2',
    '--test_output=errors',
    '--noshow_progress',
  ]);
  console.log(
    JSON.stringify({ cargoBuildScriptParity: { bazelTests: 1, installedCargoTests: 1 } }),
  );
}

function writeModel() {
  writeFileSync(
    path.join(fixture, 'shared.h'),
    `#define SHARED_VALUE ${model.shared}\nint shared_value(void);\n`,
  );
  writeFileSync(path.join(fixture, 'config.txt'), `${model.config}\n`);
  for (const product of products) {
    const shared = product === 'gamma' ? '' : '#include "shared.h"\n';
    const value = product === 'gamma' ? `${model.gamma}` : `shared_value() + ${model[product]}`;
    writeFileSync(
      path.join(fixture, `${product}.c`),
      `#include <stdio.h>\n${shared}int main(void) { printf("%d\\n", ${value}); return 0; }\n`,
    );
    // Independently authored physical consumer truth: alpha/beta share the library; gamma does not.
    const expected =
      product === 'gamma' ? model.gamma : model.shared + model.config + model[product];
    writeFileSync(path.join(fixture, `${product}.expected`), `${expected}\n`);
  }
  writeFileSync(path.join(fixture, 'LEGAL.txt'), `Fixture license, revision ${model.legal}.\n`);
}

function targetName(spawn: SpawnExecution) {
  return spawn.targetLabel?.split(':').at(-1) ?? '';
}

function scenario(
  name: string,
  allowedProduction: string[],
  expectedTests: Product[],
  exportName = 'export',
) {
  const executionLog = path.join(scratch, `${invocation}.execution.json`);
  const events = path.join(scratch, `${invocation++}.bep.json`);
  const result = bazel('test', [
    `${label}:all_tests`,
    `${label}:alpha_test`,
    `${label}:${exportName}`,
    '--jobs=2',
    '--noshow_progress',
    '--noshow_loading_progress',
    `--execution_log_json_file=${executionLog}`,
    `--build_event_json_file=${events}`,
  ]);
  assert.ok(existsSync(executionLog), 'execution evidence must exist');
  const executions = executedFixtureSpawns(executionLog, label);
  // Bazel also logs its XML report generator with mnemonic TestRunner.
  const tests = executions.filter(
    (spawn) =>
      spawn.mnemonic === 'TestRunner' && spawn.commandArgs?.[0]?.endsWith('/test-setup.sh'),
  );
  const production = executions.filter((spawn) => spawn.mnemonic !== 'TestRunner');
  assert.deepEqual(
    tests.map(targetName).sort(),
    expectedTests.map((product) => `${product}_test`).sort(),
    `${name}: actual test attempts`,
  );
  assert.equal(
    new Set(tests.map(targetName)).size,
    tests.length,
    `${name}: duplicate test execution`,
  );
  for (const spawn of production) {
    const preparesExpectedTest =
      spawn.mnemonic === 'CopyToDirectory' &&
      expectedTests.some((product) => targetName(spawn) === `${product}_test`);
    assert.ok(
      allowedProduction.includes(targetName(spawn)) || preparesExpectedTest,
      `${name}: unnecessary ${spawn.mnemonic} for ${spawn.targetLabel}`,
    );
  }
  const buildEvents = readFileSync(events, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const allowedClientEnvironment = new Set([
    ...Object.keys(subprocessEnvironment),
    'PWD',
    'OLDPWD',
    'SHLVL',
    '_',
  ]);
  for (const event of buildEvents) {
    for (const section of event.structuredCommandLine?.sections ?? []) {
      for (const option of section.optionList?.option ?? []) {
        if (option.optionName !== 'client_env') continue;
        const key = option.optionValue.split('=', 1)[0];
        assert.ok(
          allowedClientEnvironment.has(key),
          `${name}: unexpected client environment key ${key}`,
        );
      }
    }
  }
  const summaries = buildEvents.filter((event) =>
    event.id?.testSummary?.label?.startsWith(`${label}:`),
  );
  assert.equal(
    summaries.length,
    products.length,
    `${name}: missing supported physical consumer result`,
  );
  assert.ok(
    summaries.every((event) => event.testSummary.overallStatus === 'PASSED'),
    `${name}: unsuccessful consumer proof`,
  );
  const counts: Record<string, number> = {};
  for (const spawn of production)
    counts[spawn.mnemonic ?? 'unknown'] = (counts[spawn.mnemonic ?? 'unknown'] ?? 0) + 1;
  records.push({ scenario: name, production: counts, tests: tests.map(targetName).sort() });
  console.log(JSON.stringify(records.at(-1)));
  return { executions, result };
}

function shippingState(exportName = 'export') {
  const exported = JSON.parse(
    readFileSync(path.join(workspace, 'bazel-bin', fixturePath, `${exportName}.json`), 'utf8'),
  );
  const graph = JSON.parse(
    bazel('aquery', [
      `deps(${label}:${exportName})`,
      '--output=jsonproto',
      '--include_artifacts',
      '--include_commandline',
      '--noshow_progress',
    ]).stdout,
  );
  return { exported, graph, view: buildShippingInputView(exported, graph) };
}

function assertEnvelopeIdentities(exported: {
  packages: { product: string; version: string; outputs: { path: string }[] }[];
}) {
  for (const pkg of exported.packages) {
    assert.equal(pkg.outputs.length, 1, 'fixture shipping envelope has exactly one output');
    const envelope = JSON.parse(readFileSync(path.join(workspace, pkg.outputs[0].path), 'utf8'));
    assert.equal(
      envelope.version,
      pkg.version,
      'actual package version must agree with declared identity',
    );
    assert.equal(
      envelope.product,
      pkg.product,
      'actual package owner must agree with declared identity',
    );
  }
}

function selection(changed: string[], expected: Product[], unclassified: string[] = []) {
  const after = shippingState();
  assertEnvelopeIdentities(after.exported);
  const paths = changed.map((file) => `${fixturePath}/${file}`);
  const deltas = Object.fromEntries(products.map((product) => [`fixture-${product}`, paths]));
  const result = selectShippingChanges(priorView.products, after.view, deltas);
  assert.deepEqual(
    result.affectedProducts,
    expected.map((product) => `fixture-${product}`).sort(),
    'real adapter selection must agree with physical consumer truth',
  );
  assert.deepEqual(
    result.unclassifiedPaths,
    unclassified.map((file) => `${fixturePath}/${file}`).sort(),
    'unknown provenance must be visible, never silently unaffected',
  );
  priorView = after.view;
  return after;
}

function archives(base = outputBase, consume = false) {
  const files = bazel(
    'cquery',
    [
      `${label}:alpha_archive + ${label}:beta_archive + ${label}:gamma_archive`,
      '--output=files',
      '--noshow_progress',
    ],
    false,
    base,
  )
    .stdout.trim()
    .split('\n');
  return Object.fromEntries(
    products.map((product) => {
      const file = files.find((entry) => entry.endsWith(`/${product}_archive.json`));
      assert.ok(file, `${product} archive must have a native output`);
      const bytes = readFileSync(path.join(workspace, file));
      const envelope = JSON.parse(bytes.toString());
      assert.equal(envelope.version, { alpha: '1.0.0', beta: '2.0.0', gamma: '3.0.0' }[product]);
      if (consume) {
        // Cache hits need not materialize binaries below the public archive outputs.
        const binary = path.join(scratch, `cache-${product}.consumer`);
        writeFileSync(binary, Buffer.from(envelope.executable, 'base64'), { mode: 0o755 });
        assert.equal(
          execFileSync(binary, { encoding: 'utf8', timeout: 10_000, env: subprocessEnvironment }),
          readFileSync(path.join(fixture, `${product}.expected`), 'utf8'),
          `${base}: physical ${product} archive consumer`,
        );
      }
      return [product, createHash('sha256').update(bytes).digest('hex')];
    }),
  ) as Record<Product, string>;
}

function unchanged(
  before: Record<Product, string>,
  after: Record<Product, string>,
  expected: Product[],
) {
  assert.deepEqual(
    products.filter((product) => before[product] !== after[product]),
    expected,
    'physical delivery changes must match the independent fixture truth',
  );
}

function diskCacheAcrossFreshBases() {
  const cache = path.join(scratch, 'disk-cache');
  const originalAlpha = model.alpha;
  const phase = (name: string) => {
    const base = path.join(scratch, `cache-${name}`);
    assert.ok(!existsSync(base), 'disk cache proof requires a fresh output base');
    const log = path.join(scratch, `cache-${name}.execution.json`);
    try {
      bazel(
        'build',
        [
          ...products.map((product) => `${label}:${product}_archive`),
          '--config=ci-cache',
          `--disk_cache=${cache}`,
          '--jobs=2',
          '--noshow_progress',
          `--execution_log_json_file=${log}`,
        ],
        false,
        base,
      );
      const spawns = parseExecutionLog(readFileSync(log, 'utf8')).filter((spawn) =>
        spawn.targetLabel?.startsWith(`${label}:`),
      );
      const executed = spawns
        .filter((spawn) => !spawn.cacheHit)
        .map((spawn) => ({
          mnemonic: spawn.mnemonic,
          target: targetName(spawn),
        }));
      const hits = spawns.filter((spawn) => spawn.cacheHit);
      assert.ok(hits.every((spawn) => spawn.runner === 'disk cache hit'));
      const hashes = archives(base, true);
      console.log(JSON.stringify({ diskCacheScenario: name, executed, hits: hits.length, hashes }));
      return { executed, hits, hashes };
    } finally {
      bazel('shutdown', [], false, base);
    }
  };
  try {
    const cold = phase('cold');
    assert.equal(cold.executed.length, 15, 'cold fixture must execute its actual producer actions');
    assert.equal(cold.hits.length, 0);
    const restored = phase('restored');
    assert.deepEqual(restored.executed, [], 'fresh output base must restore every producer action');
    assert.equal(restored.hits.length, cold.executed.length);
    unchanged(cold.hashes, restored.hashes, []);
    model.alpha += 4;
    writeModel();
    const changed = phase('changed');
    assert.deepEqual(changed.executed, [
      { mnemonic: 'CppCompile', target: 'alpha_bin' },
      { mnemonic: 'CppLink', target: 'alpha_bin' },
      { mnemonic: 'FixturePackage', target: 'alpha_archive' },
    ]);
    assert.equal(changed.hits.length, cold.executed.length - changed.executed.length);
    unchanged(cold.hashes, changed.hashes, ['alpha']);
  } finally {
    model.alpha = originalAlpha;
    writeModel();
  }
}

function realQueryShipping(name: string, allowedTargets: string[], expectedEnvelopes?: number) {
  const roots = ['src/query/rust', 'src/query/ts'];
  const executionLog = path.join(scratch, `${name}.execution.json`);
  bazel('build', [
    ...roots.flatMap((root) => [`//${root}:shipping_package`, `//${root}:shipping_export`]),
    '--jobs=2',
    '--noshow_progress',
    `--execution_log_json_file=${executionLog}`,
  ]);
  const spawns = parseExecutionLog(readFileSync(executionLog, 'utf8')).filter(
    (spawn) => !spawn.cacheHit,
  );
  for (const spawn of spawns) {
    assert.ok(
      allowedTargets.includes(spawn.targetLabel ?? ''),
      `${name}: unnecessary real query execution ${spawn.mnemonic} for ${spawn.targetLabel}`,
    );
  }
  if (expectedEnvelopes !== undefined) {
    assert.equal(spawns.length, expectedEnvelopes, `${name}: exact packaging work`);
    assert.ok(
      spawns.every((spawn) =>
        ['QueryEnvelope', 'CargoSourceEnvelope'].includes(spawn.mnemonic ?? ''),
      ),
      `${name}: package-only work must not compile, extract dependencies, or run tests`,
    );
  }
  const exports = roots.map((root) =>
    JSON.parse(
      readFileSync(path.join(workspace, 'bazel-bin', root, 'shipping_export.json'), 'utf8'),
    ),
  );
  for (const value of exports) {
    assert.equal(value.schema, 'oliphaunt-bazel-shipping-v1');
    assert.equal(value.scope, 'construction');
  }
  const graph = JSON.parse(
    bazel('aquery', [
      'deps(set(//src/query/rust:shipping_export //src/query/ts:shipping_export))',
      '--output=jsonproto',
      '--include_artifacts',
      '--include_commandline',
      '--noshow_progress',
    ]).stdout,
  );
  const exported = {
    schema: 'oliphaunt-bazel-shipping-v1',
    scope: 'construction',
    packages: exports.flatMap((value) => value.packages),
  };
  const view = buildShippingInputView(exported, graph);
  const config = JSON.parse(
    readFileSync(path.join(workspace, 'release-please-config.json'), 'utf8'),
  );
  const versions = JSON.parse(
    readFileSync(path.join(workspace, '.release-please-manifest.json'), 'utf8'),
  );
  if (name === 'cold-real-query-packages') {
    const rootsFile = path.join(scratch, 'query-shipping-roots.jsonl');
    const graphFile = path.join(scratch, 'query-shipping-aquery.json');
    writeFileSync(
      rootsFile,
      bazel('cquery', [
        'set(//src/query/rust:shipping_package //src/query/ts:shipping_package)',
        '--output=starlark',
        '--starlark:file=tools/bazel/shipping.cquery.bzl',
        '--noshow_progress',
      ]).stdout,
    );
    writeFileSync(graphFile, JSON.stringify(graph));
    const executionRoot = bazel('info', ['execution_root']).stdout.trim();
    const checkCoverage = (selected: string[], capturedRoot = executionRoot) =>
      spawnSync(
        process.execPath,
        [
          path.join(workspace, 'tools/bazel/check-shipping-coverage.mts'),
          ...selected.flatMap((product) => ['--product', product]),
          '--cohort',
          rootsFile,
          graphFile,
          '--physical',
          ...(capturedRoot ? ['--execution-root', capturedRoot] : []),
        ],
        { cwd: workspace, encoding: 'utf8', timeout: 30_000, env: subprocessEnvironment },
      );
    const subset = checkCoverage(roots.map((root) => config.packages[root].component));
    assert.equal(subset.status, 0, subset.stderr);
    const coverage = JSON.parse(subset.stdout);
    assert.equal(coverage.scope, 'construction');
    assert.equal(coverage.completeProductInventory, false);
    assert.equal(coverage.declaredCarriers, 2);
    assert.equal(coverage.rootLabels.length, 2);
    assert.equal(coverage.registryArtifacts.length, 2);
    for (const record of coverage.registryArtifacts) {
      const pkg = exported.packages.find(
        (pkg: { ecosystem: string; name: string }) =>
          pkg.ecosystem === record.ecosystem && pkg.name === record.name,
      );
      assert.ok(pkg);
      // Each exported name/version is checked against its conventional source
      // manifest below; here the separate physical bridge must observe it too.
      assert.equal(record.version, pkg.version);
      for (const file of record.artifacts) {
        assert.equal(
          file.sha256,
          createHash('sha256').update(readFileSync(file.path)).digest('hex'),
        );
      }
    }
    const missingExecutionRoot = checkCoverage(
      roots.map((root) => config.packages[root].component),
      '',
    );
    assert.equal(missingExecutionRoot.status, 1);
    assert.match(missingExecutionRoot.stderr, /explicit captured --execution-root/);
    const incomplete = checkCoverage([]);
    assert.equal(incomplete.status, 1, 'two real package roots cannot admit full native migration');
    assert.match(incomplete.stderr, /incomplete native shipping coverage/);
    assert.match(incomplete.stderr, /product:/);
  }
  for (const root of roots) {
    const rust = root.endsWith('/rust');
    const manifest = rust
      ? Bun.TOML.parse(readFileSync(path.join(workspace, root, 'Cargo.toml'), 'utf8')).package
      : JSON.parse(readFileSync(path.join(workspace, root, 'package.json'), 'utf8'));
    const product = config.packages[root].component;
    const info = view.products[product];
    assert.ok(info, `${root}: actual shipping owner must match canonical product`);
    assert.equal(info.version, manifest.version);
    assert.equal(info.version, versions[root]);
    const pkg = exported.packages.find((pkg: { product: string }) => pkg.product === product);
    assert.equal(pkg.name, manifest.name);
    assert.equal(pkg.outputs.length, 1);
    const entries = readPortableArchiveEntries(path.join(workspace, pkg.outputs[0].path));
    const manifestPath = rust
      ? `${manifest.name}-${manifest.version}/Cargo.toml`
      : 'package/package.json';
    const packedEntry = entries.get(manifestPath);
    assert.ok(packedEntry, `${root}: physical archive must contain its canonical manifest`);
    const packed = rust
      ? Bun.TOML.parse(packedEntry.data().toString()).package
      : JSON.parse(packedEntry.data().toString());
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, info.version);
    assert.ok(info.inputs.includes(`${root}/${rust ? 'Cargo.toml' : 'package.json'}`));
    assert.ok(info.inputs.some((input) => input.startsWith(`${root}/src/`)));
    const actions = info.actions.map((action) => JSON.parse(action));
    assert.ok(
      actions.every((action) => action.mnemonic !== 'TestRunner'),
      'consumer tests are not construction dependencies',
    );
    if (rust) {
      assert.ok(
        actions.every((action) =>
          ['FileWrite', 'ExecutableSymlink', 'CopyToDirectory', 'CargoSourceEnvelope'].includes(
            action.mnemonic,
          ),
        ),
        'a source crate requires packaging without compilation',
      );
      assert.ok(
        !info.inputs.some((input) =>
          /(?:^|\/)(?:rustc|rustdoc)(?:\.exe)?$|\/lib\/rustlib\/|nodejs_|npm_typescript/.test(
            input,
          ),
        ),
        'Cargo source inventory must not consume compilers or target sysroots',
      );
      assert.ok(entries.has(`${manifest.name}-${manifest.version}/THIRD_PARTY_NOTICES.md`));
      assert.ok(!entries.has(`${manifest.name}-${manifest.version}/BUILD.bazel`));
    } else {
      for (const target of ['module', 'commonjs']) {
        assert.ok(
          actions.some(
            (action) => action.target === `//${root}:${target}` && action.mnemonic === 'TsProject',
          ),
          `npm archive must include actual ${target} compilation`,
        );
      }
      assert.ok(
        info.inputs.some((input) => input.includes('npm_typescript')),
        'npm compilation includes its declared TypeScript compiler',
      );
      assert.ok(
        info.inputs.some((input) => input.includes('nodejs_')),
        'npm compilation includes its declared Node runtime',
      );
    }
  }
  console.log(
    JSON.stringify({
      realQueryScenario: name,
      spawns: spawns.map((spawn) => ({ mnemonic: spawn.mnemonic, target: spawn.targetLabel })),
    }),
  );
  queryRecords.push({ scenario: name, producerSpawns: spawns.length });
  return view;
}

try {
  snapshot();
  writeModel();
  diskCacheAcrossFreshBases();
  externalBunEntrypoints();
  cargoBuildScriptParity();
  const allProduction = [
    'config',
    'shared',
    ...products.flatMap((product) => [`${product}_bin`, `${product}_archive`]),
  ];
  scenario('cold complete graph + aggregate/member union', allProduction, [...products]);
  ignoreGeneratedOutputDirectories();
  assert.ok(
    !readdirSync(path.join(outputBase, 'external')).some((name) => name.endsWith('+android_ndk')),
    'unrelated native targets must not acquire the Android NDK merely to register its constraints',
  );
  assert.ok(
    !readdirSync(path.join(outputBase, 'external')).some((name) =>
      name.endsWith('+oliphaunt_android_sdk_archive'),
    ),
    'unrelated native targets must not acquire Android SDK archives merely to register toolchains',
  );
  const sdkProbe = '//tools/bazel/tests/fixtures/android-sdk:selected_sdk';
  const sdkExecutionLog = path.join(scratch, 'selected-sdk.execution.json');
  bazel('build', [sdkProbe, '--noshow_progress', `--execution_log_json_file=${sdkExecutionLog}`]);
  assert.deepEqual(
    parseExecutionLog(readFileSync(sdkExecutionLog, 'utf8')),
    [],
    'observing the selected SDK provider requires no compiler or consumer process',
  );
  const sdkOutput = bazel('cquery', [
    sdkProbe,
    '--output=files',
    '--noshow_progress',
  ]).stdout.trim();
  const sdkExecutionRoot = bazel('info', ['execution_root']).stdout.trim();
  const selectedSdk = JSON.parse(readFileSync(path.join(sdkExecutionRoot, sdkOutput), 'utf8'));
  const sdkPins = Bun.TOML.parse(
    readFileSync(path.join(workspace, 'tools/dev/android-sdk.toml'), 'utf8'),
  ).packages;
  assert.equal(selectedSdk.buildTools, sdkPins.build_tools);
  assert.ok(
    selectedSdk.androidJar.endsWith(`/platforms/android-${sdkPins.compile_sdk}/android.jar`),
  );
  assert.ok(
    selectedSdk.frameworkAidl.endsWith(`/platforms/android-${sdkPins.compile_sdk}/framework.aidl`),
  );
  assert.ok(selectedSdk.adb.endsWith('/platform-tools/adb'));
  for (const field of ['androidJar', 'frameworkAidl', 'adb']) {
    assert.ok(
      selectedSdk[field].startsWith('external/'),
      'SDK tools must come from a declared repository',
    );
    assert.ok(
      existsSync(path.join(outputBase, selectedSdk[field])),
      'selected SDK files must exist',
    );
  }
  assert.equal(
    readFileSync(path.join(outputBase, selectedSdk.androidJar)).subarray(0, 4).toString('hex'),
    '504b0304',
    'the selected Android platform jar must be a physical ZIP archive',
  );
  assert.ok(
    readdirSync(path.join(outputBase, 'external')).some((name) =>
      name.endsWith('+oliphaunt_android_sdk_archive'),
    ),
    'selecting the actual Android SDK provider must materialize its checked archives',
  );
  console.log(JSON.stringify({ selectedAndroidSdk: selectedSdk, producerSpawns: 0 }));
  const initial = shippingState();
  assertEnvelopeIdentities(initial.exported);
  priorView = initial.view;
  for (const mutation of ['missing', 'wrong']) {
    const tampered = structuredClone(initial.exported);
    if (mutation === 'missing') delete tampered.packages[0].outputs[0].owner;
    else tampered.packages[0].outputs[0].owner = tampered.packages[1].outputs[0].owner;
    assert.throws(() => buildShippingInputView(tampered, initial.graph), /owner|nonempty/);
  }
  const incomplete = structuredClone(initial.graph);
  incomplete.actions = incomplete.actions.filter(
    (action: { mnemonic?: string }) => action.mnemonic !== 'FixtureConfigHeader',
  );
  assert.throws(
    () => buildShippingInputView(initial.exported, incomplete),
    /generated|producer|incomplete/,
  );
  assert.deepEqual(
    buildShippingInputView(
      { schema: initial.exported.schema, scope: 'construction', packages: [] },
      initial.graph,
    ).products,
    {},
  );
  scenario('warm identical graph', [], []);
  selection([], []);
  let before = archives();
  model.alpha += 4;
  writeModel();
  scenario('one translation unit', ['alpha_bin', 'alpha_archive'], ['alpha']);
  selection(['alpha.c'], ['alpha']);
  let after = archives();
  unchanged(before, after, ['alpha']);

  before = after;
  model.legal++;
  writeModel();
  scenario(
    'legal envelope only',
    products.map((product) => `${product}_archive`),
    [...products],
  );
  selection(['LEGAL.txt'], [...products]);
  after = archives();
  unchanged(before, after, [...products]);

  before = after;
  model.config++;
  writeModel();
  scenario(
    'configuration input',
    ['config', 'shared', 'alpha_bin', 'beta_bin', 'alpha_archive', 'beta_archive'],
    ['alpha', 'beta'],
  );
  selection(['config.txt'], ['alpha', 'beta']);
  after = archives();
  unchanged(before, after, ['alpha', 'beta']);

  // Release bases are per product: beta already includes this shared edit; alpha does not.
  const older = priorView;
  model.shared++;
  writeModel();
  scenario(
    'shared leaf with distinct product baselines',
    ['shared', 'alpha_bin', 'beta_bin', 'alpha_archive', 'beta_archive'],
    ['alpha', 'beta'],
  );
  const newer = selection(['shared.h'], ['alpha', 'beta']);
  const mixedBaseline = {
    ...newer.view.products,
    'fixture-alpha': older.products['fixture-alpha'],
  };
  assert.deepEqual(
    selectShippingChanges(mixedBaseline, newer.view, {
      'fixture-alpha': [`${fixturePath}/shared.h`],
      'fixture-beta': [],
      'fixture-gamma': [],
    }).affectedProducts,
    ['fixture-alpha'],
    'an already released shared change must not bump beta again',
  );
  assert.throws(
    () =>
      selectShippingChanges(mixedBaseline, newer.view, {
        'fixture-alpha': [`${fixturePath}/shared.h`],
        'fixture-gamma': [],
      }),
    /delta|changed paths|baseline/i,
    'every released product needs its own delta',
  );
  after = archives();

  before = after;
  const packageTool = path.join(fixture, 'package.mts');
  writeFileSync(packageTool, readFileSync(packageTool, 'utf8').replace("+ '\\n'", "+ '\\n\\n'"));
  scenario(
    'package writer tool only',
    products.map((product) => `${product}_archive`),
    [...products],
  );
  selection(['package.mts'], [...products]);
  after = archives();
  unchanged(before, after, [...products]);

  writeFileSync(
    path.join(fixture, 'consumer.mts'),
    readFileSync(path.join(fixture, 'consumer.mts'), 'utf8') +
      '\n// Changed proof harness, never a shipping input.\n',
  );
  scenario('test harness only', [], [...products]);
  selection(['consumer.mts'], [], ['consumer.mts']);
  unchanged(after, archives(), []);

  // Enumerate all small change subsets in a reproducible shuffled order, with independent values.
  let seed = 0x5eed;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const subsets = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let index = subsets.length - 1; index > 0; index--) {
    const destination = next() % (index + 1);
    [subsets[index], subsets[destination]] = [subsets[destination], subsets[index]];
  }
  for (const subset of subsets) {
    before = archives();
    const selected = products.filter((_, index) => subset & (1 << index));
    for (const product of selected) model[product] += (next() % 4) + 1;
    writeModel();
    scenario(
      `seed 0x5eed subset ${subset}`,
      selected.flatMap((product) => [`${product}_bin`, `${product}_archive`]),
      selected,
    );
    selection(
      selected.map((product) => `${product}.c`),
      selected,
    );
    after = archives();
    unchanged(before, after, selected);
  }

  const build = path.join(fixture, 'BUILD.bazel');
  const originalBuild = readFileSync(build, 'utf8');
  writeFileSync(
    build,
    originalBuild.replace(
      'product_id = "fixture-beta", version = "2.0.0"',
      'product_id = "fixture-beta", version = "2.0.1"',
    ),
  );
  scenario('one identity version', ['beta_archive'], ['beta']);
  selection(['BUILD.bazel'], ['beta'], ['BUILD.bazel']);
  writeFileSync(build, originalBuild);
  // Restoring a previous test variant may rerun it; the immediately repeated request must then be warm.
  scenario('restore identity', ['beta_archive'], ['beta']);
  selection(['BUILD.bazel'], ['beta'], ['BUILD.bazel']);
  scenario('warm restored graph', [], []);

  const mirrorBuild =
    originalBuild +
    '\nshipping_package(name = "alpha_mirror_ship", owner = ":alpha_identity", artifacts = [":alpha_archive"], ecosystem = "github", package_name = "fixture-alpha-mirror", configuration = "fixture-host", role = "package")\nshipping_export(name = "mirror_export", packages = [":alpha_ship", ":alpha_mirror_ship", ":beta_ship", ":gamma_ship"])\n';
  writeFileSync(build, mirrorBuild);
  scenario('two carriers share one product identity', [], [], 'mirror_export');
  const sharedOwnerBefore = shippingState('mirror_export');
  assert.equal(sharedOwnerBefore.view.products['fixture-alpha'].packages.length, 2);
  writeFileSync(
    build,
    mirrorBuild.replace(
      'product_id = "fixture-alpha", version = "1.0.0"',
      'product_id = "fixture-alpha", version = "1.0.1"',
    ),
  );
  scenario(
    'shared owner version updates both carriers once',
    ['alpha_archive'],
    ['alpha'],
    'mirror_export',
  );
  const sharedOwnerAfter = shippingState('mirror_export');
  assertEnvelopeIdentities(sharedOwnerAfter.exported);
  assert.deepEqual(
    sharedOwnerAfter.exported.packages
      .filter((pkg: { product: string }) => pkg.product === 'fixture-alpha')
      .map((pkg: { version: string }) => pkg.version),
    ['1.0.1', '1.0.1'],
  );
  assert.deepEqual(
    selectShippingChanges(
      sharedOwnerBefore.view.products,
      sharedOwnerAfter.view,
      Object.fromEntries(
        products.map((product) => [`fixture-${product}`, [`${fixturePath}/BUILD.bazel`]]),
      ),
    ).affectedProducts,
    ['fixture-alpha'],
  );
  writeFileSync(build, originalBuild);
  scenario('restore shared owner fixture', ['alpha_archive'], ['alpha']);
  writeFileSync(
    build,
    originalBuild +
      '\nshipping_package(name = "shared_alpha_input", owner = ":alpha_identity", artifacts = [":config"], ecosystem = "github", package_name = "shared-control.h", configuration = "portable", role = "release-input")\nshipping_package(name = "shared_beta_input", owner = ":beta_identity", artifacts = [":config"], ecosystem = "github", package_name = "shared-control.h", configuration = "portable", role = "release-input")\nshipping_export(name = "shared_input_export", packages = [":shared_alpha_input", ":shared_beta_input"])\n',
  );
  scenario('shared candidate input across component owners', [], [], 'shared_input_export');
  const sharedInput = shippingState('shared_input_export');
  assert.deepEqual(Object.keys(sharedInput.view.products).sort(), [
    'fixture-alpha',
    'fixture-beta',
  ]);
  assert.deepEqual(
    sharedInput.exported.packages[0].outputs,
    sharedInput.exported.packages[1].outputs,
  );
  assert.deepEqual(
    sharedInput.view.products['fixture-alpha'].actions,
    sharedInput.view.products['fixture-beta'].actions,
    'one physical producer is shared without inventing a second producer',
  );
  writeFileSync(build, originalBuild);
  priorView = shippingState().view;

  renameSync(path.join(fixture, 'alpha.c'), path.join(fixture, 'renamed-alpha.c'));
  writeFileSync(build, originalBuild.replace('srcs = ["alpha.c"]', 'srcs = ["renamed-alpha.c"]'));
  scenario('rename consumed source', ['alpha_bin', 'alpha_archive'], ['alpha']);
  selection(['alpha.c', 'renamed-alpha.c', 'BUILD.bazel'], ['alpha'], ['BUILD.bazel']);
  const renamed = readFileSync(path.join(fixture, 'renamed-alpha.c'));
  rmSync(path.join(fixture, 'renamed-alpha.c'));
  bazel('build', [`${label}:alpha_archive`, '--noshow_progress'], true);
  writeFileSync(path.join(fixture, 'renamed-alpha.c'), renamed);

  const badCases = [
    {
      name: 'missing_owner',
      body: `shipping_package(name = "bad_ship", owner = ":shared", artifacts = [":alpha_archive"], ecosystem = "github", package_name = "bad", configuration = "fixture-host", role = "package")`,
      target: 'bad_ship',
      message: 'ReleaseIdentityInfo',
    },
    {
      name: 'empty_payload',
      body: `shipping_package(name = "bad_ship", owner = ":alpha_identity", artifacts = [], ecosystem = "github", package_name = "bad", configuration = "fixture-host", role = "package")`,
      target: 'bad_ship',
      message: 'actual output files',
    },
    {
      name: 'duplicate_identity',
      body: `shipping_package(name = "bad_ship", owner = ":alpha_identity", artifacts = [":alpha_archive"], ecosystem = "github", package_name = "fixture-alpha", configuration = "fixture-host", role = "package")\nshipping_export(name = "bad_export", packages = [":alpha_ship", ":bad_ship"])`,
      target: 'bad_export',
      message: 'duplicate shipping identity',
    },
    {
      name: 'conflicting_product_versions',
      body: `release_identity(name = "bad_identity", product_id = "fixture-alpha", version = "9.0.0")\nshipping_package(name = "bad_ship", owner = ":bad_identity", artifacts = [":alpha_archive"], ecosystem = "github", package_name = "fixture-alpha-other", configuration = "fixture-host", role = "package")\nshipping_export(name = "bad_export", packages = [":alpha_ship", ":bad_ship"])`,
      target: 'bad_export',
      message: 'inconsistent shipping version',
    },
  ];
  const renamedBuild = readFileSync(build, 'utf8');
  for (const bad of badCases) {
    writeFileSync(build, `${renamedBuild}\n${bad.body}\n`);
    const result = bazel('build', [`${label}:${bad.target}`, '--noshow_progress'], true);
    assert.ok(
      result.stderr.includes(bad.message),
      `${bad.name}: expected contract rejection, got ${result.stderr}`,
    );
  }
  writeFileSync(build, renamedBuild);
  scenario('warm after rejected ownership/analysis mutations', [], []);

  // Construction exports are not payload certificates: an independent envelope oracle catches a forged claim.
  writeFileSync(
    build,
    renamedBuild +
      '\nshipping_package(name = "forged_ship", owner = ":beta_identity", artifacts = [":alpha_archive"], ecosystem = "github", package_name = "fixture-forged", configuration = "fixture-host", role = "package")\nshipping_export(name = "forged_export", packages = [":forged_ship"])\n',
  );
  bazel('build', [`${label}:forged_export`, '--noshow_progress']);
  const forged = shippingState('forged_export');
  assert.throws(() => assertEnvelopeIdentities(forged.exported), /package version|package owner/);
  writeFileSync(build, renamedBuild);

  // A warm repository import must observe both pin and converter changes.
  for (const watched of [
    {
      file: '.prototools',
      change: (text: string) => text.replace(/^node = .*$/m, 'node = "latest"'),
      error: /pin|exact|version/,
    },
    {
      file: 'bun.lock',
      change: (text: string) =>
        text.replace(/("catalog":\s*\{[^}]*"typescript":\s*)"[^"]+"/, '$1"^0.0.0"'),
      error: /stale catalog/,
    },
    {
      file: 'build_defs/foundation/toolchain-metadata.mts',
      change: (text: string) =>
        `${text}\nthrow new Error("conformance watched converter change");\n`,
      error: /conformance watched converter change/,
    },
    {
      file: 'src/query/rust/Cargo.toml',
      change: (text: string) => `${text}\n[dependencies]\nserde = "1"\n`,
      error: /dependencies|does not yet support/,
    },
  ]) {
    const file = path.join(workspace, watched.file);
    const original = readFileSync(file, 'utf8');
    bazel('build', ['@oliphaunt_toolchain_metadata//:toolchains.json', '--noshow_progress']);
    writeFileSync(file, watched.change(original));
    const rejected = bazel(
      'build',
      ['@oliphaunt_toolchain_metadata//:toolchains.json', '--noshow_progress'],
      true,
    );
    assert.match(rejected.stderr, watched.error, 'warm import must reject newly invalid source');
    writeFileSync(file, original);
    bazel('build', ['@oliphaunt_toolchain_metadata//:toolchains.json', '--noshow_progress']);
  }
  const buildScript = path.join(workspace, 'src/query/rust/build.rs');
  assert.ok(
    !existsSync(buildScript),
    'query fixture starts without an implicit Cargo build script',
  );
  writeFileSync(buildScript, 'fn main() {}\n');
  assert.match(
    bazel('build', ['@oliphaunt_toolchain_metadata//:toolchains.json', '--noshow_progress'], true)
      .stderr,
    /automatically discovered build.rs/,
  );
  rmSync(buildScript);
  bazel('build', ['@oliphaunt_toolchain_metadata//:toolchains.json', '--noshow_progress']);

  const domain = () => {
    bazel('build', ['@oliphaunt_metadata//:metadata.bzl', '--noshow_progress']);
    const file = bazel('cquery', [
      '@oliphaunt_metadata//:metadata.bzl',
      '--output=files',
      '--noshow_progress',
    ]).stdout.trim();
    const executionRoot = bazel('info', ['execution_root']).stdout.trim();
    return readFileSync(path.join(executionRoot, file), 'utf8');
  };
  const domainBefore = domain();
  const partialNativeInputs = path.join(scratch, 'partial-native-inputs.json');
  writeFileSync(
    partialNativeInputs,
    JSON.stringify({
      source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      nativeCurrentArtifacts: [],
    }),
  );
  const scopedLabels = [
    '//build_defs/languages:source_package_test',
    '//src/wasix/node-addon:tools/carrier-contract.mts',
  ];
  const scopedQuery = `set(${scopedLabels.join(' ')})`;
  for (const state of ['cold', 'warm'])
    assert.deepEqual(
      bazel('query', [
        scopedQuery,
        `--repo_env=OLIPHAUNT_NATIVE_PUBLICATION_INPUTS=${partialNativeInputs}`,
        '--output=label',
        '--noshow_progress',
      ])
        .stdout.trim()
        .split('\n')
        .sort(),
      scopedLabels,
      `${state} scoped current artifacts must not require unrelated WASIX archives at package loading`,
    );
  assert.match(
    bazel(
      'cquery',
      [
        '//src/wasix/node-addon:release_inputs',
        `--repo_env=OLIPHAUNT_NATIVE_PUBLICATION_INPUTS=${partialNativeInputs}`,
        '--noshow_progress',
      ],
      true,
    ).stderr,
    /WASIX addon is missing its original current contrib frozen File/,
    'selected WASIX construction still requires the original frozen File',
  );
  assert.deepEqual(
    bazel('query', [scopedQuery, '--output=label', '--noshow_progress'])
      .stdout.trim()
      .split('\n')
      .sort(),
    scopedLabels,
    'removing scoped current artifacts restores ordinary package loading',
  );
  assert.equal(domain(), domainBefore, 'removing scoped inputs restores exact domain metadata');
  const iosPackage = '//src/examples/native/react-native-expo';
  assert.equal(
    JSON.parse(
      readFileSync(path.join(workspace, 'src/examples/native/react-native-expo/app.json'), 'utf8'),
    ).expo.ios.icon,
    './assets/expo.icon',
  );
  for (const attribute of ['app_icons', 'resources']) {
    const labels = bazel('query', [
      `labels(${attribute}, ${iosPackage}:ios_release)`,
      '--output=label',
      '--noshow_progress',
    ])
      .stdout.trim()
      .split('\n')
      .sort();
    assert.ok(
      !labels.some((file) => file.includes('AppIcon_appiconset')),
      `${attribute} must not mix legacy icons with Icon Composer`,
    );
    if (attribute === 'app_icons')
      assert.deepEqual(labels, [
        `${iosPackage}:ios_app_expo_icon_Assets_expo_symbol_2_svg`,
        `${iosPackage}:ios_app_expo_icon_Assets_grid_png`,
        `${iosPackage}:ios_app_expo_icon_icon_json`,
      ]);
  }
  const lockedAcquisition = () =>
    bazel('query', ['@pgvector//:all', '--lockfile_mode=error', '--noshow_progress']);
  lockedAcquisition();
  const moduleLock = readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8');
  const absentRecipe = path.join(workspace, 'src/extensions/external/vector/recipe.toml');
  assert.ok(
    !existsSync(absentRecipe),
    'recipe watch fixture starts with an absent optional source',
  );
  writeFileSync(absentRecipe, 'sql_name = "wrong"\n');
  assert.match(
    bazel('build', ['@oliphaunt_metadata//:metadata.bzl', '--noshow_progress'], true).stderr,
    /recipe disagrees/,
  );
  rmSync(absentRecipe);
  assert.equal(
    domain(),
    domainBefore,
    'removing an invalid new recipe restores the exact domain projection',
  );
  const dependenciesDirectory = path.join(workspace, 'src/extensions/external/vector/dependencies');
  const hadDependenciesDirectory = existsSync(dependenciesDirectory);
  const addedDependency = path.join(dependenciesDirectory, 'conformance_fixture');
  const missingDependency = path.join(dependenciesDirectory, 'conformance_missing_pin');
  assert.ok(!existsSync(addedDependency) && !existsSync(missingDependency));
  mkdirSync(addedDependency, { recursive: true });
  const dependencyPin = Bun.TOML.parse(
    readFileSync(path.join(workspace, 'src/extensions/external/vector/source.toml'), 'utf8'),
  );
  writeFileSync(
    path.join(addedDependency, 'source.toml'),
    `name = "conformance_fixture"\nurl = ${JSON.stringify(dependencyPin.url)}\ncommit = ${JSON.stringify(dependencyPin.commit)}\n\n[archive]\nsha256 = ${JSON.stringify(dependencyPin.archive.sha256)}\n`,
  );
  assert.match(
    domain(),
    /EXTENSION_DEPENDENCIES = [^\n]*"vector": \{[^\n]*"conformance_fixture":/,
    'a warm import must notice a newly added dependency directory',
  );
  bazel('query', ['@pgvector//:all', '--lockfile_mode=update', '--noshow_progress']);
  assert.notEqual(
    readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8'),
    moduleLock,
    'new dependency source pins change acquisition provenance',
  );
  mkdirSync(missingDependency);
  const missingPin = bazel(
    'build',
    ['@oliphaunt_metadata//:metadata.bzl', '--noshow_progress'],
    true,
  );
  assert.match(missingPin.stderr, /conformance_missing_pin/);
  assert.match(missingPin.stderr, /source\.toml/);
  rmSync(missingDependency, { recursive: true });
  rmSync(addedDependency, { recursive: true });
  if (!hadDependenciesDirectory) rmdirSync(dependenciesDirectory);
  assert.equal(
    domain(),
    domainBefore,
    'restoring directory membership restores exact domain metadata',
  );
  bazel('query', ['@pgvector//:all', '--lockfile_mode=update', '--noshow_progress']);
  lockedAcquisition();
  assert.equal(
    readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8'),
    moduleLock,
    'restored acquisition facts restore the original native lock',
  );
  const versionsFile = path.join(workspace, '.release-please-manifest.json');
  const versionSource = readFileSync(versionsFile, 'utf8');
  const cargoFile = path.join(workspace, 'src/query/rust/Cargo.toml');
  const cargoSource = readFileSync(cargoFile, 'utf8');
  const cargoPackage = Bun.TOML.parse(cargoSource).package;
  const nextVersion = `${Number(cargoPackage.version.split('.')[0]) + 1}.0.0`;
  const cargoLockFile = path.join(workspace, 'Cargo.lock');
  const cargoLockSource = readFileSync(cargoLockFile, 'utf8');
  const registryQueryRecords = Bun.TOML.parse(cargoLockSource).package.filter(
    (record: { name: string; source?: string }) =>
      record.name === cargoPackage.name && record.source,
  );
  assert.ok(registryQueryRecords.length, 'consumers require a separately resolved registry query');
  let localQueryRecords = 0;
  const bumpedCargoLock = cargoLockSource
    .split(/(?=^\[\[package\]\]$)/m)
    .map((block) => {
      const record = Bun.TOML.parse(block).package?.[0];
      if (record?.name !== cargoPackage.name || record.source) return block;
      localQueryRecords++;
      assert.equal(record.version, cargoPackage.version, 'local Cargo lock must match its source');
      return block.replace(/^version = .*$/m, `version = "${nextVersion}"`);
    })
    .join('');
  assert.equal(localQueryRecords, 1, 'change only the uniquely resolved local query version');
  const lockedLanguages = () =>
    bazel('query', [
      'set(//src/query/rust:oliphaunt_query @rust_toolchains//:all)',
      '--lockfile_mode=error',
      '--noshow_progress',
    ]);
  const toolchainProjection = (fileName: string) => {
    const file = bazel('cquery', [
      `@oliphaunt_toolchain_metadata//:${fileName}`,
      '--output=files',
      '--noshow_progress',
    ]).stdout.trim();
    // Analysis materializes the external repository, but may not recreate its
    // execution-root symlink after a warm repository-rule re-import.
    assert.ok(file.startsWith('external/'), 'toolchain projection is a repository source file');
    return readFileSync(path.join(outputBase, file), 'utf8');
  };
  lockedLanguages();
  const acquisitionBefore = toolchainProjection('toolchains.json');
  const typedRustBefore = toolchainProjection('query-rust.bzl');
  const cargoAcquisition = () => {
    const expected = ['Cargo.toml', 'Cargo.lock', 'src/query/rust/Cargo.toml'];
    const files = bazel('cquery', [
      `set(${expected.map((file) => `@native_cargo_metadata//:${file}`).join(' ')})`,
      '--output=files',
      '--noshow_progress',
    ])
      .stdout.trim()
      .split('\n');
    assert.equal(files.length, expected.length);
    const projection = Object.fromEntries(
      files.map((file) => {
        assert.ok(file.startsWith('external/'));
        const relative = file.split('/').slice(2).join('/');
        assert.ok(expected.includes(relative), `unexpected Cargo acquisition input ${file}`);
        return [relative, readFileSync(path.join(outputBase, file), 'utf8')];
      }),
    );
    assert.equal(Object.keys(projection).length, expected.length);
    return projection;
  };
  const cargoAcquisitionBefore = cargoAcquisition();
  const heldQueryDependencyGraph = () => {
    const graph = bazel('cquery', [
      'filter("oliphaunt_query", deps(set(//src/native/sdks/rust:lib //src/wasix/sdks/rust:lib //src/native/broker:lib //src/wasix/pgwire-server:lib)))',
      '--config=wasix-aot',
      '--output=label',
      '--platforms=//build_defs/native:linux_x86_64_glibc_2_28',
      '--host_platform=//build_defs/native:linux_x86_64_glibc_2_28',
      '--noshow_progress',
    ]).stdout.trim();
    assert.ok(graph, 'configured SDK/helper consumers must resolve the held registry query');
    assert.ok(!graph.includes('//src/query/rust:'), 'held consumers must exclude the local query');
    for (const line of graph.split('\n')) {
      assert.ok(
        registryQueryRecords.some((record: { version: string }) =>
          line.includes(`oliphaunt-query-${record.version}//`),
        ),
        `query dependency must be a genuine held Cargo registry record: ${line}`,
      );
    }
    return graph;
  };
  const heldQueryGraphBefore = heldQueryDependencyGraph();
  const queryBefore = realQueryShipping('cold-real-query-packages', [
    '//src/query/rust:crate',
    '//src/query/ts:npm',
    '//src/query/ts:module',
    '//src/query/ts:commonjs',
    '//src/query/ts:.aspect_rules_js/node_modules/@types/node',
    '//src/query/ts:.aspect_rules_js/node_modules/undici-types',
    '@@aspect_rules_ts++typescript+npm_typescript//:.aspect_rules_js/node_modules/typescript',
  ]);
  realQueryShipping('warm-identical-real-query-packages', [], 0);
  const versions = JSON.parse(versionSource);
  versions['src/query/rust'] = nextVersion;
  writeFileSync(versionsFile, JSON.stringify(versions));
  writeFileSync(cargoFile, cargoSource.replace(/^version = .*$/m, `version = "${nextVersion}"`));
  writeFileSync(cargoLockFile, bumpedCargoLock);
  assert.deepEqual(
    Bun.TOML.parse(bumpedCargoLock).package.filter(
      (record: { name: string; source?: string }) =>
        record.name === cargoPackage.name && record.source,
    ),
    registryQueryRecords,
    'a local major version bump must preserve the genuine held registry query identity',
  );
  assert.ok(
    domain().includes(`"version": "${nextVersion}"`),
    'domain import must observe the conventional Cargo version mirror',
  );
  lockedLanguages();
  assert.equal(
    toolchainProjection('toolchains.json'),
    acquisitionBefore,
    'Cargo product versions are not language acquisition facts',
  );
  assert.deepEqual(
    cargoAcquisition(),
    cargoAcquisitionBefore,
    'a coherent local major version bump must preserve Cargo acquisition inputs',
  );
  assert.equal(
    heldQueryDependencyGraph(),
    heldQueryGraphBefore,
    'independently versioned SDK/helper consumers retain their configured held query dependency',
  );
  const typedRustAfter = toolchainProjection('query-rust.bzl');
  assert.notEqual(typedRustAfter, typedRustBefore);
  assert.ok(typedRustAfter.includes(`QUERY_RUST_VERSION = "${nextVersion}"`));
  assert.ok(typedRustAfter.includes(`"CARGO_PKG_VERSION": "${nextVersion}"`));
  const queryAfter = realQueryShipping(
    'one-real-cargo-package-version',
    ['//src/query/rust:crate'],
    1,
  );
  const rustProduct = JSON.parse(
    readFileSync(path.join(workspace, 'release-please-config.json'), 'utf8'),
  ).packages['src/query/rust'].component;
  const actualDeltas = Object.fromEntries(
    Object.keys(queryBefore.products).map((product) => [
      product,
      ['src/query/rust/Cargo.toml', 'Cargo.lock', '.release-please-manifest.json'],
    ]),
  );
  const querySelection = selectShippingChanges(queryBefore.products, queryAfter, actualDeltas);
  assert.deepEqual(
    querySelection.affectedProducts,
    [rustProduct],
    'one Cargo product version must not release the independently versioned npm package',
  );
  assert.deepEqual(querySelection.unclassifiedPaths, [
    '.release-please-manifest.json',
    'Cargo.lock',
  ]);
  lockedAcquisition();
  assert.equal(
    readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8'),
    moduleLock,
    'public version changes must not rewrite source-acquisition locks',
  );
  writeFileSync(versionsFile, versionSource);
  writeFileSync(cargoFile, cargoSource);
  writeFileSync(cargoLockFile, cargoLockSource);
  lockedLanguages();
  assert.equal(toolchainProjection('toolchains.json'), acquisitionBefore);
  assert.equal(toolchainProjection('query-rust.bzl'), typedRustBefore);
  assert.deepEqual(cargoAcquisition(), cargoAcquisitionBefore);
  assert.equal(heldQueryDependencyGraph(), heldQueryGraphBefore);
  realQueryShipping('restore-real-cargo-package-version', ['//src/query/rust:crate'], 1);
  const carriersFile = path.join(workspace, 'src/extensions/contrib/carriers.toml');
  const ownerSource = readFileSync(carriersFile, 'utf8');
  writeFileSync(
    carriersFile,
    ownerSource.replace('native_owner = "liboliphaunt-native"', 'native_owner = "oliphaunt-query"'),
  );
  assert.match(
    bazel('build', ['@oliphaunt_metadata//:metadata.bzl', '--noshow_progress'], true).stderr,
    /oliphaunt-query release\.toml must declare artifact_targets/,
    'a publication owner without the supported carrier targets is invalid',
  );
  writeFileSync(carriersFile, ownerSource);
  assert.equal(
    domain(),
    domainBefore,
    'restoring version and owner sources restores the exact domain projection',
  );
  lockedAcquisition();
  assert.equal(
    readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8'),
    moduleLock,
    'rejected publication ownership must not rewrite source-acquisition locks',
  );
  scenario('rejected publication owner keeps unrelated consumers cached', [], []);
  const extensionSourceFile = path.join(workspace, 'src/extensions/external/vector/source.toml');
  const extensionSource = readFileSync(extensionSourceFile, 'utf8');
  writeFileSync(
    extensionSourceFile,
    extensionSource
      .replace(/^branch = .*$/m, 'branch = "conformance-metadata-only"')
      .replace(/^default-version = .*$/m, 'default-version = "9.8.7"'),
  );
  const updatedDomain = domain();
  assert.match(updatedDomain, /"branch": "conformance-metadata-only"/);
  assert.match(updatedDomain, /"default-version": "9\.8\.7"/);
  lockedAcquisition();
  assert.equal(
    readFileSync(path.join(workspace, 'MODULE.bazel.lock'), 'utf8'),
    moduleLock,
    'branch and extension-control metadata must not rewrite immutable source-acquisition locks',
  );
  scenario('non-acquisition extension metadata keeps unrelated consumers cached', [], []);
  writeFileSync(extensionSourceFile, extensionSource);
  assert.equal(
    domain(),
    domainBefore,
    'restoring extension metadata restores the exact domain projection',
  );
  scenario('warm after restored external import sources', [], []);
  console.log(
    JSON.stringify({
      seed: '0x5eed',
      scenarios: records.length,
      testAttempts: records.reduce((total, record) => total + record.tests.length, 0),
      producerSpawns: records.reduce(
        (total, record) =>
          total + Object.values(record.production).reduce((sum, count) => sum + count, 0),
        0,
      ),
      zeroSpawnScenarios: records.filter(
        (record) => record.tests.length === 0 && Object.keys(record.production).length === 0,
      ).length,
      realPackageScenarios: queryRecords.length,
      realPackageProducerSpawns: queryRecords.reduce(
        (total, record) => total + record.producerSpawns,
        0,
      ),
      realPackageZeroSpawnScenarios: queryRecords.filter((record) => record.producerSpawns === 0)
        .length,
    }),
  );
  completed = true;
} finally {
  if (existsSync(wrapper)) {
    const stopped = spawnSync('bash', [wrapper, ...startupOptions, 'shutdown'], {
      cwd: workspace,
      timeout: 30_000,
      env: subprocessEnvironment,
    });
    if (completed)
      assert.equal(stopped.status, 0, 'isolated Bazel server must stop before cleanup');
  }
  if (completed) removePrivateScratch(scratch);
  else console.error(`Conformance failure preserved at ${scratch}; seed 0x5eed.`);
}
