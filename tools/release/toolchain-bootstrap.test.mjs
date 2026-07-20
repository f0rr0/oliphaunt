import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';

const LOCAL_SCRIPT_TIMEOUT_MS = 55_000;
const COLD_REGISTRY_SCRIPT_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 5_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const INSTALLER_FAULT_SUITES = [
  {script: 'tools/dev/extract-pinned-zip.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: 'tools/dev/install-pinned-js-runtime.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: 'tools/dev/install-pinned-winflexbison.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: 'tools/dev/setup-android-sdk.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: '.github/actions/setup-moon/install-pinned-node.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: '.github/actions/setup-moon/install-pinned-toolchain.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: '.github/actions/setup-node-pnpm/install-pinned-pnpm.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  {script: '.github/actions/setup-npm-publisher/install.test.sh', timeoutMs: LOCAL_SCRIPT_TIMEOUT_MS},
  // Unlike the local archive fault fixtures above, this exercises a genuinely
  // empty pnpm store and downloads the complete pinned Verdaccio graph. Keep a
  // separate finite budget so a slow registry cannot masquerade as an installer
  // defect without weakening the fast-suite hang detector.
  {script: 'tools/release/install-verdaccio-runtime.test.sh', timeoutMs: COLD_REGISTRY_SCRIPT_TIMEOUT_MS},
];

function appendBounded(chunks, state, chunk, label) {
  state.bytes += chunk.length;
  if (state.bytes > MAX_CAPTURE_BYTES) {
    throw new Error(`${label} exceeded the ${MAX_CAPTURE_BYTES}-byte diagnostic bound`);
  }
  chunks.push(chunk);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function forceWindowsProcessTree(pid, {
  spawnImpl = spawn,
  timeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
      const killer = spawnImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const stderr = [];
      let stderrBytes = 0;
      let settled = false;
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      killer.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 64 * 1024) {
          stderr.push(chunk);
          return;
        }
        killer.kill('SIGKILL');
        settle(() => reject(new Error('taskkill.exe exceeded its 65536-byte diagnostic bound')));
      });
      killer.on('error', (error) => settle(() => reject(error)));
      killer.on('close', (code) => settle(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(
          `taskkill.exe failed with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
        ));
      }));
      const timer = setTimeout(() => {
        let killDetail = '';
        try {
          killer.kill('SIGKILL');
        } catch (error) {
          killDetail = `; could not kill taskkill.exe: ${error.message}`;
        }
        settle(() => reject(new Error(
          `taskkill.exe did not close within ${timeoutMs}ms${killDetail}`,
        )));
      }, timeoutMs);
  });
}

function signalTree(child, signal) {
  if (child.pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    // Node cannot deliver POSIX signals to a Windows process group. taskkill's
    // /T /F boundary atomically targets Bash and its descendants while the
    // parent PID is still live. Awaiting the bounded taskkill process prevents
    // a parent-only close event from being mistaken for complete tree cleanup.
    return forceWindowsProcessTree(child.pid);
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  return Promise.resolve();
}

test('Windows process-tree termination bounds a non-closing taskkill process', {timeout: 2_000}, async () => {
  const killer = new EventEmitter();
  killer.stderr = new EventEmitter();
  let killedWith;
  killer.kill = (signal) => {
    killedWith = signal;
    return true;
  };
  await assert.rejects(
    forceWindowsProcessTree(4242, {spawnImpl: () => killer, timeoutMs: 25}),
    /taskkill[.]exe did not close within 25ms/u,
  );
  assert.equal(killedWith, 'SIGKILL');
});

export function runBoundedBash(args, {
  label = `bash ${args.join(' ')}`,
  timeoutMs,
  terminationGraceMs = TERMINATION_GRACE_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = {bytes: 0};
    const stderrState = {bytes: 0};
    let failure;
    let completed = false;
    let closeTimer;
    let pendingClose;
    let terminationComplete = false;

    const diagnostics = () => [
      `stdout:\n${Buffer.concat(stdout).toString('utf8')}`,
      `stderr:\n${Buffer.concat(stderr).toString('utf8')}`,
    ].join('\n');
    const finish = (callback) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeTimer);
      callback();
    };
    const completeClose = ({code, signal}) => finish(() => {
      if (failure !== undefined) {
        reject(new Error(`${failure.message}\n${diagnostics()}`, {cause: failure}));
      } else if (code !== 0) {
        reject(new Error(`${label} exited with code ${code} and signal ${signal}\n${diagnostics()}`));
      } else {
        resolve();
      }
    });
    const terminate = (reason) => {
      if (failure !== undefined) return;
      failure = reason;
      void (async () => {
        try {
          if (process.platform === 'win32') {
            await signalTree(child, 'SIGKILL');
          } else {
            await signalTree(child, 'SIGTERM');
            await new Promise((resolveDelay) => setTimeout(resolveDelay, terminationGraceMs));
            await signalTree(child, 'SIGKILL');
          }
        } catch (error) {
          failure = new Error(`${reason.message}; could not terminate process tree: ${error.message}`, {cause: reason});
        }
        terminationComplete = true;
        if (pendingClose !== undefined) {
          completeClose(pendingClose);
          return;
        }
        closeTimer = setTimeout(() => finish(() => reject(new Error(
          `${failure.message}; process tree did not close after forced termination\n${diagnostics()}`,
          {cause: failure},
        ))), terminationGraceMs);
      })();
    };
    const timeoutTimer = setTimeout(() => terminate(
      new Error(`${label} did not complete within ${timeoutMs}ms`),
    ), timeoutMs);

    child.stdout.on('data', (chunk) => {
      try {
        appendBounded(stdout, stdoutState, chunk, `${label} stdout`);
      } catch (error) {
        terminate(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        appendBounded(stderr, stderrState, chunk, `${label} stderr`);
      } catch (error) {
        terminate(error);
      }
    });
    child.on('error', (error) => finish(() => reject(new Error(
      `${label} failed to start: ${error.message}`,
      {cause: error},
    ))));
    child.on('close', (code, signal) => {
      const result = {code, signal};
      if (failure !== undefined && !terminationComplete) {
        pendingClose = result;
        return;
      }
      completeClose(result);
    });
  });
}

test('bounded bootstrap runner kills a TERM-ignoring foreground process group', {timeout: 8_000}, async () => {
  const started = Date.now();
  let observed;
  try {
    await runBoundedBash(['-c', `trap '' TERM; node -e 'console.log("descendant=" + process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`], {
      label: 'TERM-ignoring bootstrap fixture',
      // Node startup can be delayed by the other cold bootstrap suites. The
      // short termination grace below, descendant liveness assertion, and
      // outer test deadline prove cleanup independently of startup latency.
      timeoutMs: 2_000,
      terminationGraceMs: 200,
    });
  } catch (error) {
    observed = error;
  }
  assert(observed instanceof Error, 'TERM-ignoring process fixture unexpectedly succeeded');
  assert.match(observed.message, /did not complete within 2000ms/u);
  const descendant = /descendant=(\d+)/u.exec(observed.message);
  assert(descendant !== null, `timeout diagnostics omitted the descendant PID: ${observed.message}`);
  const descendantPid = Number.parseInt(descendant[1], 10);
  for (let attempt = 0; attempt < 20 && processExists(descendantPid); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert(!processExists(descendantPid), 'TERM-ignoring descendant remained alive after process-tree termination');
  assert(Date.now() - started < 5_000, 'TERM-ignoring process group was not killed promptly');
});

for (const {script, timeoutMs} of INSTALLER_FAULT_SUITES) {
  test(`pinned toolchain bootstrap path fails closed: ${script}`, {
    timeout: timeoutMs + (TERMINATION_GRACE_MS * 2) + 5_000,
  }, async () => runBoundedBash([script], {label: script, timeoutMs}));
}
