import { access, cp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpClient } from '../browser-cdp.mts';
import { stagePackedWasixConsumer } from './packed-node-fixture.mts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const bindingRoot = resolve(repositoryRoot, 'src/wasix/sdks/ts');
const [phase, scratch] = process.argv.slice(2);
if (!scratch || !['--prepare', '--run'].includes(phase))
  throw new Error('use bash src/wasix/sdks/ts/tools/integration/smoke-browser.sh [options]');
if (phase === '--prepare') {
  const diagnosticOpfsBenchmark = process.argv.includes('--diagnostic-opfs');
  const qualifyingBenchmark = process.argv.includes('--benchmark');
  if (diagnosticOpfsBenchmark && qualifyingBenchmark) {
    throw new Error('--diagnostic-opfs and --benchmark are mutually exclusive');
  }
  const benchmark = qualifyingBenchmark || diagnosticOpfsBenchmark;
  const packageOnly = process.argv.includes('--package-only');
  const quickBenchmark = benchmark && process.argv.includes('--quick');
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
  const timeoutMs = Number(
    process.env.OLIPHAUNT_BROWSER_SMOKE_TIMEOUT_MS ??
      (diagnosticOpfsBenchmark && !quickBenchmark ? 1_800_000 : benchmark ? 900_000 : 300_000),
  );
  const pgUuidv7Canary = process.argv.includes('--pg-uuidv7');
  const postgisWorkerCanary = process.argv.includes('--postgis-worker');
  const requiredInputs = [
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst'),
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/manifest.json'),
    ...(!packageOnly
      ? [resolve(repositoryRoot, 'target/oliphaunt-wasix-ts/host/wasmer-sdk/dist/index.mjs')]
      : []),
  ];
  if (!benchmark) {
    requiredInputs.push(
      resolve(repositoryRoot, 'target/extensions/wasix/assets/extensions/pgtap.tar.zst'),
    );
  }
  if (pgUuidv7Canary) {
    requiredInputs.push(
      resolve(repositoryRoot, 'target/extensions/wasix/assets/extensions/pg_uuidv7.tar.zst'),
    );
  }
  if (postgisWorkerCanary) {
    requiredInputs.push(
      resolve(repositoryRoot, 'target/extensions/wasix/assets/extensions/postgis.tar.zst'),
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

  const servers = [createServer(), createServer()];
  let ports;
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          }),
      ),
    );
    ports = servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing TCP address');
      return address.port;
    });
  } finally {
    for (const server of servers) server.close();
  }
  const [vitePort, chromePort] = ports;
  let packedConsumer;
  if (packageOnly) {
    packedConsumer = await stagePackedBrowserConsumer(scratch, process.argv.includes('--tools'));
  }
  const smokeUrl = benchmark
    ? `http://127.0.0.1:${vitePort}/benchmark.html?${new URLSearchParams({
        ...(quickBenchmark ? { quick: '1' } : {}),
        ...(diagnosticOpfsBenchmark ? { opfs: '1' } : {}),
      })}`
    : packageOnly
      ? `http://127.0.0.1:${vitePort}/?package_smoke=1`
      : `http://127.0.0.1:${vitePort}/?smoke=1${pgUuidv7Canary ? '&pg_uuidv7=1' : ''}${postgisWorkerCanary ? '&postgis_worker=1' : ''}`;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('browser timeout must be a positive number of milliseconds');
  await writeFile(
    resolve(scratch, 'browser.json'),
    JSON.stringify({
      vitePort,
      chromePort,
      smokeUrl,
      timeoutMs,
      packedConsumer,
      packageOnly,
      benchmark,
      mode: qualifyingBenchmark ? 'benchmark' : diagnosticOpfsBenchmark ? 'diagnostic' : 'smoke',
      config: argumentValue('--config'),
      output: argumentValue('--output'),
    }),
  );
} else {
  const { chromePort, smokeUrl, timeoutMs, benchmark, packageOnly } = JSON.parse(
    await readFile(resolve(scratch, 'browser.json'), 'utf8'),
  );
  // Cold Chrome startup shares the smoke budget instead of a separate 30-second cutoff.
  const deadline = Date.now() + timeoutMs;
  const chromePid = Number(await readFile(resolve(scratch, 'chrome.pid'), 'utf8'));
  const targets = await waitForChrome(
    `http://127.0.0.1:${chromePort}/json/list`,
    chromePid,
    deadline,
  );
  const page = targets.find((candidate) => candidate.type === 'page');
  if (!page?.webSocketDebuggerUrl)
    throw new Error('headless Chrome did not expose a page debugging target');
  let socket;
  try {
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
    });

    const browserFailures = [];
    const cdp = createCdpClient(socket, (failure) => browserFailures.push(failure), deadline);
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

    await cdp.send('Page.navigate', { url: smokeUrl });
    let snapshot: Record<string, string> = {};
    while (Date.now() < deadline) {
      if (browserFailures.length > 0) {
        throw new Error(
          `browser smoke observed an unhandled exception:\n${browserFailures.at(-1)}`,
        );
      }
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression:
          "JSON.stringify({state:document.documentElement.dataset.oliphauntSmoke??'',phase:document.documentElement.dataset.oliphauntSmokePhase??'',status:document.querySelector('#status')?.textContent??'',output:document.querySelector('#output')?.textContent??''})",
        returnByValue: true,
      });
      snapshot = JSON.parse(evaluated.result?.value ?? '{}');
      if (snapshot.state === 'passed') {
        if (benchmark) {
          await writeFile(
            resolve(scratch, 'browser-result.json'),
            JSON.stringify(JSON.parse(snapshot.output)),
          );
        } else
          console.log(
            `wasix-ts ${packageOnly ? 'packed browser package' : 'browser'} smoke: PASS ${snapshot.output}`,
          );
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
    if (finalState.result?.value !== 'passed') {
      throw new Error(`browser smoke timed out after ${timeoutMs}ms: ${JSON.stringify(snapshot)}`);
    }
  } finally {
    socket?.close();
  }
}

async function stagePackedBrowserConsumer(scratch, includeTools) {
  const fixture = await stagePackedWasixConsumer({
    scratch,
    consumerName: 'oliphaunt-wasix-browser-package-smoke-consumer',
    includePgtap: true,
    includeTools,
    includeNative: false,
    includeResources: true,
  });
  for (const [source, destination] of [
    ['src/examples/wasix/browser/index.html', 'index.html'],
    [
      includeTools
        ? 'src/wasix/postgres-tools/ts/tests/browser.ts'
        : 'src/examples/wasix/browser/package-smoke.ts',
      'main.ts',
    ],
    ...(includeTools
      ? [['src/wasix/postgres-tools/ts/tests/direct-pg-dump-smoke.ts', 'direct-pg-dump-smoke.ts']]
      : []),
    ['src/examples/wasix/browser/structured-api-smoke.ts', 'structured-api-smoke.ts'],
    ['src/test-fixtures/postgres/logical-tools.json', 'logical-tools.json'],
    ['src/test-fixtures/postgres/logical-tools-seed.sql', 'logical-tools-seed.sql'],
    ['src/test-fixtures/postgres/logical-tools-verify.sql', 'logical-tools-verify.sql'],
  ]) {
    await cp(resolve(repositoryRoot, source), resolve(fixture.consumer, destination));
  }
  return realpath(fixture.consumer);
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

async function waitForChrome(url, chromePid, deadline) {
  let lastFailure;
  while (Date.now() < deadline) {
    try {
      process.kill(chromePid, 0);
    } catch (cause) {
      throw new Error('Chrome exited before its debugging endpoint became ready', { cause });
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
      });
      if (response.ok) {
        return await response.json();
      }
      lastFailure = new Error(`Chrome debugging endpoint returned HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      lastFailure = error;
    }
    await delay(200);
  }
  throw new Error(`browser endpoint did not become ready within the smoke budget: ${url}`, {
    cause: lastFailure,
  });
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
