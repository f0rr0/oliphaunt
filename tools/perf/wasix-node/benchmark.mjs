import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  platform,
  release,
  tmpdir,
  totalmem,
} from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createPackedWasixConsumer } from '../../../src/bindings/wasix-ts/tools/packed-node-fixture.mjs';
import { installedPackageClosure } from './installed-closure.mjs';
import {
  assertRuntimeBuildConfiguration,
  comfortableWinGate,
  defaultPlanFile,
  findPackageManifest,
  installedHostBuildProvenance,
  loadPlan,
  median,
  metricIds,
  pairedRatioSummary,
  planSummary,
  postgresSettingsParity,
  repositoryRoot,
  sha256,
} from './plan.mjs';

const execFileAsync = promisify(execFile);
const toolRoot = dirname(fileURLToPath(import.meta.url));
const engineRunner = resolve(toolRoot, 'engine-runner.mjs');
const args = parseArguments(process.argv.slice(2));
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
          'plan, candidate host build inputs, package identity, private comparator pin, and generated SQL',
        installedControl,
        ...planSummary(source.plan, source),
      },
      null,
      2,
    ),
  );
} else {
  await runMeasuredBenchmark(source, args);
}

async function runMeasuredBenchmark(planSource, options) {
  if (isCiEnvironment()) {
    throw new Error('measured WASIX Node benchmarks are local-only and refuse CI environments');
  }
  const git = await gitProvenance();
  const output = options.output ?? defaultOutputDirectory(git.commit);
  await requireAbsent(output, 'benchmark output directory');
  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-node-bench-'));

  try {
    const fixture = await createPackedWasixConsumer({
      scratch,
      consumerName: 'oliphaunt-wasix-node-benchmark-consumer',
    });
    const candidateClosure = await candidateClosureProvenance(
      fixture.consumer,
      planSource.plan,
      fixture.packages.runtime,
    );
    const comparison = await comparisonProvenance(planSource.plan);
    const sequence = [];
    const runs = {
      candidate: [],
      'candidate-main-thread': [],
      comparison: [],
      'comparison-main-thread': [],
    };
    const pids = new Set();
    await mkdir(resolve(scratch, 'runs'));

    for (let repeat = 0; repeat < planSource.plan.measurement.pairedRepeats; repeat += 1) {
      const order = repeat % 2 === 0 ? ['candidate', 'comparison'] : ['comparison', 'candidate'];
      for (const engine of order) {
        const result = await runEngine({
          engine,
          repeat,
          planSource,
          candidateRoot: fixture.consumer,
          scratch,
        });
        validateEngineReport(result, engine, repeat, planSource);
        if (pids.has(result.process.pid) || result.process.pid === process.pid) {
          throw new Error(`engine process ${result.process.pid} was not fresh`);
        }
        pids.add(result.process.pid);
        sequence.push({ phase: 'worker', repeat, engine, pid: result.process.pid });
        runs[engine].push(result);
      }
    }

    for (let repeat = 0; repeat < planSource.plan.measurement.pairedRepeats; repeat += 1) {
      const order =
        repeat % 2 === 0
          ? ['candidate-main-thread', 'comparison-main-thread']
          : ['comparison-main-thread', 'candidate-main-thread'];
      for (const engine of order) {
        const result = await runEngine({
          engine,
          repeat,
          planSource,
          candidateRoot: fixture.consumer,
          scratch,
        });
        validateEngineReport(result, engine, repeat, planSource);
        if (pids.has(result.process.pid) || result.process.pid === process.pid) {
          throw new Error(`engine process ${result.process.pid} was not fresh`);
        }
        pids.add(result.process.pid);
        sequence.push({ phase: 'direct', repeat, engine, pid: result.process.pid });
        runs[engine].push(result);
      }
    }

    const summary = summarizeRuns(planSource.plan, runs);
    const report = {
      schema: 'oliphaunt-wasix-node-benchmark-report-v1',
      createdAt: new Date().toISOString(),
      plan: planSummary(planSource.plan, planSource),
      provenance: {
        git,
        machine: machineProvenance(),
        tools: await toolProvenance(planSource.file),
        candidate: {
          packages: stripTemporaryPaths(fixture.packages),
          closure: candidateClosure,
        },
        comparison,
      },
      execution: {
        policy: planSource.plan.measurement.processOrder,
        sequence,
      },
      runs,
      summary,
    };
    await mkdir(output);
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    await writeFile(resolve(output, 'report.md'), markdownReport(report), { flag: 'wx' });
    console.log(
      `wasix-node benchmark: ${summary.gate.passed ? 'PASS' : 'FAIL'} ` +
        `worker=${summary.placements.worker.geomeanRatio.toFixed(4)} ` +
        `direct=${summary.placements.direct.geomeanRatio.toFixed(4)} ` +
        `gate<=${summary.gate.maxGeomeanRatio.toFixed(2)} ` +
        `report=${relative(repositoryRoot, output)}`,
    );
    if (!summary.gate.passed) process.exitCode = 1;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
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

async function runEngine({ engine, repeat, planSource, candidateRoot, scratch }) {
  const output = resolve(scratch, 'runs', `${String(repeat).padStart(2, '0')}-${engine}.json`);
  const childArgs = [
    engineRunner,
    '--engine',
    engine,
    '--output',
    output,
    '--plan',
    planSource.file,
    '--repeat',
    String(repeat),
  ];
  if (engine.startsWith('candidate')) childArgs.push('--candidate-root', candidateRoot);
  try {
    await execFileAsync(process.execPath, childArgs, {
      cwd: repositoryRoot,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? `\n${error.stderr.trim()}` : '';
    throw new Error(`${engine} repeat ${repeat} failed${stderr}`, { cause: error });
  }
  return JSON.parse(await readFile(output, 'utf8'));
}

function validateEngineReport(report, engine, repeat, planSource) {
  if (
    report.schema !== 'oliphaunt-wasix-node-engine-run-v1' ||
    report.plan?.id !== planSource.plan.id ||
    report.plan?.sha256 !== planSource.sha256 ||
    report.engine?.kind !== engine ||
    report.repeat !== repeat ||
    report.correctness?.passed !== true
  ) {
    throw new Error(`${engine} repeat ${repeat} returned an invalid engine report`);
  }
  const candidate = engine.startsWith('candidate');
  const expected = candidate
    ? planSource.plan.engines.candidate
    : planSource.plan.engines.comparison;
  const direct = engine.endsWith('main-thread');
  const executionBoundary = direct ? expected.directExecutionBoundary : expected.executionBoundary;
  const isolationImplementation = direct
    ? expected.directIsolationImplementation
    : expected.isolationImplementation;
  const timingBoundary = direct ? expected.directTimingBoundary : expected.timingBoundary;
  if (
    report.engine.package !== expected.package ||
    report.engine.storage !== expected.storage ||
    report.engine.executionBoundary !== executionBoundary ||
    report.engine.isolationImplementation !== isolationImplementation ||
    report.engine.timingBoundary !== timingBoundary
  ) {
    throw new Error(`${engine} repeat ${repeat} used an unexpected engine identity`);
  }
  if (!candidate && report.engine.version !== expected.version) {
    throw new Error(`${engine} repeat ${repeat} used version ${report.engine.version}`);
  }
}

function summarizeRuns(plan, runs) {
  const correctness = summarizeCorrectness(runs, plan);
  const worker = summarizePlacement(
    plan,
    runs.candidate,
    'candidate',
    runs.comparison,
    'comparison',
    correctness.passed,
  );
  const direct = summarizePlacement(
    plan,
    runs['candidate-main-thread'],
    'candidate-main-thread',
    runs['comparison-main-thread'],
    'comparison-main-thread',
    correctness.passed,
  );
  return {
    correctness,
    placements: { worker, direct },
    gate: {
      passed: worker.gate.passed && direct.gate.passed,
      correctnessPassed: correctness.passed,
      maxGeomeanRatio: plan.gate.maxGeomeanRatio,
      placements: {
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
  const lock = await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  if (!lock.includes(plan.engines.comparison.integrity)) {
    throw new Error('pnpm-lock.yaml does not contain the comparator integrity from the plan');
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

async function candidateClosureProvenance(consumer, plan, runtimePackage) {
  const require = createRequire(resolve(consumer, 'package.json'));
  const { file: manifestFile, manifest } = await findPackageManifest(
    require.resolve(plan.engines.candidate.package),
    plan.engines.candidate.package,
  );
  const hostBuild = await installedHostBuildProvenance(
    manifestFile,
    plan.engines.candidate.hostBuild,
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
  const expectedPackages = ['@oliphaunt/liboliphaunt-wasix', '@oliphaunt/wasix-ts', 'fzstd'];
  const installedPackages = installedClosure.packages.map((candidate) => candidate.name).sort();
  if (JSON.stringify(installedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      `packed candidate installed closure is ${JSON.stringify(installedPackages)}, expected ${JSON.stringify(expectedPackages)}`,
    );
  }
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
    hostBuild,
    runtimeBuild: build,
    installedClosure,
  };
}

async function toolProvenance(planFile) {
  const files = [
    resolve(toolRoot, 'benchmark.mjs'),
    engineRunner,
    resolve(toolRoot, 'installed-closure.mjs'),
    resolve(toolRoot, 'plan.mjs'),
    resolve(toolRoot, 'pglite-node-worker.mjs'),
    resolve(repositoryRoot, 'src/bindings/wasix-ts/tools/packed-node-fixture.mjs'),
    resolve(repositoryRoot, 'tools/release/wasix-typescript-package.mjs'),
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

async function gitProvenance() {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const porcelain = status.trimEnd();
  return {
    commit: commit.trim(),
    dirty: porcelain.length > 0,
    statusSha256: sha256(porcelain),
  };
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

function markdownReport(report) {
  const placementSections = Object.entries(report.summary.placements)
    .map(([placement, summary]) => placementMarkdown(placement, summary))
    .join('\n\n');
  return `# WASIX Node benchmark report

- Plan: \`${report.plan.id}\`
- Candidate: \`${report.plan.engines.candidate.package}\` (matched worker and direct placement)
- Candidate runtime build: \`${report.provenance.candidate.packages.runtime.build.configuration.profile}\` with \`${report.provenance.candidate.packages.runtime.build.configuration.cflags}\` (signature \`${report.provenance.candidate.packages.runtime.build.buildProfile.sha256}\`)
- Candidate host build: Wasmer JS \`${report.provenance.candidate.closure.hostBuild.wasmerJsCommit}\`, wasmer-wasix \`${report.provenance.candidate.closure.hostBuild.wasmerWasixVersion}\`, Cargo \`${report.provenance.candidate.closure.hostBuild.optimization.cargoProfile}\`, Rust \`opt-level=${report.provenance.candidate.closure.hostBuild.optimization.rustOptLevel}\` with LTO, wasm-opt \`${report.provenance.candidate.closure.hostBuild.optimization.wasmOpt.join(' ')}\`, guest concurrency \`${report.provenance.candidate.closure.hostBuild.guestConcurrency}\` (inputs \`${report.provenance.candidate.closure.hostBuild.inputsSha256}\`)
- Comparison: \`${report.plan.engines.comparison.package}@${report.plan.engines.comparison.version}\` (matched worker and direct placement)
- Correctness: **${report.summary.correctness.passed ? 'PASS' : 'FAIL'}**
- PostgreSQL settings parity: **${report.summary.correctness.postgresSettings.passed ? 'PASS' : 'FAIL'}**
- Comfortable-win gate: **${report.summary.gate.passed ? 'PASS' : 'FAIL'}** (worker ${report.summary.placements.worker.geomeanRatio.toFixed(4)}, direct ${report.summary.placements.direct.geomeanRatio.toFixed(4)}, each required <= ${report.summary.gate.maxGeomeanRatio.toFixed(2)})

${placementSections}

Each placement ran in ${report.plan.measurement.pairedRepeats} same-repeat pairs against fresh in-memory databases. Launch order alternated evenly within each placement, and each paired candidate/PGlite ratio was computed before taking the per-metric median. Worker calls are timed end-to-end around one public RPC; direct calls are timed around the public API in the caller process. The cold-to-first-result metric combines public open and the immediate first user query so moving lazy work between those phases cannot change its weight.

Bulk operations use each package's public \`execProtocolRaw\` with identical PostgreSQL Simple Query bytes. Outside the timed call, the harness decodes that exact response and requires its command tags and result rows before validating database state. Both placement gates are eligible only after canonical response streams and all recorded PostgreSQL settings agree.

PGlite's official worker wrapper targets browser Worker and Web Locks APIs, so the worker control uses the small harness-owned \`worker_threads\` RPC adapter recorded in provenance. PGlite's official browser benchmark places its timer inside that browser worker; this Node harness records the methodology as reference only and does not collect or serialize comparator-only timing telemetry during calls.
`;
}

function placementMarkdown(placement, summary) {
  const title = placement === 'worker' ? 'Worker placement' : 'Direct placement';
  const rows = summary.metrics
    .map(
      (metric) =>
        `| \`${metric.id}\` | ${metric.candidateMedianMs.toFixed(3)} | ` +
        `${metric.comparisonMedianMs.toFixed(3)} | ${metric.pairedRatioMedian.toFixed(3)} |`,
    )
    .join('\n');
  const startupRows = summary.startupComponents.components
    .map(
      (component) =>
        `| \`${component.id}\` | ${component.candidateMedianMs.toFixed(3)} | ` +
        `${component.comparisonMedianMs.toFixed(3)} |`,
    )
    .join('\n');
  return `## ${title}

- Gate: **${summary.gate.passed ? 'PASS' : 'FAIL'}** (geomean ${summary.geomeanRatio.toFixed(4)})

| Metric (lower is better) | Oliphaunt median ms | PGlite median ms | Median paired ratio |
| --- | ---: | ---: | ---: |
${rows}

| Startup component (not separately gated) | Oliphaunt median ms | PGlite median ms |
| --- | ---: | ---: |
${startupRows}`;
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
