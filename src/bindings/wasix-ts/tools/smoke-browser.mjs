import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  browserMarkdownReport,
  browserPlanSummary,
  defaultBrowserPlanFile,
  loadBrowserPlan,
  qualifyingGitProvenance,
  summarizeBrowserResult,
} from '../../../../tools/perf/wasix-browser/plan.mjs';
import {
  directoryTreeSha256,
  installedPackageClosure,
} from '../../../../tools/perf/wasix-node/installed-closure.mjs';
import {
  assertRuntimeBuildConfiguration,
  installedHostBuildProvenance,
} from '../../../../tools/perf/wasix-node/plan.mjs';
import { loadHostBuildContract } from '../host/build-provenance.mjs';
import { createPackedWasixConsumer, runtimeBuildProvenance } from './packed-node-fixture.mjs';

const bindingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(bindingRoot, '../../..');
const execFileAsync = promisify(execFile);
const diagnosticOpfsBenchmark = process.argv.includes('--diagnostic-opfs');
const qualifyingBenchmark = process.argv.includes('--benchmark');
if (diagnosticOpfsBenchmark && qualifyingBenchmark) {
  throw new Error('--diagnostic-opfs and --benchmark are mutually exclusive');
}
const benchmark = qualifyingBenchmark || diagnosticOpfsBenchmark;
const packageOnly = process.argv.includes('--package-only');
const quickBenchmark = benchmark && process.argv.includes('--quick');
const planFile = resolve(argumentValue('--config') ?? defaultBrowserPlanFile);
const planSource = qualifyingBenchmark ? await loadBrowserPlan(planFile) : undefined;
const git = qualifyingBenchmark ? await gitProvenance() : undefined;
const benchmarkOutput = qualifyingBenchmark
  ? resolve(argumentValue('--output') ?? defaultBenchmarkOutput(git.commit))
  : undefined;
if (
  !qualifyingBenchmark &&
  (argumentValue('--config') !== undefined || argumentValue('--output') !== undefined)
) {
  throw new Error('--config and --output require --benchmark');
}
if (
  packageOnly &&
  (benchmark || process.argv.includes('--pg-uuidv7') || process.argv.includes('--postgis-worker'))
) {
  throw new Error('--package-only cannot be combined with benchmark or extension-canary options');
}
if (benchmarkOutput !== undefined) await requireAbsent(benchmarkOutput, 'benchmark output');
const timeoutMs = Number(
  process.env.OLIPHAUNT_BROWSER_SMOKE_TIMEOUT_MS ??
    (diagnosticOpfsBenchmark && !quickBenchmark ? 1_800_000 : benchmark ? 900_000 : 300_000),
);
const pgUuidv7Canary = process.argv.includes('--pg-uuidv7');
const postgisWorkerCanary = process.argv.includes('--postgis-worker');
const requiredInputs = [
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/cluster-seeds/standard.tar.zst'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/cluster-seeds/standard.json'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/manifest.json'),
  resolve(
    repositoryRoot,
    packageOnly
      ? 'src/bindings/wasix-ts/lib/host/index.mjs'
      : 'target/oliphaunt-wasix-ts/host/wasmer-sdk/dist/index.mjs',
  ),
];
if (!benchmark) {
  requiredInputs.push(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/extensions/pgtap.tar.zst'),
  );
}
if (pgUuidv7Canary) {
  requiredInputs.push(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/extensions/pg_uuidv7.tar.zst'),
  );
}
if (postgisWorkerCanary) {
  requiredInputs.push(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/extensions/postgis.tar.zst'),
  );
}
if (benchmark) {
  requiredInputs.push(
    resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist/pglite.data'),
    resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist/pglite.wasm'),
    resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist/initdb.wasm'),
  );
}

for (const input of requiredInputs) {
  try {
    await access(input);
  } catch {
    throw new Error(`browser smoke input is missing: ${input}`);
  }
}

const chrome = await findChrome();
const vitePort = await freePort();
const chromePort = await freePort();
const profile = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-chrome-'));
const children = [];
let socket;
let packageScratch;

try {
  packageScratch = packageOnly
    ? await realpath(await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-browser-package-')))
    : undefined;
  const packedConsumer =
    packageScratch === undefined ? undefined : await stagePackedBrowserConsumer(packageScratch);
  const vite = startChild(
    'pnpm',
    [
      '--dir',
      bindingRoot,
      'exec',
      'vite',
      '--config',
      resolve(repositoryRoot, 'examples/browser-wasix/vite.config.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      String(vitePort),
      '--strictPort',
    ],
    'Vite',
    packedConsumer === undefined
      ? undefined
      : {
          env: {
            ...process.env,
            OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT: packedConsumer,
          },
        },
  );
  children.push(vite);
  await waitForHttp(`http://127.0.0.1:${vitePort}/`, vite, 30_000);

  const browser = startChild(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${chromePort}`,
      'about:blank',
    ],
    'Chrome',
  );
  children.push(browser);

  const targets = await waitForJson(`http://127.0.0.1:${chromePort}/json/list`, browser, 30_000);
  const page = targets.find((candidate) => candidate.type === 'page');
  if (page?.webSocketDebuggerUrl === undefined) {
    throw new Error('headless Chrome did not expose a page debugging target');
  }

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });

  const browserFailures = [];
  const cdp = createCdpClient(socket, (failure) => browserFailures.push(failure));
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Log.enable'),
    cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }),
  ]);

  const smokeUrl = benchmark
    ? `http://127.0.0.1:${vitePort}/benchmark.html?${new URLSearchParams({
        ...(quickBenchmark ? { quick: '1' } : {}),
        ...(diagnosticOpfsBenchmark ? { opfs: '1' } : {}),
      })}`
    : packageOnly
      ? `http://127.0.0.1:${vitePort}/?package_smoke=1`
      : `http://127.0.0.1:${vitePort}/?smoke=1${pgUuidv7Canary ? '&pg_uuidv7=1' : ''}${postgisWorkerCanary ? '&postgis_worker=1' : ''}`;
  await cdp.send('Page.navigate', { url: smokeUrl });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertRunning(vite);
    assertRunning(browser);
    if (browserFailures.length > 0) {
      throw new Error(`browser smoke observed an unhandled exception:\n${browserFailures.at(-1)}`);
    }
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression:
        "JSON.stringify({state:document.documentElement.dataset.oliphauntSmoke??'',status:document.querySelector('#status')?.textContent??'',output:document.querySelector('#output')?.textContent??''})",
      returnByValue: true,
    });
    const snapshot = JSON.parse(evaluated.result.value ?? '{}');
    if (snapshot.state === 'passed') {
      if (benchmark) {
        const result = parseBenchmarkResult(snapshot.output);
        if (diagnosticOpfsBenchmark) {
          console.log(
            `wasix-ts OPFS diagnostic benchmark: PASS\n${JSON.stringify(
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
            )}`,
          );
          break;
        }
        const finalGit = await gitProvenance();
        if (finalGit.commit !== git.commit || finalGit.tree !== git.tree) {
          throw new Error('Git commit or tree changed while the browser benchmark was running');
        }
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
        await writeBenchmarkReport(benchmarkOutput, report);
        const direct = summary.comparisons.direct;
        const worker = summary.comparisons.worker;
        console.log(
          `wasix-ts browser benchmark: ${summary.passed ? 'PASS' : 'FAIL'} ` +
            `direct=${direct.geomeanRatio.toFixed(4)} worker=${worker.geomeanRatio.toFixed(4)} ` +
            `gate<=${summary.gate.maxGeomeanRatio.toFixed(2)} ` +
            `report=${relative(repositoryRoot, benchmarkOutput)}`,
        );
        if (!summary.passed) {
          throw new Error(`browser benchmark failed qualification: ${snapshot.status}`);
        }
      } else {
        console.log(
          `wasix-ts ${packageOnly ? 'packed browser package' : 'browser'} smoke: PASS ${snapshot.output}`,
        );
      }
      break;
    }
    if (snapshot.state === 'failed') {
      throw new Error(`browser smoke failed: ${snapshot.status}\n${snapshot.output}`);
    }
    await delay(750);
  }

  const finalState = await cdp.send('Runtime.evaluate', {
    expression: "document.documentElement.dataset.oliphauntSmoke ?? ''",
    returnByValue: true,
  });
  if (finalState.result.value !== 'passed') {
    throw new Error(
      `browser smoke timed out after ${timeoutMs}ms\nVite output:\n${vite.output}\nChrome output:\n${browser.output}`,
    );
  }
} finally {
  socket?.close();
  await Promise.all(children.reverse().map(stopChild));
  await rm(profile, { recursive: true, force: true });
  if (packageScratch !== undefined) {
    await rm(packageScratch, { recursive: true, force: true });
  }
}

async function stagePackedBrowserConsumer(scratch) {
  const fixture = await createPackedWasixConsumer({
    scratch,
    consumerName: 'oliphaunt-wasix-browser-package-smoke-consumer',
    includePgtap: true,
    includeTools: true,
  });
  for (const [source, destination] of [
    ['examples/browser-wasix/index.html', 'index.html'],
    ['examples/browser-wasix/package-smoke.ts', 'main.ts'],
    ['examples/browser-wasix/direct-pg-dump-smoke.ts', 'direct-pg-dump-smoke.ts'],
    ['examples/browser-wasix/structured-api-smoke.ts', 'structured-api-smoke.ts'],
    ['src/shared/fixtures/postgres/logical-tools.json', 'logical-tools.json'],
    ['src/shared/fixtures/postgres/logical-tools-seed.sql', 'logical-tools-seed.sql'],
    ['src/shared/fixtures/postgres/logical-tools-verify.sql', 'logical-tools-verify.sql'],
  ]) {
    await cp(resolve(repositoryRoot, source), resolve(fixture.consumer, destination));
  }
  return realpath(fixture.consumer);
}

function parseBenchmarkResult(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error('browser benchmark did not return valid JSON', { cause: error });
  }
}

async function writeBenchmarkReport(outputDirectory, report) {
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory);
  await writeFile(resolve(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  await writeFile(resolve(outputDirectory, 'report.md'), browserMarkdownReport(report), {
    flag: 'wx',
  });
}

async function gitProvenance() {
  const [{ stdout: commitOutput }, { stdout: treeOutput }, { stdout: statusOutput }] =
    await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repositoryRoot,
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]);
  return qualifyingGitProvenance({
    commit: commitOutput.trim(),
    tree: treeOutput.trim(),
    status: statusOutput.trimEnd(),
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

async function toolProvenance(plan) {
  return fileProvenance([
    plan,
    resolve(repositoryRoot, 'tools/perf/wasix-browser/plan.mjs'),
    resolve(repositoryRoot, 'tools/perf/wasix-node/installed-closure.mjs'),
    resolve(repositoryRoot, 'tools/perf/wasix-node/plan.mjs'),
    resolve(bindingRoot, 'tools/smoke-browser.mjs'),
    resolve(bindingRoot, 'tools/packed-node-fixture.mjs'),
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

function argumentValue(flag) {
  const positions = process.argv
    .map((value, index) => (value === flag ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length > 1) throw new Error(`${flag} may be specified only once`);
  if (positions.length === 0) return undefined;
  const value = process.argv[positions[0] + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createCdpClient(webSocket, recordFailure) {
  let nextId = 1;
  const pending = new Map();

  webSocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request !== undefined) {
        pending.delete(message.id);
        if (message.error === undefined) request.resolve(message.result);
        else
          request.reject(
            new Error(`Chrome DevTools Protocol error: ${JSON.stringify(message.error)}`),
          );
      }
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const failure = formatCdpException(message.params.exceptionDetails);
      recordFailure(failure);
      console.error(`browser exception: ${failure}`);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const values = message.params.args.map(
        (argument) => argument.value ?? argument.description ?? argument.type,
      );
      console.error(`browser console ${message.params.type}: ${values.join(' ')}`);
    } else if (message.method === 'Log.entryAdded') {
      console.error(`browser log ${message.params.entry.level}: ${message.params.entry.text}`);
    } else if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params.sessionId;
      void send('Runtime.enable', {}, sessionId);
      void send('Log.enable', {}, sessionId);
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      webSocket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });
  }

  return { send };
}

function formatCdpException(details) {
  const description = details.exception?.description ?? details.exception?.value ?? details.text;
  const location = details.url
    ? `${details.url}:${Number(details.lineNumber ?? 0) + 1}:${Number(details.columnNumber ?? 0) + 1}`
    : undefined;
  return [description, location].filter(Boolean).join('\n');
}

function startChild(command, args, label, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? bindingRoot,
    detached: process.platform !== 'win32',
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.label = label;
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      child.output = `${child.output}${chunk}`.slice(-32_768);
    });
  }
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process exited between the state check and signal.
    }
  }
}

function assertRunning(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${child.label} exited before the browser smoke completed (${child.exitCode ?? child.signalCode})\n${child.output}`,
    );
  }
}

async function waitForHttp(url, child, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    assertRunning(child);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(200);
  }
  throw new Error(`${child.label} did not become ready\n${child.output}`);
}

async function waitForJson(url, child, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    assertRunning(child);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still starting.
    }
    await delay(200);
  }
  throw new Error(`${child.label} did not expose its debugging endpoint\n${child.output}`);
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional browser path.
    }
  }
  throw new Error('browser smoke requires Chrome/Chromium; set CHROME_BIN to its executable');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to allocate a local TCP port');
  }
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
