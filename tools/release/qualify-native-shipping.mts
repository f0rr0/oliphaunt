#!/usr/bin/env bun
import assert from 'node:assert/strict';
/** Build shipping roots once and retain configured construction evidence. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  captureConfiguredCiRequest,
  writeConfiguredCiSuccessReceipt,
} from '../ci/configured-scope.mts';
import { completedCiRequestRoots } from '../ci/run-configured-request.mts';
import { requireSafeDirectoryChain } from '../packaging/release-directory-safety.mts';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  NATIVE_AQUERY_FLAGS,
  type NativeBuildEvidence,
  type NativeBuildGithub,
  type NativeRequiredTest,
  nativeAqueryExpression,
  nativeBuildEventIndex,
  nativeBuildMetadata,
} from './native-build-qualification.mts';
import {
  nativeConfiguredRecipeGraph,
  nativeConfiguredWorkspaceLabel,
  nativeRecipeInputPaths,
} from './native-configured-inputs.mts';
import { readNativePublicationArtifacts } from './native-publication-artifacts.mts';
import {
  captureNativeOutputMembers,
  captureNativePublicationOutputs,
} from './native-publication-staging.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import {
  assertWasixPublicationPackages,
  discoverProductArtifacts,
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  validateCargoPayloadPartSets,
} from './publication-lock.mts';

export type NativeShippingRequest = {
  ci?: { id: string; job: string; mode: 'full' | 'source'; requires: string[]; handoff?: boolean };
  github: NativeBuildGithub;
  startup?: string[];
  configuration: string[];
  shipping: { export: string } | { roots: string[] };
  targets?: string[];
  completeProducts?: string[];
  outputDirectory: string;
};

function argv(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item || /[\u0000-\u001f\u007f]/u.test(item))
  )
    throw new Error(`${context} must be an array of nonempty argv strings`);
  return value;
}

const label = nativeConfiguredWorkspaceLabel;
function json(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export {
  nativeConfiguredRecipeGraph,
  nativeRecipeInputPaths,
} from './native-configured-inputs.mts';

/** Policy edges name actual tests; cquery cannot expand test_suite or tests(). */
function configuredQualificationTests(raw: unknown): NativeRequiredTest[] {
  const query = raw as {
    configurations?: { id: number; checksum: string }[];
    results?: {
      target?: { rule?: { name: string; ruleClass: string } };
      configurationId: number;
    }[];
  };
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new Error('shipping qualification requires configured policy query results');
  const configurations = new Map<number, string>();
  for (const row of query.configurations ?? []) {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      configurations.has(row.id) ||
      !/^[a-f0-9]{64}$/u.test(row.checksum)
    )
      throw new Error('shipping qualification requires unique configured policy checksums');
    configurations.set(row.id, row.checksum);
  }
  const tests = (query.results ?? []).map((result) => {
    const rule = result.target?.rule;
    const configuration = configurations.get(result.configurationId);
    if (!rule?.ruleClass.endsWith('_test') || !configuration)
      throw new Error('shipping qualification policy must declare configured actual test rules');
    return { label: label(rule.name), configuration };
  });
  if (new Set(tests.map((test) => test.label)).size !== tests.length)
    throw new Error('shipping qualification policy requires one configuration per test rule');
  return tests.sort((left, right) => left.label.localeCompare(right.label));
}

/** A complete family must survive the conventional readers before and after freezing its outputs. */
function checkCompleteProducts(evidence: NativeBuildEvidence, products: string[]) {
  const catalog = loadPublicationCatalog('native shipping qualification');
  const selected = new Set(products);
  const authority = {
    catalog,
    artifactRows: expectedProductArtifactRows(catalog.products),
    resolveCarrier: (ecosystem: string, name: string) =>
      resolveActualCarrier(catalog, ecosystem, name, 'native shipping qualification'),
  };
  const cohorts = evidence.cohorts
    .map((cohort) => ({
      ...cohort,
      roots: cohort.roots.filter(({ package: pkg }) => selected.has(pkg.product)),
    }))
    .filter((cohort) => cohort.roots.length);
  const outputs = captureNativePublicationOutputs(cohorts, {
    sourceCommit: evidence.source.commit,
  });
  for (const cohort of cohorts) {
    const declared = new Set(
      cohort.roots
        .filter(({ package: pkg }) => pkg.ecosystem !== 'internal')
        .flatMap(({ package: pkg }) => pkg.outputs.map(({ path: file }) => file)),
    );
    for (const file of declared) {
      const expected = cohort.outputs.find(({ path: output }) => output === file);
      if (!expected)
        throw new Error('native complete-family output is missing from build evidence');
      assert.deepStrictEqual(
        captureNativeOutputMembers(cohort.executionRoot, file).members,
        expected.members,
        'native complete-family output differs from build evidence',
      );
    }
  }
  const physical = readNativePublicationArtifacts(authority, cohorts, { products });
  const staged = outputs.stage();
  const registry = discoverPublicationArtifacts(staged);
  assertWasixPublicationPackages(registry);
  validateCargoPayloadPartSets(
    registry.map((record) => ({
      ...authority.resolveCarrier(record.ecosystem, record.name),
      packageDependencies: record.dependencies,
    })),
  );
  const publicFiles = discoverProductArtifacts(
    staged,
    catalog.products.filter(({ id }) => selected.has(id)),
  );
  const registryBytes = (records: typeof registry) =>
    records
      .map((record) => ({
        ecosystem: record.ecosystem,
        name: record.name,
        version: record.version,
        dependencies: record.dependencies,
        qualificationOnly: record.qualificationOnly,
        artifacts: record.artifacts.map(({ size, sha256 }) => ({ size, sha256 })),
      }))
      .sort((left, right) =>
        `${left.ecosystem}:${left.name}`.localeCompare(`${right.ecosystem}:${right.name}`),
      );
  const publicBytes = (records: typeof publicFiles) =>
    records
      .map(({ path: _path, ...record }) => record)
      .sort((left, right) =>
        `${left.product}:${left.id}`.localeCompare(`${right.product}:${right.id}`),
      );
  assert.deepStrictEqual(registryBytes(registry), registryBytes(physical.registryArtifacts));
  assert.deepStrictEqual(publicBytes(publicFiles), publicBytes(physical.productArtifacts));
}

/** The caller keeps this checkout and its producer inputs frozen through capture. */
export async function qualifyNativeShipping(
  request: NativeShippingRequest,
  directory = process.cwd(),
) {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  const workspace = git('rev-parse', '--show-toplevel');
  const source = {
    commit: git('rev-parse', 'HEAD^{commit}'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  };
  const assertSource = () => {
    try {
      execFileSync(
        'bash',
        ['tools/release/qualified-release-replay.sh', source.commit, source.commit],
        {
          cwd: workspace,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
    } catch (cause) {
      throw new Error(
        'shipping qualification requires a clean checkout without index suppression flags',
        { cause },
      );
    }
    if (
      git('rev-parse', 'HEAD^{commit}') !== source.commit ||
      git('rev-parse', 'HEAD^{tree}') !== source.tree
    )
      throw new Error('shipping qualification source changed during construction');
  };
  assertSource();
  const startup = argv(request.startup ?? [], 'startup');
  if (startup.includes('--')) throw new Error('startup cannot contain an argv separator');
  const configuration = argv(request.configuration, 'configuration');
  if (
    configuration.some(
      (item) =>
        item === '--' ||
        /^--(?:build_metadata|build_event_json_file|execution_log_compact_file|execution_log_json_file|execution_log_binary_file|output|output_file|output_groups|profile|query_file|starlark:file|starlark:expr|experimental_aquery_dump_after_build_format|experimental_aquery_dump_after_build_output_file)(?:=|$)/u.test(
          item,
        ),
    )
  )
    throw new Error('configuration cannot override qualification metadata or query output');
  const targets = argv(request.targets ?? [], 'additional targets').map(label);
  const completeProducts = argv(request.completeProducts ?? [], 'complete products');
  if (new Set(completeProducts).size !== completeProducts.length)
    throw new Error('complete products must be unique');
  const metadata = Object.entries(nativeBuildMetadata(source, request.github)).map(
    ([key, value]) => `--build_metadata=${key}=${value}`,
  );
  const output = requireSafeDirectoryChain(path.resolve(workspace, request.outputDirectory), {
    create: true,
    label: 'shipping qualification',
  });
  const file = (name: string) => path.join(output, name);
  const diagnostics = requireSafeDirectoryChain(file('diagnostics'), {
    create: true,
    label: 'shipping qualification diagnostics',
  });
  const diagnosticFile = (name: string) => path.join(diagnostics, name);
  writeFileSync(file('github.json'), `${JSON.stringify(request.github)}\n`, { flag: 'wx' });
  writeFileSync(file('configuration.json'), `${JSON.stringify(configuration)}\n`, { flag: 'wx' });
  writeFileSync(file('startup.json'), `${JSON.stringify(startup)}\n`, { flag: 'wx' });
  const phase = (name: string) => {
    const started = Date.now();
    console.error(`native qualification: ${name} started`);
    return () =>
      console.error(`native qualification: ${name} finished in ${Date.now() - started} ms`);
  };
  const run = (name: string, command: string, args: string[], stdout?: string) => {
    const finish = phase(name);
    const fd = stdout === undefined ? undefined : openSync(stdout, 'wx');
    try {
      const result = spawnSync(command, args, {
        cwd: workspace,
        stdio: ['ignore', fd ?? 'inherit', 'inherit'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `shipping qualification ${command} ${args[0] ?? ''} failed (${result.signal ?? result.status})`,
        );
    } finally {
      if (fd !== undefined) closeSync(fd);
      finish();
    }
  };
  const bazel = (args: string[], stdout?: string) =>
    run(args[0], 'bash', ['tools/dev/bazel.sh', ...startup, ...args], stdout);
  const captureQueryDiagnostics = async () => {
    try {
      const base = startup.find((arg) => arg.startsWith('--output_base='))?.slice(14);
      if (!base || process.platform === 'win32') return;
      const server = path.join(path.resolve(workspace, base), 'server');
      const pid = readFileSync(path.join(server, 'server.pid.txt'), 'utf8').trim();
      if (!/^[1-9][0-9]*$/u.test(pid)) throw new Error('invalid Bazel server PID');
      const command = execFileSync('ps', ['-p', pid, '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 2000,
        killSignal: 'SIGKILL',
      }).trim();
      if (!/^(?:(?:.*\/)?java|bazel(?:\(.*\))?)$/u.test(command))
        throw new Error('Bazel server PID does not name its JVM');
      const log = path.resolve(
        workspace,
        startup.find((arg) => arg.startsWith('--server_jvm_out='))?.slice(17) ??
          path.join(server, 'jvm.out'),
      );
      const offset = statSync(log).size;
      process.kill(Number(pid), 'SIGQUIT');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // Retain only the new thread dump; earlier server output can contain action diagnostics.
      const snapshot = Buffer.alloc(
        Math.min(2 * 1024 * 1024, Math.max(0, statSync(log).size - offset)),
      );
      const fd = openSync(log, 'r');
      try {
        const bytes = readSync(fd, snapshot, 0, snapshot.length, offset);
        writeFileSync(diagnosticFile('aquery-jvm.log'), snapshot.subarray(0, bytes), {
          flag: 'wx',
          mode: 0o600,
        });
      } finally {
        closeSync(fd);
      }
    } finally {
      for (const [name, command, args] of [
        ['disk.txt', 'df', ['-Pk', output]],
        ['processes.txt', 'ps', ['-axo', 'pid,ppid,state,etime,%cpu,%mem,comm']],
      ] as const)
        writeFileSync(
          diagnosticFile(name),
          execFileSync(command, args, {
            timeout: 2000,
            killSignal: 'SIGKILL',
          }),
          {
            flag: 'wx',
            mode: 0o600,
          },
        );
    }
  };
  const aquery = async (args: string[]) => {
    const finish = phase('aquery');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', ['tools/dev/bazel.sh', ...startup, ...args], {
          cwd: workspace,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        let exceeded = false;
        let snapshot: Promise<void> | undefined;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        // Ordinary captures finish in seconds. A stalled serializer must not consume the build's job budget.
        const timer = setTimeout(
          () => {
            exceeded = true;
            snapshot = captureQueryDiagnostics()
              .catch((error: NodeJS.ErrnoException) =>
                console.error(
                  `native qualification: aquery diagnostics unavailable (${error.code ?? 'unknown'})`,
                ),
              )
              .finally(() => {
                escalation = setTimeout(() => {
                  child.kill('SIGKILL');
                }, 5000);
                child.kill('SIGTERM');
              });
          },
          5 * 60 * 1000,
        );
        child.once('error', (error) => {
          clearTimeout(timer);
          clearTimeout(escalation);
          reject(error);
        });
        child.once('close', async (code, signal) => {
          clearTimeout(timer);
          await snapshot;
          clearTimeout(escalation);
          if (exceeded)
            reject(new Error('shipping qualification aquery exceeded its five-minute limit'));
          else if (code !== 0)
            reject(new Error(`shipping qualification aquery failed (${signal ?? code})`));
          else resolve();
        });
      });
    } finally {
      finish();
    }
  };
  let roots: string[];
  let shippingExport: string | undefined;
  let requiredTests: NativeRequiredTest[] = [];
  let requiredLabels: string[] = [];
  const sourceOnly = request.ci?.mode === 'source' && !request.ci.handoff;
  if ('export' in request.shipping) {
    const owner = label(request.shipping.export);
    shippingExport = owner;
    bazel(
      [
        'cquery',
        owner,
        ...configuration,
        `--universe_scope=${owner}`,
        '--output=starlark',
        '--starlark:expr=json.encode({"roots": [str(value.label) for value in providers(target)["//build_defs/release:shipping.bzl%ShippingExportInfo"].packages], "qualification": [str(value.label) for value in providers(target)["//build_defs/release:shipping.bzl%ShippingExportInfo"].qualification]})',
      ],
      file('selected-owner.json'),
    );
    let selected: { roots: unknown; qualification: unknown };
    try {
      selected = json(file('selected-owner.json')) as typeof selected;
    } catch (cause) {
      // cquery can return success with empty output for an incompatible owner.
      // Ask Bazel for its dependency diagnostic without executing any actions.
      try {
        bazel(['build', owner, ...configuration, '--nobuild']);
      } catch (analysisError) {
        throw new Error(`Shipping export ${owner}: Bazel configuration analysis failed`, {
          cause: new AggregateError([cause, analysisError]),
        });
      }
      throw new Error(`Shipping export ${owner} returned no readable configured export provider`, {
        cause,
      });
    }
    if (
      !selected ||
      typeof selected !== 'object' ||
      Array.isArray(selected) ||
      Object.keys(selected).sort().join(',') !== 'qualification,roots'
    )
      throw new Error('shipping qualification requires its configured export provider');
    roots = argv(selected.roots, 'source-owned shipping roots').map(label);
    const tests = argv(selected.qualification, 'source-owned qualification').map(label);
    requiredLabels = tests;
    if (new Set(tests).size !== tests.length)
      throw new Error('shipping qualification requires unique source-owned tests');
    // These graph edges are source-owned, independently of caller targets.
    // An incompatible declared test fails analysis rather than disappearing.
    if (tests.length && !sourceOnly)
      bazel(
        [
          'cquery',
          `set(${tests.join(' ')})`,
          ...configuration,
          `--universe_scope=${owner}`,
          '--output=jsonproto',
          '--proto:include_configurations',
        ],
        file('qualification-targets.json'),
      );
    if (tests.length && !sourceOnly) {
      requiredTests = configuredQualificationTests(json(file('qualification-targets.json')));
      assert.deepStrictEqual(
        requiredTests.map((test) => test.label).sort(),
        [...tests].sort(),
        'configured source-owned test coverage',
      );
    }
  } else roots = argv(request.shipping.roots, 'shipping roots').map(label);
  if (!roots.length || new Set(roots).size !== roots.length)
    throw new Error('shipping qualification requires nonempty unique shipping roots');
  roots.sort();
  writeFileSync(file('selected-roots.json'), `${JSON.stringify(roots)}\n`, { flag: 'wx' });
  // Only loading options apply to the buildfiles query below.
  const loadingFlags = configuration.filter((flag) =>
    /^--(?:lockfile_mode|enable_bzlmod|repo_env|override_repository|repository_cache|registry)(?:=|$)/u.test(
      flag,
    ),
  );
  assertSource();
  const buildTargets = [
    ...new Set([
      ...roots,
      ...(shippingExport ? [shippingExport] : []),
      ...requiredLabels,
      ...targets,
    ]),
  ];
  const ciIdentity = request.ci && {
    id: request.ci.id,
    job: request.ci.job,
    requires: request.ci.requires,
    source,
    github: request.github,
    outputDirectory: output,
    workspaceRoot: workspace,
  };
  if (sourceOnly) {
    bazel(['test', ...buildTargets, ...configuration, ...metadata]);
    return writeConfiguredCiSuccessReceipt(ciIdentity!);
  }
  bazel([
    'test',
    ...buildTargets,
    ...configuration,
    ...metadata,
    `--build_event_json_file=${file('build-events.jsonl')}`,
    `--profile=${diagnosticFile('build-profile.json.gz')}`,
    `--execution_log_compact_file=${diagnosticFile('execution-log.binpb.zst')}`,
    '--output_groups=+shipping_manifest,+shipping_policy,+observation_inputs',
  ]);
  assertSource();
  await aquery([
    'aquery',
    nativeAqueryExpression(buildTargets),
    ...configuration,
    ...metadata,
    ...NATIVE_AQUERY_FLAGS,
    `--output_file=${file('aquery.json')}`,
    `--build_event_json_file=${file('aquery-build-events.jsonl')}`,
    `--profile=${diagnosticFile('aquery-profile.json.gz')}`,
  ]);
  assertSource();
  bazel(['info', ...configuration, 'execution_root'], file('execution-root.txt'));
  const executionRoot = readFileSync(file('execution-root.txt'), 'utf8').trim();
  if (!path.isAbsolute(executionRoot) || /[\u0000-\u001f\u007f]/u.test(executionRoot))
    throw new Error('shipping qualification requires one absolute execution root');
  assertSource();
  const buildEvents = readFileSync(file('build-events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const bep = nativeBuildEventIndex(
    { executionRoot, buildEvents },
    readFileSync(new URL('../../.bazelversion', import.meta.url), 'utf8').trim(),
    nativeBuildMetadata(source, request.github),
  );
  const rootConfigurations = roots.map((root) => {
    const matches = bep.completed.filter((target) => canonicalShippingLabel(target.label) === root);
    assert(
      matches.length === 1 && matches[0].value.success === true,
      'shipping recipe root has no unique successful configuration',
    );
    return { label: root, configuration: matches[0].configuration };
  });
  const depsFile = file('analysis-deps.json');
  const depsQuery = file('analysis-deps.query');
  writeFileSync(
    depsQuery,
    `deps(set(${(request.ci?.mode === 'full' ? buildTargets : roots).map((root) => JSON.stringify(root)).join(' ')}))`,
    {
      flag: 'wx',
    },
  );
  bazel(
    [
      'cquery',
      `--query_file=${depsQuery}`,
      ...configuration,
      ...(request.ci?.mode === 'full' ? ['--lockfile_mode=update', '--consistent_labels'] : []),
      '--output=jsonproto',
      '--transitions=lite',
      '--proto:include_configurations',
      '--proto:output_rule_attrs=',
    ],
    depsFile,
  );
  const graph = nativeConfiguredRecipeGraph(json(depsFile), rootConfigurations);
  // Query each distinct configured package set once, including external
  // packages: their BUILD files can load workspace Starlark. Representatives
  // are actual reached labels. Bazel 8 proto omits BUILD.bazel subinclude, so
  // use the real buildfiles label inventory in this frozen source context.
  const packageLabels = new Map(graph.packages.map((row) => [row.package, row.label]));
  const recipeQueries = new Map<string, { packages: string[]; labels: string[] }>();
  for (const root of graph.roots) {
    const key = JSON.stringify(root.packages);
    if (recipeQueries.has(key)) continue;
    const index = recipeQueries.size;
    const recipeFile = file(`analysis-buildfiles-${index}.txt`);
    const recipeQuery = file(`analysis-buildfiles-${index}.query`);
    writeFileSync(
      recipeQuery,
      `buildfiles(set(${root.packages.map((pkg) => JSON.stringify(packageLabels.get(pkg))).join(' ')}))`,
      { flag: 'wx' },
    );
    bazel(
      [
        'query',
        `--query_file=${recipeQuery}`,
        ...loadingFlags,
        ...(request.ci?.mode === 'full' ? ['--consistent_labels'] : []),
        '--output=label',
      ],
      recipeFile,
    );
    recipeQueries.set(key, {
      packages: root.packages,
      labels: readFileSync(recipeFile, 'utf8').split(/\r?\n/u).filter(Boolean),
    });
  }
  const rootInputs = nativeRecipeInputPaths(graph, [...recipeQueries.values()]);
  writeFileSync(file('analysis-root-inputs.json'), `${JSON.stringify(rootInputs)}\n`, {
    flag: 'wx',
  });
  assertSource();
  writeFileSync(
    file('expected-qualification.json'),
    `${JSON.stringify({
      source,
      github: request.github,
      bazelVersion: readFileSync(new URL('../../.bazelversion', import.meta.url), 'utf8').trim(),
      ...(requiredTests.length ? { requiredTests, requireShippingAnalysis: true } : {}),
    })}\n`,
    { flag: 'wx' },
  );
  // Pair sampled stacks with OS CPU time: pinned Bun can bill idle gaps to JavaScript.
  const macos = process.platform === 'darwin';
  run('capture', macos ? '/usr/bin/time' : 'bash', [
    ...(macos ? ['-p', 'bash'] : []),
    'tools/release/with-source.sh',
    'HEAD',
    'bash',
    'tools/dev/bun.sh',
    ...(macos
      ? [
          '--cpu-prof',
          '--cpu-prof-interval=10000',
          `--cpu-prof-dir=${diagnostics}`,
          '--cpu-prof-name=capture.cpuprofile',
        ]
      : []),
    'tools/release/capture-native-build-evidence.mts',
    '--github-json',
    file('github.json'),
    '--expected-qualification-json',
    file('expected-qualification.json'),
    '--producer-cohort',
    file('selected-roots.json'),
    file('aquery.json'),
    file('build-events.jsonl'),
    executionRoot,
    '--aquery-build-events',
    file('aquery-build-events.jsonl'),
    ...(shippingExport ? ['--shipping-export', shippingExport] : []),
    '--analysis-root-inputs',
    file('analysis-root-inputs.json'),
    workspace,
    '--output-directory',
    file('evidence'),
    '--source-ref',
    'HEAD',
  ]);
  const evidence = file('evidence/native-build-evidence.json');
  try {
    assertSource();
    if (completeProducts.length) {
      checkCompleteProducts(json(evidence) as NativeBuildEvidence, completeProducts);
      assertSource();
    }
  } catch (error) {
    // The collector completed, so this file belongs to this invocation. Keep
    // raw diagnostics, but remove a packet that failed final validation.
    rmSync(path.dirname(evidence), { recursive: true, force: true });
    throw error;
  }
  if (request.ci?.mode === 'full') {
    await captureConfiguredCiRequest({
      ...ciIdentity!,
      configuration,
      startup,
      requestedTargets: buildTargets,
      completedRoots: completedCiRequestRoots(bep, buildTargets),
      executionRoot,
      configuredGraph: json(depsFile),
      recipeQueries: [...recipeQueries.values()],
    });
  } else if (ciIdentity) writeConfiguredCiSuccessReceipt(ciIdentity);
  return evidence;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'github-json': { type: 'string' },
      'configuration-json': { type: 'string' },
      'startup-json': { type: 'string' },
      'shipping-export': { type: 'string' },
      'shipping-roots-json': { type: 'string' },
      'targets-json': { type: 'string' },
      'complete-products-json': { type: 'string' },
      'output-directory': { type: 'string' },
      'ci-request-id': { type: 'string' },
      'ci-job': { type: 'string' },
      'ci-mode': { type: 'string' },
      'ci-requires-json': { type: 'string' },
      'ci-handoff': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (
    !values['github-json'] ||
    !values['configuration-json'] ||
    !values['output-directory'] ||
    Boolean(values['shipping-export']) === Boolean(values['shipping-roots-json'])
  )
    throw new Error(
      'usage: qualify-native-shipping.mts --github-json FILE --configuration-json FILE [--startup-json FILE] (--shipping-export LABEL | --shipping-roots-json FILE) [--targets-json FILE] [--complete-products-json FILE] --output-directory DIR',
    );
  let shipping: NativeShippingRequest['shipping'];
  const ciMode = values['ci-mode'];
  const ciId = values['ci-request-id'];
  const ciJob = values['ci-job'];
  if (
    (ciMode || ciId || ciJob || values['ci-requires-json'] || values['ci-handoff']) &&
    (!['full', 'source'].includes(ciMode ?? '') || !ciId || !ciJob)
  )
    throw new Error('CI qualification requires mode, request ID and job');
  if (values['shipping-export']) shipping = { export: values['shipping-export'] };
  else {
    const rootsFile = values['shipping-roots-json'];
    if (!rootsFile) throw new Error('shipping roots are missing');
    shipping = { roots: argv(json(rootsFile), 'shipping roots') };
  }
  console.log(
    await qualifyNativeShipping({
      ...(ciMode && ciId && ciJob
        ? {
            ci: {
              id: ciId,
              job: ciJob,
              mode: ciMode as 'full' | 'source',
              requires: values['ci-requires-json']
                ? argv(json(values['ci-requires-json']), 'CI prerequisites')
                : [],
              handoff: values['ci-handoff'],
            },
          }
        : {}),
      github: json(values['github-json']) as NativeBuildGithub,
      startup: values['startup-json'] ? argv(json(values['startup-json']), 'startup') : [],
      configuration: argv(json(values['configuration-json']), 'configuration'),
      shipping,
      targets: values['targets-json']
        ? argv(json(values['targets-json']), 'additional targets')
        : [],
      completeProducts: values['complete-products-json']
        ? argv(json(values['complete-products-json']), 'complete products')
        : [],
      outputDirectory: values['output-directory'],
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
