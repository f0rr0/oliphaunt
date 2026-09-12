import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, freemem, homedir, hostname, platform, release, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackedWasixConsumer } from '../../../sdks/ts-wasix/sdk/tools/integration/packed-node-fixture.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { installedPackageClosure } from './installed-closure.mts';
import {
  assertNativeArtifactProvenance,
  assertRuntimeBuildConfiguration,
  comfortableWinGate,
  defaultPlanFile,
  findPackageManifest,
  loadPlan,
  median,
  metricIds,
  pairedRatioSummary,
  planSummary,
  postgresSettingsParity,
  repositoryRoot,
  runtimeBuildProvenance,
  sha256,
} from './plan.mts';

const toolRoot = dirname(fileURLToPath(import.meta.url));
const engineRunner = resolve(toolRoot, 'engine-runner.mts');
const phase = ['--prepare', '--inspect', '--report'].includes(process.argv[2])
  ? process.argv[2]
  : undefined;
const scratch = phase ? resolve(process.argv[3]) : undefined;
const args = parseArguments(process.argv.slice(phase ? 4 : 2));
const source = await loadPlan(args.config);

if (args.mode === 'plan') {
  console.log(JSON.stringify(planSummary(source.plan, source), null, 2));
} else if (args.mode === 'validate') {
  const installedControl = await comparisonProvenance(source.plan);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        validation:
          'plan, native addon contract, package identity, private comparator pin, and generated SQL',
        installedControl,
        ...planSummary(source.plan, source),
      },
      null,
      2,
    ),
  );
} else {
  if (isCiEnvironment())
    throw new Error('measured WASIX Node benchmarks are local-only and refuse CI environments');
  if (phase === '--prepare') await prepareBenchmark(source, args, scratch);
  else if (phase === '--inspect') await inspectBenchmark(scratch);
  else if (phase === '--report') await reportBenchmark(scratch);
  else throw new Error('run measurements with bash benchmarks/perf/wasix-node/benchmark.sh --run');
}

async function prepareBenchmark(planSource, options, scratch) {
  const commit = (await readFile(resolve(scratch, 'git-commit'), 'utf8')).trim();
  const porcelain = (await readFile(resolve(scratch, 'git-status'), 'utf8')).trimEnd();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('invalid Git source commit');
  const git = { commit, dirty: porcelain.length > 0, statusSha256: sha256(porcelain) };
  const output = options.output ?? defaultOutputDirectory(git.commit);
  await requireAbsent(output, 'benchmark output directory');
  const fixture = await createBenchmarkFixture({
    scratch,
    consumerName: 'oliphaunt-wasix-node-benchmark-consumer',
  });
  const runtimeManifest = readPortableArchiveEntries(fixture.packages.runtime.file).get(
    'package/assets/manifest.json',
  );
  if (!runtimeManifest?.isFile) throw new Error('packed runtime is missing its manifest');
  fixture.packages.runtime.build = await runtimeBuildProvenance(
    JSON.parse(Buffer.from(runtimeManifest.data()).toString('utf8')),
  );
  const sequence = [];
  for (const phase of ['worker', 'direct']) {
    for (let repeat = 0; repeat < planSource.plan.measurement.pairedRepeats; repeat += 1) {
      const order = repeat % 2 === 0 ? ['candidate', 'comparison'] : ['comparison', 'candidate'];
      for (const engine of order) sequence.push({ phase, repeat, engine: `${engine}-${phase}` });
    }
  }
  await mkdir(resolve(scratch, 'runs'));
  await writeFile(
    resolve(scratch, 'measurement.json'),
    JSON.stringify({ planSource, git, fixture, output, sequence }),
  );
}

async function inspectBenchmark(scratch) {
  const file = resolve(scratch, 'measurement.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const { planSource, git, fixture } = state;
  state.provenance = {
    git,
    machine: machineProvenance(),
    tools: await toolProvenance(planSource.file),
    candidate: {
      packages: stripTemporaryPaths(fixture.packages),
      closure: await candidateClosureProvenance(
        fixture.consumer,
        planSource.plan,
        fixture.packages.runtime,
        fixture.packages.nativeCarrier,
        git.commit,
      ),
    },
    comparison: await comparisonProvenance(planSource.plan),
  };
  await writeFile(file, JSON.stringify(state));
}

async function reportBenchmark(scratch) {
  const { planSource, provenance, output, sequence } = JSON.parse(
    await readFile(resolve(scratch, 'measurement.json'), 'utf8'),
  );
  if (!provenance) throw new Error('benchmark inputs must be inspected before measurement');
  const runs = {
    'candidate-direct': [],
    'candidate-worker': [],
    'comparison-direct': [],
    'comparison-worker': [],
  };
  const pids = new Set();
  for (const row of sequence) {
    const result = JSON.parse(
      await readFile(resolve(scratch, 'runs', `${row.repeat}-${row.engine}.json`), 'utf8'),
    );
    validateEngineReport(result, row.engine, row.repeat, planSource);
    if (pids.has(result.process.pid))
      throw new Error(`engine process ${result.process.pid} was not fresh`);
    pids.add(result.process.pid);
    row.pid = result.process.pid;
    runs[row.engine].push(result);
  }
  const summary = summarizeRuns(planSource.plan, runs);
  const report = {
    schema: 'oliphaunt-wasix-node-benchmark-report-v2',
    createdAt: new Date().toISOString(),
    plan: planSummary(planSource.plan, planSource),
    provenance,
    execution: { policy: planSource.plan.measurement.processOrder, sequence },
    runs,
    summary,
  };
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(
    `wasix-node benchmark: ${summary.gate.passed ? 'PASS' : 'FAIL'} worker=${summary.comparisons.worker.geomeanRatio.toFixed(4)} direct=${summary.comparisons.direct.geomeanRatio.toFixed(4)} gate<=${summary.gate.maxGeomeanRatio.toFixed(2)} report=${relative(repositoryRoot, output)}`,
  );
  if (!summary.gate.passed) process.exitCode = 1;
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

async function createBenchmarkFixture(options) {
  try {
    return await stagePackedWasixConsumer({ ...options, includeSeed: true });
  } catch (cause) {
    throwNativeCarrierPreflight(cause, 'measured WASIX Node benchmark');
    throw cause;
  }
}

function throwNativeCarrierPreflight(cause, consumer) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (
    /native carrier|Node-API carrier|native artifact provenance|oliphaunt_wasix_napi|wasix-napi-/iu.test(
      detail,
    )
  ) {
    throw new Error(
      `${consumer} requires one optimized current-host WASIX Node-API carrier. ` +
        'After staging the portable/AOT runtime, ICU, and extension inputs, run ' +
        '`bash sdks/ts-wasix/node-addon/tools/build-native.sh`, then retry. ' +
        `Carrier preflight: ${detail}`,
      { cause },
    );
  }
}

function validateEngineReport(report, engine, repeat, planSource) {
  if (
    report.schema !== 'oliphaunt-wasix-node-engine-run-v2' ||
    report.plan?.id !== planSource.plan.id ||
    report.plan?.sha256 !== planSource.sha256 ||
    report.engine?.kind !== engine ||
    report.repeat !== repeat ||
    report.correctness?.passed !== true
  ) {
    throw new Error(`${engine} repeat ${repeat} returned an invalid engine report`);
  }
  const candidate = engine.startsWith('candidate');
  const expectedEngine = candidate
    ? planSource.plan.engines.candidate
    : planSource.plan.engines.comparison;
  const surface =
    engine === 'candidate-direct'
      ? expectedEngine.surfaces.direct
      : engine === 'candidate-worker'
        ? expectedEngine.surfaces.worker
        : engine === 'comparison-worker'
          ? expectedEngine.surfaces.worker
          : expectedEngine.surfaces.callerRealm;
  if (
    report.engine.package !== expectedEngine.package ||
    report.engine.storage !== expectedEngine.storage ||
    report.engine.entrypoint !== surface.entrypoint ||
    report.engine.callingContract !== surface.callingContract ||
    report.engine.executionOwner !== surface.executionOwner ||
    report.engine.executionBoundary !== surface.executionBoundary ||
    report.engine.isolationImplementation !== surface.isolationImplementation ||
    report.engine.timingBoundary !== surface.timingBoundary
  ) {
    throw new Error(`${engine} repeat ${repeat} used an unexpected engine identity`);
  }
  if (!candidate && report.engine.version !== expectedEngine.version) {
    throw new Error(`${engine} repeat ${repeat} used version ${report.engine.version}`);
  }
}

function summarizeRuns(plan, runs) {
  const correctness = summarizeCorrectness(runs, plan);
  const worker = summarizePlacement(
    plan,
    runs['candidate-worker'],
    'candidate-worker',
    runs['comparison-worker'],
    'comparison-worker',
    correctness.passed,
  );
  const direct = summarizePlacement(
    plan,
    runs['candidate-direct'],
    'candidate-direct',
    runs['comparison-direct'],
    'comparison-direct',
    correctness.passed,
  );
  return {
    correctness,
    comparisons: { direct, worker },
    gate: {
      passed: worker.gate.passed && direct.gate.passed,
      correctnessPassed: correctness.passed,
      maxGeomeanRatio: plan.gate.maxGeomeanRatio,
      comparisons: {
        worker: worker.gate.passed,
        direct: direct.gate.passed,
      },
    },
  };
}

function summarizePlacement(
  plan,
  candidateInput,
  candidateEngine,
  comparisonInput,
  comparisonEngine,
  correctnessPassed,
) {
  const candidateRuns = orderedRuns(
    candidateInput,
    candidateEngine,
    plan.measurement.pairedRepeats,
  );
  const comparisonRuns = orderedRuns(
    comparisonInput,
    comparisonEngine,
    plan.measurement.pairedRepeats,
  );
  const metrics = metricIds(plan).map((id) => {
    const candidateSamples = candidateRuns.map((run) => metricValue(run, id));
    const comparisonSamples = comparisonRuns.map((run) => metricValue(run, id));
    const candidateMedianMs = median(candidateSamples);
    const comparisonMedianMs = median(comparisonSamples);
    const paired = pairedRatioSummary(candidateSamples, comparisonSamples);
    return {
      id,
      candidateSamplesMs: candidateSamples,
      comparisonSamplesMs: comparisonSamples,
      candidateMedianMs,
      comparisonMedianMs,
      pairs: paired.pairedRatios.map((ratio, repeat) => ({
        repeat,
        candidateMs: candidateSamples[repeat],
        comparisonMs: comparisonSamples[repeat],
        ratio,
      })),
      pairedRatioMedian: paired.medianRatio,
    };
  });
  const { geomeanRatio, gate } = comfortableWinGate(
    metrics.map((metric) => metric.pairedRatioMedian),
    plan.gate.maxGeomeanRatio,
    correctnessPassed,
  );
  return {
    metrics,
    startupComponents: summarizeStartupComponents(candidateRuns, comparisonRuns),
    geomeanRatio,
    gate,
  };
}

function orderedRuns(runs, engine, expectedCount) {
  if (!Array.isArray(runs) || runs.length !== expectedCount) {
    throw new Error(`${engine} must provide exactly ${expectedCount} paired repeats`);
  }
  const byRepeat = new Map();
  for (const run of runs) {
    if (
      !Number.isSafeInteger(run.repeat) ||
      run.repeat < 0 ||
      run.repeat >= expectedCount ||
      byRepeat.has(run.repeat)
    ) {
      throw new Error(`${engine} returned duplicate or invalid paired repeat ${run.repeat}`);
    }
    byRepeat.set(run.repeat, run);
  }
  return Array.from({ length: expectedCount }, (_, repeat) => {
    const run = byRepeat.get(repeat);
    if (run === undefined) throw new Error(`${engine} omitted paired repeat ${repeat}`);
    return run;
  });
}

function summarizeStartupComponents(candidateRuns, comparisonRuns) {
  return {
    separatelyGated: false,
    components: startupComponentIds().map((id) => {
      const candidateSamplesMs = candidateRuns.map((run) => startupComponentValue(run, id));
      const comparisonSamplesMs = comparisonRuns.map((run) => startupComponentValue(run, id));
      return {
        id,
        candidateSamplesMs,
        comparisonSamplesMs,
        candidateMedianMs: median(candidateSamplesMs),
        comparisonMedianMs: median(comparisonSamplesMs),
      };
    }),
  };
}

function summarizeCorrectness(runs, plan) {
  const all = Object.values(runs).flat();
  const expected = new Set(all.map((run) => run.correctness.expectedSha256));
  const responses = new Set(all.map((run) => run.correctness.responseSha256));
  const postgresSettings = postgresSettingsParity(
    all,
    plan.postgres.settings,
    plan.postgres.expectedSettings,
  );
  return {
    passed:
      all.length > 0 &&
      all.every((run) => run.correctness.passed) &&
      expected.size === 1 &&
      responses.size === 1 &&
      [...expected][0] === [...responses][0] &&
      postgresSettings.passed,
    expectedSha256: expected.size === 1 ? [...expected][0] : null,
    responseSha256: responses.size === 1 ? [...responses][0] : null,
    postgresSettings,
  };
}

function metricValue(run, id) {
  if (id === 'cold-to-first-result') {
    const openMs = startupComponentValue(run, 'public-open');
    const firstQueryMs = startupComponentValue(run, 'immediate-first-query');
    const composite = positiveTiming(run.timings.coldToFirstResultMs, id);
    if (Math.abs(composite - (openMs + firstQueryMs)) > Number.EPSILON * composite * 4) {
      throw new Error(`${id} must equal its reported startup components`);
    }
    return composite;
  }
  if (id.startsWith('warm-rtt/') && id.endsWith('/p50')) {
    const benchmarkId = id.slice('warm-rtt/'.length, -'/p50'.length);
    const row = run.timings.warmRtt.find((entry) => entry.id === benchmarkId);
    return positiveTiming(row?.latency?.p50Ms, id);
  }
  if (id.startsWith('bulk/') && id.endsWith('/elapsed')) {
    const benchmarkId = id.slice('bulk/'.length, -'/elapsed'.length);
    const row = run.timings.bulk.find((entry) => entry.id === benchmarkId);
    return positiveTiming(row?.elapsedMs, id);
  }
  throw new Error(`unsupported metric ${id}`);
}

function startupComponentIds() {
  return ['public-open', 'immediate-first-query'];
}

function startupComponentValue(run, id) {
  if (id === 'public-open') return positiveTiming(run.timings.openMs, id);
  if (id === 'immediate-first-query') {
    return positiveTiming(run.timings.firstQueryMs, id);
  }
  throw new Error(`unsupported startup component ${id}`);
}

function positiveTiming(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite timing`);
  }
  return value;
}

async function comparisonProvenance(plan) {
  const require = createRequire(import.meta.url);
  const { manifest } = await findPackageManifest(
    require.resolve(plan.engines.comparison.package),
    plan.engines.comparison.package,
  );
  if (manifest.version !== plan.engines.comparison.version) {
    throw new Error(
      `installed ${manifest.name}@${manifest.version}, expected ${plan.engines.comparison.version}`,
    );
  }
  const lock = await readFile(resolve(repositoryRoot, 'bun.lock'), 'utf8');
  if (!lock.includes(plan.engines.comparison.integrity)) {
    throw new Error('bun.lock does not contain the comparator integrity from the plan');
  }
  const closure = await installedPackageClosure(
    require.resolve(plan.engines.comparison.package),
    plan.engines.comparison.package,
  );
  const root = closure.packages.find((candidate) => candidate.id === closure.root);
  if (
    closure.treeHashSchema !== plan.engines.comparison.installedTreeHashSchema ||
    root?.installedTreeSha256 !== plan.engines.comparison.installedTreeSha256
  ) {
    throw new Error(
      `installed ${manifest.name}@${manifest.version} tree is ${root?.installedTreeSha256 ?? 'missing'}, ` +
        `expected ${plan.engines.comparison.installedTreeSha256}`,
    );
  }
  return {
    package: manifest.name,
    version: manifest.version,
    homepage: plan.engines.comparison.homepage,
    integrity: plan.engines.comparison.integrity,
    sourceRepository: plan.engines.comparison.sourceRepository,
    sourceCommit: plan.engines.comparison.sourceCommit,
    installedClosure: closure,
  };
}

async function candidateClosureProvenance(
  consumer,
  plan,
  runtimePackage,
  nativeCarrier,
  artifactSourceSha,
) {
  const require = createRequire(resolve(consumer, 'package.json'));
  const { manifest } = await findPackageManifest(
    require.resolve(plan.engines.candidate.package),
    plan.engines.candidate.package,
  );
  const nativeAddon = assertNativeArtifactProvenance(
    nativeCarrier,
    plan.engines.candidate.nativeAddon,
    artifactSourceSha,
  );
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    if (manifest[field]?.[plan.engines.comparison.package] !== undefined) {
      throw new Error(`packed candidate ${field} includes benchmark-only PGlite`);
    }
  }
  const installedClosure = await installedPackageClosure(
    require.resolve(plan.engines.candidate.package),
    plan.engines.candidate.package,
  );
  const seedClosure = await installedPackageClosure(
    require.resolve('@oliphaunt/seed-wasix-standard/manifest.json'),
    '@oliphaunt/seed-wasix-standard',
  );
  if (manifest.dependencies?.fzstd !== '0.1.1') {
    throw new Error(`packed candidate fzstd dependency is ${manifest.dependencies?.fzstd}`);
  }
  const build = runtimePackage?.build;
  if (
    build?.schema !== 'oliphaunt-wasix-build-provenance-v1' ||
    build.configuration === undefined ||
    typeof build.buildProfile?.sha256 !== 'string' ||
    typeof build.outputs?.sha256 !== 'string'
  ) {
    throw new Error('packed candidate runtime build provenance is incomplete');
  }
  try {
    assertRuntimeBuildConfiguration(
      build.configuration,
      plan.engines.candidate.runtimeBuild,
      'packed candidate runtime build',
    );
  } catch (error) {
    throw new Error(
      `packed candidate runtime build is ${JSON.stringify(build.configuration)}, ` +
        `expected ${JSON.stringify(plan.engines.candidate.runtimeBuild)}`,
      { cause: error },
    );
  }
  return {
    package: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    nativeAddon,
    runtimeBuild: build,
    installedClosure,
    seedClosure,
  };
}

async function toolProvenance(planFile) {
  const files = [
    resolve(toolRoot, 'benchmark.mts'),
    resolve(toolRoot, 'benchmark.sh'),
    engineRunner,
    resolve(toolRoot, 'installed-closure.mts'),
    resolve(toolRoot, 'plan.mts'),
    resolve(toolRoot, 'pglite-node-worker.mts'),
    resolve(repositoryRoot, 'sdks/ts-wasix/sdk/tools/integration/packed-node-fixture.mts'),
    resolve(repositoryRoot, 'sdks/ts-wasix/sdk/tools/wasix-typescript-package.mts'),
    planFile,
  ];
  const records = [];
  for (const file of files) {
    const bytes = await readFile(file);
    records.push({
      path: relative(repositoryRoot, file).split('\\').join('/'),
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return records;
}

function machineProvenance() {
  const processors = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    v8: process.versions.v8,
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpus: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
  };
}

function stripTemporaryPaths(packages) {
  return Object.fromEntries(
    Object.entries(packages).map(([kind, descriptor]) => {
      const { file: _, ...portable } = descriptor;
      return [kind, portable];
    }),
  );
}

function defaultOutputDirectory(commit) {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '')
    .replaceAll('-', '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return resolve(repositoryRoot, 'target/perf', `wasix-node-${timestamp}-${commit.slice(0, 12)}`);
}

function isCiEnvironment() {
  return ['BUILDKITE', 'CI', 'CIRCLECI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'TF_BUILD'].some(
    (name) => {
      const value = process.env[name];
      return value !== undefined && !['', '0', 'false'].includes(value.toLowerCase());
    },
  );
}

function parseArguments(argv) {
  let mode;
  let config = defaultPlanFile;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--plan', '--run', '--validate'].includes(flag)) {
      if (mode !== undefined) throw new Error('choose exactly one of --plan, --validate, or --run');
      mode = flag.slice(2);
    } else if (flag === '--config' || flag === '--output') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === '--config') config = resolve(value);
      else output = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown benchmark option ${JSON.stringify(flag)}`);
    }
  }
  mode ??= 'plan';
  if (mode !== 'run' && output !== undefined) throw new Error('--output is only valid with --run');
  if (output === homedir() || output === repositoryRoot) {
    throw new Error('--output must not be a home or repository root');
  }
  return { mode, config, output };
}
