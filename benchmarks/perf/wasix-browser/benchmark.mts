import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadHostBuildContract } from '../../../runtimes/wasix-browser-host/build-provenance.mts';
import { directoryTreeSha256, installedPackageClosure } from '../wasix-node/installed-closure.mts';
import { assertRuntimeBuildConfiguration, runtimeBuildProvenance } from '../wasix-node/plan.mts';
import {
  browserPlanSummary,
  defaultBrowserPlanFile,
  loadBrowserPlan,
  qualifyingGitProvenance,
  summarizeBrowserResult,
} from './plan.mts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bindingRoot = resolve(repositoryRoot, 'sdks/ts-wasix/sdk');
const [phase, scratch] = process.argv.slice(2);
if (!scratch || !['--prepare', '--report', '--diagnostic'].includes(phase))
  throw new Error('usage: benchmark.mts --prepare|--report|--diagnostic SCRATCH');
if (phase === '--prepare') {
  const configuration = JSON.parse(await readFile(resolve(scratch, 'browser.json'), 'utf8'));
  const planSource = await loadBrowserPlan(configuration.config ?? defaultBrowserPlanFile);
  const git = await gitProvenance(scratch);
  const output = resolve(configuration.output ?? defaultBenchmarkOutput(git.commit));
  await requireAbsent(output, 'benchmark output');
  await writeFile(resolve(scratch, 'benchmark.json'), JSON.stringify({ planSource, git, output }));
} else {
  const result = JSON.parse(await readFile(resolve(scratch, 'browser-result.json'), 'utf8'));
  if (phase === '--diagnostic') {
    console.log(
      'wasix-ts OPFS diagnostic benchmark: PASS\n' +
        JSON.stringify(
          {
            configuration: result.configuration,
            postgresProfiles: result.postgresProfiles,
            worker: Object.fromEntries(
              Object.entries(result.summary.workload).map(([metric, value]) => [
                metric,
                value.worker,
              ]),
            ),
            insertDiagnostic: result.insertDiagnostic.summary,
          },
          null,
          2,
        ),
    );
  } else {
    const { planSource, git, output } = JSON.parse(
      await readFile(resolve(scratch, 'benchmark.json'), 'utf8'),
    );
    const finalGit = await gitProvenance(scratch, '-after');
    if (finalGit.commit !== git.commit || finalGit.tree !== git.tree)
      throw new Error('Git commit or tree changed while the browser benchmark was running');
    const summary = summarizeBrowserResult(planSource, result);
    const report = {
      schema: 'oliphaunt-wasix-browser-benchmark-report-v2',
      createdAt: new Date().toISOString(),
      plan: browserPlanSummary(planSource),
      provenance: {
        git,
        machine: machineProvenance(),
        candidate: await candidateProvenance(planSource.plan),
        comparison: await comparisonProvenance(planSource.plan),
        tools: await toolProvenance(planSource.file),
      },
      result,
      summary,
    };
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      `wasix-ts browser benchmark: ${summary.passed ? 'PASS' : 'FAIL'} direct=${summary.comparisons.direct.geomeanRatio.toFixed(4)} worker=${summary.comparisons.worker.geomeanRatio.toFixed(4)} gate<=${summary.gate.maxGeomeanRatio.toFixed(2)} report=${relative(repositoryRoot, output)}`,
    );
    if (!summary.passed) process.exitCode = 1;
  }
}

async function gitProvenance(scratch, suffix = '') {
  const [commit, tree, status] = await Promise.all(
    ['commit', 'tree', 'status'].map((name) =>
      readFile(resolve(scratch, 'git-' + name + suffix), 'utf8'),
    ),
  );
  return qualifyingGitProvenance({
    commit: commit.trim(),
    tree: tree.trim(),
    status: status.trimEnd(),
  });
}

async function candidateProvenance(plan) {
  const packageFile = resolve(bindingRoot, 'package.json');
  const packageBytes = await readFile(packageFile);
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  if (packageJson.name !== '@oliphaunt/wasix-ts') {
    throw new Error(`browser benchmark loaded unexpected candidate ${packageJson.name}`);
  }
  if (packageJson.dependencies?.fzstd !== plan.engines.candidate.dependencies.fzstd) {
    throw new Error(
      `browser benchmark loaded unexpected fzstd specifier ${packageJson.dependencies?.fzstd}`,
    );
  }
  const manifestBytes = await readFile(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/manifest.json'),
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const runtime = manifest.runtime;
  if (runtime === null || typeof runtime !== 'object') {
    throw new Error('canonical WASIX manifest has no runtime entry');
  }
  const clusterSeed = manifest['cluster-seeds']?.standard;
  if (clusterSeed === null || typeof clusterSeed !== 'object') {
    throw new Error('canonical WASIX manifest has no standard cluster seed entry');
  }
  const archiveBytes = await readFile(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets', runtime.archive),
  );
  const archiveSha256 = sha256(archiveBytes);
  if (archiveSha256 !== runtime.sha256) {
    throw new Error('canonical WASIX runtime archive does not match its manifest');
  }
  const clusterSeedBytes = await readFile(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets', clusterSeed.archive),
  );
  const clusterSeedSha256 = sha256(clusterSeedBytes);
  if (clusterSeedSha256 !== clusterSeed.sha256) {
    throw new Error('canonical WASIX standard cluster seed does not match its manifest');
  }
  const hostBuild = await installedHostBuildProvenance(
    packageFile,
    (await loadHostBuildContract()).provenance,
  );
  const runtimeBuild = await runtimeBuildProvenance(manifest);
  assertRuntimeBuildConfiguration(
    runtimeBuild.configuration,
    plan.engines.candidate.runtimeBuild,
    'browser candidate runtime build',
  );
  const require = createRequire(packageFile);
  const fzstdClosure = await installedPackageClosure(require.resolve('fzstd'), 'fzstd');
  const libDirectory = resolve(bindingRoot, 'lib');
  return {
    package: packageJson.name,
    version: packageJson.version,
    packageJsonSha256: sha256(packageBytes),
    build: {
      treeHashSchema: 'oliphaunt-path-size-content-sha256-v1',
      libTreeSha256: await directoryTreeSha256(libDirectory),
      hostBuild,
      hostArtifacts: await fileProvenance([
        resolve(libDirectory, 'host/index.mjs'),
        resolve(libDirectory, 'host/worker.mjs'),
        resolve(libDirectory, 'host/wasmer_js_bg.wasm'),
        resolve(libDirectory, 'host/provenance.json'),
      ]),
      runtimeBuild,
    },
    dependencies: { fzstd: fzstdClosure },
    runtime: {
      manifestSha256: sha256(manifestBytes),
      archive: runtime.archive,
      archiveSha256,
      archiveSize: archiveBytes.length,
      moduleSha256: runtime['module-sha256'],
      postgresVersion: runtime['postgres-version'],
      sourceFingerprint: manifest['source-fingerprint'],
      sourceLane: manifest['source-lane'],
    },
    clusterSeed: {
      profile: 'standard',
      archive: clusterSeed.archive,
      archiveSha256: clusterSeedSha256,
      archiveSize: clusterSeedBytes.length,
    },
  };
}

async function installedHostBuildProvenance(packageManifestFile, expected) {
  const file = resolve(dirname(packageManifestFile), 'lib/host/provenance.json');
  let provenance;
  try {
    provenance = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error('installed @oliphaunt/wasix-ts host provenance is unreadable', {
      cause: error,
    });
  }
  if (!isDeepStrictEqual(provenance, expected)) {
    throw new Error(
      'installed @oliphaunt/wasix-ts host provenance does not match the source build contract',
    );
  }
  return provenance;
}

async function toolProvenance(plan) {
  return fileProvenance([
    plan,
    resolve(repositoryRoot, 'benchmarks/perf/wasix-browser/plan.mts'),
    resolve(repositoryRoot, 'benchmarks/perf/wasix-node/installed-closure.mts'),
    resolve(repositoryRoot, 'benchmarks/perf/wasix-node/plan.mts'),
    resolve(repositoryRoot, 'sdks/ts-wasix/sdk/tools/integration/smoke-browser.mts'),
    resolve(repositoryRoot, 'sdks/ts-wasix/sdk/tools/integration/smoke-browser.sh'),
    resolve(repositoryRoot, 'benchmarks/perf/wasix-browser/benchmark.mts'),
    resolve(repositoryRoot, 'sdks/ts-wasix/sdk/tools/integration/packed-node-fixture.mts'),
    resolve(repositoryRoot, 'examples/browser-wasix/benchmark.html'),
    resolve(repositoryRoot, 'examples/browser-wasix/benchmark.ts'),
    resolve(repositoryRoot, 'examples/browser-wasix/pglite-worker.ts'),
    resolve(repositoryRoot, 'examples/browser-wasix/vite.config.ts'),
  ]);
}

async function fileProvenance(files) {
  const records = [];
  for (const file of [...new Set(files.map((entry) => resolve(entry)))].sort()) {
    const bytes = await readFile(file);
    records.push({
      path: relative(repositoryRoot, file).split('\\').join('/'),
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return records;
}

async function comparisonProvenance(plan) {
  const entry = resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist/index.js');
  const installedClosure = await installedPackageClosure(entry, plan.engines.comparison.package);
  const root = installedClosure.packages.find(
    (candidate) => candidate.id === installedClosure.root,
  );
  if (root === undefined) throw new Error('installed PGlite closure lost its root package');
  if (
    root.version !== plan.engines.comparison.version ||
    root.installedTreeSha256 !== plan.engines.comparison.installedTreeSha256
  ) {
    throw new Error(
      `installed PGlite is ${root.version}#${root.installedTreeSha256}, expected ` +
        `${plan.engines.comparison.version}#${plan.engines.comparison.installedTreeSha256}`,
    );
  }
  return { ...plan.engines.comparison, installedClosure };
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
  };
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

function defaultBenchmarkOutput(commit) {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '')
    .replaceAll('-', '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return resolve(
    repositoryRoot,
    'target/perf',
    `wasix-browser-${timestamp}-${commit.slice(0, 12)}`,
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
