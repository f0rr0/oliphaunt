import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bindingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(bindingRoot, '../../..');
const timeoutMs = Number(process.env.OLIPHAUNT_BROWSER_SMOKE_TIMEOUT_MS ?? 300_000);
const pgUuidv7Canary = process.argv.includes('--pg-uuidv7');
const requiredInputs = [
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/prepopulated/pgdata-template.tar.zst'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/manifest.json'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/extensions/pgtap.tar.zst'),
  resolve(repositoryRoot, 'target/oliphaunt-wasix-ts/host/wasmer-sdk/dist/index.mjs'),
];
if (pgUuidv7Canary) {
  requiredInputs.push(
    resolve(repositoryRoot, 'target/oliphaunt-wasix/assets/extensions/pg_uuidv7.tar.zst'),
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
const profile = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-chrome-'));
const vitePort = await freePort();
const chromePort = await freePort();
const children = [];
let socket;

try {
  const vite = startChild(
    'pnpm',
    [
      'exec',
      'vite',
      '--config',
      'examples/browser/vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(vitePort),
      '--strictPort',
    ],
    'Vite',
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

  const cdp = createCdpClient(socket);
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

  const smokeUrl = `http://127.0.0.1:${vitePort}/?smoke=1${pgUuidv7Canary ? '&pg_uuidv7=1' : ''}`;
  await cdp.send('Page.navigate', { url: smokeUrl });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertRunning(vite);
    assertRunning(browser);
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression:
        "JSON.stringify({state:document.documentElement.dataset.oliphauntSmoke??'',status:document.querySelector('#status')?.textContent??'',output:document.querySelector('#output')?.textContent??''})",
      returnByValue: true,
    });
    const snapshot = JSON.parse(evaluated.result.value ?? '{}');
    if (snapshot.state === 'passed') {
      console.log(`wasix-ts browser smoke: PASS ${snapshot.output}`);
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
  await Promise.all(children.reverse().map(stopChild));
  await rm(profile, { recursive: true, force: true });
}

function createCdpClient(webSocket) {
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
      console.error(`browser exception: ${message.params.exceptionDetails.text}`);
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

function startChild(command, args, label) {
  const child = spawn(command, args, {
    cwd: bindingRoot,
    detached: process.platform !== 'win32',
    env: process.env,
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
