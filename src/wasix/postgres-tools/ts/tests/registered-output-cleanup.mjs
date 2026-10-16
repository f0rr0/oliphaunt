import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// Exercise the installed addon across real environments. Terminating the
// callback owner must release concurrent stdout and stderr destination waits.
export async function verifyRegisteredOutputCleanup(addonPath, assets, runtime) {
  const workers = [];
  const spawn = (role, extra = {}) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { role, addonPath, assets, runtime, ...extra },
    });
    const state = { worker, exited: false };
    state.exit = new Promise((resolve) => {
      worker.once('exit', (code) => {
        state.exited = true;
        resolve(code);
      });
    });
    workers.push(state);
    return state;
  };
  const waitMessage = (worker, phase, accept) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(reject, new Error(`registered tool output cleanup timed out: ${phase}`)),
        30_000,
      );
      const finish = (callback, value) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        callback(value);
      };
      const onMessage = (message) => {
        if (accept(message)) finish(resolve, message);
      };
      const onError = (error) => finish(reject, error);
      const onExit = (code) =>
        finish(reject, new Error(`tool cleanup worker exited before its reply: ${code}`));
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
  try {
    const owner = spawn('owner');
    const { registrations, unused } = await waitMessage(
      owner.worker,
      'registration',
      (message) => 'registrations' in message,
    );
    const blocked = new Set();
    const waiting = waitMessage(owner.worker, 'both destination credits', (message) => {
      if (message.stream) blocked.add(message.stream);
      return blocked.size === 2;
    });
    const runners = ['stdout', 'stderr'].map((stream) => {
      const state = spawn('runner', { registration: registrations[stream], unused, stream });
      const completed = waitMessage(
        state.worker,
        `${stream} completion`,
        (message) => 'done' in message,
      );
      // Observe rejection even if the destination owner fails first.
      void completed.catch(() => undefined);
      return { state, completed };
    });
    await Promise.race([
      waiting,
      ...runners.map(({ completed }) =>
        completed.then((result) => {
          throw new Error(
            result.done ? 'tool completed before destination shutdown' : result.error,
          );
        }),
      ),
    ]);
    await owner.worker.terminate();
    for (const { state, completed } of runners) {
      const result = await completed;
      if (result.done !== true) throw new Error(result.error);
      // Bun does not settle terminate() after natural Worker teardown.
      if ((await state.exit) !== 0) throw new Error('tool cleanup worker failed during teardown');
    }
    console.log(`WASIX ${runtime} registered output environment cleanup: PASS`);
  } finally {
    for (const { worker, exited } of workers) {
      if (!exited) await worker.terminate();
    }
  }
}

if (!isMainThread) {
  const addon = createRequire(import.meta.url)(workerData.addonPath);
  if (workerData.role === 'owner') {
    const outputs = ['stdout', 'stderr'].map((stream) =>
      addon.NativeWasixToolOutput.open({
        stdout(packet) {
          if (stream === 'stdout') parentPort.postMessage({ stream });
          else packet.acknowledge();
        },
        stderr(packet) {
          if (stream === 'stderr') parentPort.postMessage({ stream });
          else packet.acknowledge();
        },
      }),
    );
    const unused = addon.NativeWasixToolOutput.open({ stdout() {} });
    globalThis.outputs = [...outputs, unused];
    parentPort.postMessage({
      registrations: { stdout: outputs[0].id, stderr: outputs[1].id },
      unused: unused.id,
    });
    setInterval(() => undefined, 60_000);
  } else {
    const database = addon.NativeWasixDatabase.open({
      profile: 'standard',
      storage: { kind: 'memory' },
      username: 'postgres',
      database: 'postgres',
      startupGucs: {},
      extensions: [],
    });
    try {
      let failure;
      try {
        database.psqlToRegisteredOutput(
          [],
          workerData.assets,
          workerData.registration,
          workerData.stream === 'stdout'
            ? "SELECT repeat('x', 4 * 1024 * 1024)"
            : "DO $$ BEGIN RAISE WARNING 'cleanup diagnostic'; END $$",
        );
      } catch (error) {
        failure = error;
      }
      if (failure?.oliphauntWasixError !== 'tool' || failure.exitCode !== 0) {
        throw new Error('environment shutdown lost completed-tool error metadata');
      }
      let closed;
      try {
        database.psqlToRegisteredOutput([], workerData.assets, workerData.unused, 'SELECT 1');
      } catch (error) {
        closed = error;
      }
      if (!closed?.message.includes('closed or already consumed')) {
        throw new Error('environment shutdown retained an unused output registration');
      }
      const query = Buffer.from('SELECT 42::text\0');
      const request = Buffer.alloc(5 + query.length);
      request[0] = 0x51;
      request.writeUInt32BE(4 + query.length, 1);
      query.copy(request, 5);
      if (!Buffer.from(database.execProtocolRaw(request)).includes(Buffer.from('42'))) {
        throw new Error('database did not recover after output environment shutdown');
      }
      database.close();
      parentPort.postMessage({ done: true });
    } catch (error) {
      database.close();
      parentPort.postMessage({ done: false, error: String(error) });
    }
    if (workerData.runtime === 'bun') process.exit(0);
    else {
      parentPort.close?.();
      parentPort.unref();
    }
  }
}
