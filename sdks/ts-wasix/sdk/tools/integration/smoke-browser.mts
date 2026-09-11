import { access, cp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackedWasixConsumer } from './packed-node-fixture.mts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const bindingRoot = resolve(repositoryRoot, 'sdks/ts-wasix/sdk');
const [phase, scratch] = process.argv.slice(2);
if (!scratch || !['--prepare', '--run'].includes(phase))
  throw new Error('use bash sdks/ts-wasix/sdk/tools/integration/smoke-browser.sh [options]');
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
  const targets = await waitForChrome(`http://127.0.0.1:${chromePort}/json/list`);
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
    const deadline = Date.now() + timeoutMs;
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
    while (Date.now() < deadline) {
      if (browserFailures.length > 0) {
        throw new Error(
          `browser smoke observed an unhandled exception:\n${browserFailures.at(-1)}`,
        );
      }
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression:
          "JSON.stringify({state:document.documentElement.dataset.oliphauntSmoke??'',status:document.querySelector('#status')?.textContent??'',output:document.querySelector('#output')?.textContent??''})",
        returnByValue: true,
      });
      const snapshot = JSON.parse(evaluated.result.value ?? '{}');
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
    if (finalState.result.value !== 'passed') {
      throw new Error(`browser smoke timed out after ${timeoutMs}ms`);
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
    ['examples/browser-wasix/index.html', 'index.html'],
    [
      includeTools
        ? 'postgres-tools/wasix/ts/tests/browser.ts'
        : 'examples/browser-wasix/package-smoke.ts',
      'main.ts',
    ],
    ...(includeTools
      ? [['postgres-tools/wasix/ts/tests/direct-pg-dump-smoke.ts', 'direct-pg-dump-smoke.ts']]
      : []),
    ['examples/browser-wasix/structured-api-smoke.ts', 'structured-api-smoke.ts'],
    ['test-fixtures/postgres/logical-tools.json', 'logical-tools.json'],
    ['test-fixtures/postgres/logical-tools-seed.sql', 'logical-tools-seed.sql'],
    ['test-fixtures/postgres/logical-tools-verify.sql', 'logical-tools-verify.sql'],
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

function createCdpClient(webSocket, recordFailure, deadline) {
  let nextId = 1;
  const pending = new Map();

  const rejectPending = (reason) => {
    const error = new Error(`Chrome DevTools Protocol connection ${reason}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  webSocket.addEventListener('close', () => rejectPending('closed'));
  webSocket.addEventListener('error', () => rejectPending('failed'));

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
      void send('Runtime.enable', {}, sessionId).catch((error) => recordFailure(error.message));
      void send('Log.enable', {}, sessionId).catch((error) => recordFailure(error.message));
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          rejectRequest(new Error(`Chrome DevTools Protocol ${method} timed out`));
        },
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      );
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
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

async function waitForChrome(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return await response.json();
      }
      await response.body?.cancel();
    } catch {}
    await delay(200);
  }
  throw new Error(`browser endpoint did not become ready: ${url}`);
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
