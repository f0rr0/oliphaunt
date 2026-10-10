import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { createCdpClient } from './browser-cdp.mts';

// Copied into the external app: Vite resolves installed package exports.
const root = process.argv[2];
assert(root, 'browser consumer requires its external app directory');
writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/probe.ts"></script>');
writeFileSync(
  path.join(root, 'probe.ts'),
  `
import Default from '@oliphaunt/wasix-ts';
import Worker from '@oliphaunt/wasix-ts/worker';
const state = document.documentElement.dataset;
state.frozenState = 'running';
(async () => {
  const answers: (string | null)[] = [];
  for (const Oliphaunt of [Default, Worker]) {
    const db = await Oliphaunt.open();
    try { answers.push((await db.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer')); }
    finally { await db.close(); }
  }
  state.frozenAnswers = JSON.stringify(answers);
  state.frozenState = 'passed';
})().catch(error => {
  state.frozenState = 'failed';
  state.frozenError = String(error);
});
`,
);
const vite = await createServer({
  root,
  configFile: false,
  optimizeDeps: { exclude: ['@oliphaunt/wasix-ts'] },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});
let chrome: ChildProcess | undefined;
let socket: WebSocket | undefined;
let chromeFailure: Error | undefined;
const log = openSync(path.join(root, 'chrome.log'), 'w');
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address !== 'string', 'Vite consumer requires a TCP address');
  const profile = path.join(root, 'chrome-profile');
  mkdirSync(profile);
  chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', log, log] },
  );
  chrome.once('error', (error) => {
    chromeFailure = error;
  });
  const activePort = path.join(profile, 'DevToolsActivePort');
  const startupDeadline = Date.now() + 60_000;
  while (!existsSync(activePort)) {
    if (chromeFailure) throw chromeFailure;
    if (chrome.exitCode !== null || Date.now() >= startupDeadline)
      throw new Error('Chrome did not expose its consumer debugging endpoint');
    await delay(200);
  }
  const debuggingPort = Number(readFileSync(activePort, 'utf8').split('\n')[0]);
  const pages: { type: string; webSocketDebuggerUrl?: string }[] = await (
    await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, {
      signal: AbortSignal.timeout(5000),
    })
  ).json();
  const page = pages.find((entry) => entry.type === 'page');
  assert(page?.webSocketDebuggerUrl, 'Chrome consumer requires a page target');
  const connection = new WebSocket(page.webSocketDebuggerUrl);
  socket = connection;
  await new Promise<void>((resolve, reject) => {
    connection.addEventListener('open', () => resolve(), { once: true });
    connection.addEventListener('error', reject, { once: true });
  });
  const deadline = Date.now() + 600_000;
  const failures: string[] = [];
  const cdp = createCdpClient(socket, (failure) => failures.push(failure), deadline);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
  // Poll outside the page so navigation cannot destroy an awaited JS promise.
  let passed = false;
  while (Date.now() < deadline) {
    if (failures.length) throw new Error(failures.at(-1));
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(document.documentElement?.dataset ?? {})',
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const state = JSON.parse(result.result?.value ?? '{}');
    if (state.frozenState === 'failed') throw new Error(state.frozenError);
    if (state.frozenState === 'passed') {
      assert.deepEqual(JSON.parse(state.frozenAnswers), ['42', '42']);
      passed = true;
      break;
    }
    await delay(200);
  }
  assert(passed, 'installed browser module timed out');
  console.log('Installed browser default and worker exports executed SELECT 42');
} finally {
  socket?.close();
  chrome?.kill('SIGKILL');
  await vite.close();
  closeSync(log);
}
