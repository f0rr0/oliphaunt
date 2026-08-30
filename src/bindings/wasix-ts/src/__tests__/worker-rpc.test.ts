import { describe, expect, it } from 'vitest';
import { runWasixPgDumpProcess, WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES } from '../database.js';
import type { WorkerResponse } from '../rpc.js';
import { createWorkerSessionDispatcher } from '../worker-dispatch.js';
import { openWorkerDatabase, WorkerRpc } from '../worker-rpc.js';
import { FakeWorkerPort, workerOpenOptions } from './worker-helpers.js';

describe('WASIX worker RPC', () => {
  it('runs pg_dump in the database worker and returns both owned output streams', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const dumping = runWasixPgDumpProcess(database, {
      runtimeVersion: '0.1.1',
      tool: {
        name: 'pg_dump',
        sha256: '4'.repeat(64),
        size: 1,
        source: Uint8Array.of(4),
      },
      args: ['--schema-only'],
    });
    const request = await postedRequest(port, 1);
    expect(request).toMatchObject({ method: 'runPgDump', args: ['--schema-only'] });
    port.respond({
      id: request.id,
      ok: true,
      value: {
        exitCode: 0,
        stdout: Uint8Array.of(1, 2),
        stderr: Uint8Array.of(3),
      },
    });
    await expect(dumping).resolves.toEqual({
      exitCode: 0,
      stdout: Uint8Array.of(1, 2),
      stderr: Uint8Array.of(3),
    });

    const malformed = runWasixPgDumpProcess(database, {
      runtimeVersion: '0.1.1',
      tool: {
        name: 'pg_dump',
        sha256: '4'.repeat(64),
        size: 1,
        source: Uint8Array.of(4),
      },
      args: [],
    });
    const malformedRequest = await postedRequest(port, 2);
    port.respond({ id: malformedRequest.id, ok: true, value: Uint8Array.of(9) });
    await expect(malformed).rejects.toThrow(/invalid pg_dump result/);

    const closing = database.close();
    const close = await postedRequest(port, 3);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('terminates the worker when opening returns an error', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const request = port.requests[0]?.message;
    expect(request?.method).toBe('open');
    if (request === undefined) {
      throw new Error('open request was not posted');
    }

    port.respond({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'runtime initialization failed' },
    });

    await expect(opening).rejects.toThrow('runtime initialization failed');
    expect(port.terminations).toBe(1);
  });

  it('preserves both worker-open and termination failures', async () => {
    const port = new FakeWorkerPort();
    port.terminate = () => {
      port.terminations += 1;
      throw new Error('worker termination failed');
    };
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const request = port.requests[0]?.message;
    if (request === undefined) throw new Error('open request was not posted');
    port.respond({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'runtime initialization failed' },
    });

    const failure = await opening.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate open failure');
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: 'runtime initialization failed' }),
      expect.objectContaining({ message: 'worker termination failed' }),
    ]);
    expect(port.terminations).toBe(1);
  });

  it('rejects every pending and later request with one fatal worker error', async () => {
    const port = new FakeWorkerPort();
    const rpc = new WorkerRpc(port);
    const first = rpc.request({
      method: 'exec',
      input: Uint8Array.of(1),
      persistence: 'sync',
    });
    const second = rpc.request({ method: 'sync', boundary: 'full' });
    const failure = new Error('worker exited unexpectedly');
    const firstRejection = expect(first).rejects.toBe(failure);
    const secondRejection = expect(second).rejects.toBe(failure);

    port.fail(failure);

    await firstRejection;
    await secondRejection;
    await expect(rpc.request({ method: 'close' })).rejects.toBe(failure);
    await rpc.terminate();
    expect(port.terminations).toBe(1);
  });

  it('makes an idle database terminal when its package Worker crashes', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const failure = new Error('worker crashed while idle');

    expect(database.closed).toBe(false);
    port.fail(failure);

    expect(database.closed).toBe(true);
    const operationFailure = await database.query('select 1').catch((error: unknown) => error);
    expect(operationFailure).toMatchObject({
      message: 'Oliphaunt WASIX database is closed',
      cause: failure,
    });

    const firstClose = database.close();
    const secondClose = database.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toBe(failure);
    await expect(secondClose).rejects.toBe(failure);
    expect(database.closed).toBe(true);
    expect(port.requests.map(({ message }) => message.method)).toEqual(['open']);
    expect(port.terminations).toBe(1);
  });

  it('keeps a failed worker close terminal and never posts later work', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const first = database.close();
    const second = database.close();
    expect(second).toBe(first);
    const close = await postedRequest(port, 1);
    port.respond({
      id: close.id,
      ok: false,
      error: { name: 'Error', message: 'guest close failed' },
    });

    await expect(first).rejects.toThrow('guest close failed');
    await expect(second).rejects.toThrow('guest close failed');
    expect(database.closed).toBe(true);
    expect(database.close()).toBe(first);
    await expect(database.execProtocolRaw(Uint8Array.of(1))).rejects.toThrow(
      'Oliphaunt WASIX database is closed',
    );
    expect(port.requests.map(({ message }) => message.method)).toEqual(['open', 'close']);
    expect(port.terminations).toBe(1);
  });

  it('preserves both remote-close and worker-termination failures', async () => {
    const port = new FakeWorkerPort();
    port.terminate = () => {
      port.terminations += 1;
      throw new Error('worker termination failed');
    };
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const closing = database.close();
    const close = await postedRequest(port, 1);
    port.respond({
      id: close.id,
      ok: false,
      error: { name: 'Error', message: 'guest close failed' },
    });
    const failure = await closing.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate close failure');
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: 'guest close failed' }),
      expect.objectContaining({ message: 'worker termination failed' }),
    ]);
    expect(database.closed).toBe(true);
    expect(port.terminations).toBe(1);
  });

  it('waits for a quiescent server Worker to self-exit without forced termination', async () => {
    const port = new FakeWorkerPort();
    let finishExit!: () => void;
    port.expectSelfExit = () =>
      new Promise<void>((resolve) => {
        finishExit = resolve;
      });
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const closing = database.close();
    const close = await postedRequest(port, 1);
    port.respond({ id: close.id, ok: true });
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(port.terminations).toBe(0);
    finishExit();
    await closing;
    expect(port.terminations).toBe(0);
  });

  it('waits for full Worker self-exit after a failing native close', async () => {
    const port = new FakeWorkerPort();
    let finishExit!: () => void;
    port.expectSelfExit = () =>
      new Promise<void>((resolve) => {
        finishExit = resolve;
      });
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const closing = database.close();
    const close = await postedRequest(port, 1);
    port.respond({
      id: close.id,
      ok: false,
      error: { name: 'Error', message: 'guest close failed' },
    });
    let settled = false;
    void closing.catch(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(port.terminations).toBe(0);
    finishExit();
    await expect(closing).rejects.toThrow('guest close failed');
    expect(port.terminations).toBe(0);
  });

  it('preserves deferred execution and explicit sync boundaries across worker RPC', async () => {
    const events: string[] = [];
    const responses: Array<{ id: number; ok: boolean }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(_input, persistence) {
          events.push(`exec:${persistence}`);
          return Uint8Array.of(1);
        },
        async sync(boundary) {
          events.push(`sync:${boundary}`);
        },
        async close() {},
      }),
      (response) => {
        if ('ok' in response) responses.push(response);
      },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({
      id: 2,
      method: 'exec',
      input: Uint8Array.of(0),
      persistence: 'defer',
    });
    await dispatch({ id: 3, method: 'sync', boundary: 'operation' });

    expect(events).toEqual(['exec:defer', 'sync:operation']);
    expect(responses).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: true, value: Uint8Array.of(1) },
      { id: 3, ok: true },
    ]);
  });

  it('stops worker-side delivery after the consumer failure signal', async () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    const responses: WorkerResponse[] = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          return input;
        },
        async execStream(_input, onChunk) {
          try {
            onChunk(Uint8Array.of(1));
          } catch {
            // Exercise the dispatcher's own guard even if a faulty session
            // attempts another delivery after callback abort.
            try {
              onChunk(Uint8Array.of(2));
            } catch {
              // The session still reports its independently recovered outcome.
            }
            return 'callbackAborted';
          }
          return 'complete';
        },
        async sync() {},
        async close() {},
      }),
      (response) => {
        responses.push(response);
        if ('kind' in response) {
          Atomics.store(control, 1, 1);
          Atomics.store(control, 0, response.sequence);
          Atomics.notify(control, 0);
        }
      },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({
      id: 2,
      method: 'execStream',
      input: Uint8Array.of(0),
      persistence: 'sync',
      control: control.buffer as SharedArrayBuffer,
    });

    expect(responses).toEqual([
      { id: 1, ok: true },
      { id: 2, kind: 'chunk', sequence: 1, value: Uint8Array.of(1) },
      { id: 2, ok: true, streamOutcome: 'callbackAborted' },
    ]);
  });

  it('retires the worker dispatcher before awaiting a failing session close', async () => {
    let closes = 0;
    let executions = 0;
    const responses: Array<{ id: number; ok: boolean }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          executions += 1;
          return input;
        },
        async sync() {},
        async close() {
          closes += 1;
          throw new Error('guest close failed');
        },
      }),
      (response) => {
        if ('ok' in response) responses.push(response);
      },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({ id: 2, method: 'close' });
    await dispatch({
      id: 3,
      method: 'exec',
      input: Uint8Array.of(1),
      persistence: 'sync',
    });
    await dispatch({ id: 4, method: 'open', options: workerOpenOptions() });

    expect(responses.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
      { id: 3, ok: false },
      { id: 4, ok: false },
    ]);
    expect(closes).toBe(1);
    expect(executions).toBe(0);
  });

  it('announces Worker self-exit only after a failing native close reply is posted', async () => {
    const events: string[] = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          return input;
        },
        async sync() {},
        async close() {
          events.push('native-close');
          throw new Error('close failed');
        },
      }),
      (response) => {
        if ('ok' in response && response.id === 2) events.push(`response:${response.ok}`);
      },
      undefined,
      { onQuiescentClose: () => events.push('self-exit') },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({ id: 2, method: 'close' });

    expect(events).toEqual(['native-close', 'response:false', 'self-exit']);
  });

  it('rejects a malformed one-shot restore without opening a database session', async () => {
    let opened = false;
    const responses: Array<{ id: number; ok: boolean }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => {
        opened = true;
        throw new Error('unexpected open');
      },
      (response) => {
        if ('ok' in response) responses.push(response);
      },
    );

    await dispatch({
      id: 1,
      method: 'restore',
      storage: { schema: 'oliphaunt-wasix-storage-v1', kind: 'indexed-db', name: 'restore' },
      bytes: Uint8Array.of(1, 2, 3),
    });

    expect(opened).toBe(false);
    expect(responses).toEqual([{ id: 1, ok: false, error: expect.anything() }]);
  });

  it('dispatches pg_dump in the opened session and transfers its outputs', async () => {
    const responses: Array<{ response: unknown; transfer: readonly ArrayBuffer[] }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          return input;
        },
        async sync() {},
        async runPgDump() {
          return {
            exitCode: 7,
            stdout: Uint8Array.of(1, 2),
            stderr: Uint8Array.of(3, 4),
          };
        },
        async close() {},
      }),
      (response, transfer = []) => responses.push({ response, transfer }),
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({
      id: 2,
      method: 'runPgDump',
      tool: {
        name: 'pg_dump',
        sha256: '4'.repeat(64),
        size: 1,
        source: Uint8Array.of(4),
      },
      args: ['--schema-only'],
    });

    expect(responses[1]?.response).toEqual({
      id: 2,
      ok: true,
      value: {
        exitCode: 7,
        stdout: Uint8Array.of(1, 2),
        stderr: Uint8Array.of(3, 4),
      },
    });
    expect(responses[1]?.transfer).toHaveLength(2);
    const toolResponse = responses[1];
    if (toolResponse === undefined) throw new Error('missing tool response');
    const cloned = structuredClone(toolResponse.response, {
      transfer: [...toolResponse.transfer],
    }) as { value: { stdout: Uint8Array; stderr: Uint8Array } };
    expect([...cloned.value.stdout]).toEqual([1, 2]);
    expect([...cloned.value.stderr]).toEqual([3, 4]);
    expect(toolResponse.transfer.every((buffer) => buffer.byteLength === 0)).toBe(true);
  });

  it('returns raw bytes in an ordinary transferable V8 buffer', async () => {
    let sent: Readonly<{ response: WorkerResponse; transfer: readonly ArrayBuffer[] }> | undefined;
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec() {
          return Uint8Array.of(21, 22, 23);
        },
        async sync() {},
        async close() {},
      }),
      (response, transfer = []) => {
        if ('ok' in response && response.id === 2) sent = { response, transfer };
      },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({
      id: 2,
      method: 'exec',
      input: Uint8Array.of(1),
      persistence: 'sync',
    });

    if (sent === undefined) throw new Error('missing raw worker response');
    const original = sent as { response: WorkerResponse; transfer: readonly ArrayBuffer[] };
    const cloned = structuredClone(original.response, {
      transfer: [...original.transfer],
    });
    expect(cloned).toMatchObject({ id: 2, ok: true, value: Uint8Array.of(21, 22, 23) });
    expect(original.transfer).toHaveLength(1);
    expect(original.transfer[0]?.byteLength).toBe(0);
  });

  it('fails closed around open state and transfers optional physical backups', async () => {
    const responses: Array<{ id: number; ok: boolean; value?: unknown }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          return input;
        },
        async sync() {},
        async backup() {
          return Uint8Array.of(7, 8, 9);
        },
        async close() {},
      }),
      (response) => {
        if ('ok' in response) responses.push(response);
      },
    );

    await dispatch({
      id: 1,
      method: 'exec',
      input: Uint8Array.of(1),
      persistence: 'sync',
    });
    await dispatch({ id: 2, method: 'open', options: workerOpenOptions() });
    await dispatch({ id: 3, method: 'open', options: workerOpenOptions() });
    await dispatch({ id: 4, method: 'backup' });
    await dispatch({ id: 5, method: 'close' });
    await dispatch({ id: 6, method: 'close' });

    expect(responses.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: 1, ok: false },
      { id: 2, ok: true },
      { id: 3, ok: false },
      { id: 4, ok: true },
      { id: 5, ok: true },
      { id: 6, ok: false },
    ]);
    expect(responses[3]?.value).toEqual(Uint8Array.of(7, 8, 9));
  });

  it('rejects backup when the opened worker session does not provide it', async () => {
    const responses: Array<{ id: number; ok: boolean }> = [];
    const dispatch = createWorkerSessionDispatcher(
      async () => ({
        async exec(input) {
          return input;
        },
        async sync() {},
        async close() {},
      }),
      (response) => {
        if ('ok' in response) responses.push(response);
      },
    );

    await dispatch({ id: 1, method: 'open', options: workerOpenOptions() });
    await dispatch({ id: 2, method: 'backup' });

    expect(responses.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
    ]);
  });

  it('normalizes synchronous transport failures and reports termination failures', async () => {
    const listeners: { fatal?: (error: Error) => void } = {};
    const rpc = new WorkerRpc({
      postMessage() {
        throw 'post failed';
      },
      terminate() {
        throw 'termination failed';
      },
      onMessage() {},
      onFatal(listener) {
        listeners.fatal = listener;
      },
    });

    await expect(
      rpc.request({
        method: 'exec',
        input: Uint8Array.of(1),
        persistence: 'sync',
      }),
    ).rejects.toThrow('post failed');
    await expect(rpc.terminate()).rejects.toThrow('termination failed');
    listeners.fatal?.(new Error('late fatal event'));
    await expect(rpc.request({ method: 'close' })).rejects.toThrow(
      'Oliphaunt WASIX worker was terminated',
    );
  });

  it('ignores responses for requests the caller no longer owns', () => {
    const port = new FakeWorkerPort();
    new WorkerRpc(port);
    port.respond({ id: 999, ok: true });
    expect(port.requests).toEqual([]);
  });

  it('carries raw protocol and backup bytes through one orderly worker session', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const raw = database.execProtocolRaw(Uint8Array.of(1, 2));
    const exec = await postedRequest(port, 1);
    expect(exec).toMatchObject({ method: 'exec', persistence: 'sync' });
    port.respond({ id: exec.id, ok: true, value: Uint8Array.of(3, 4) });
    await expect(raw).resolves.toEqual(Uint8Array.of(3, 4));

    const backup = database.backup();
    const backupRequest = await postedRequest(port, 2);
    expect(backupRequest.method).toBe('backup');
    port.respond({
      id: backupRequest.id,
      ok: true,
      value: Uint8Array.of(5, 6),
    });
    const sync = await postedRequest(port, 3);
    expect(sync).toMatchObject({ method: 'sync', boundary: 'operation' });
    port.respond({ id: sync.id, ok: true });
    await expect(backup).resolves.toEqual(Uint8Array.of(5, 6));

    const closing = database.close();
    const close = await postedRequest(port, 4);
    expect(close.method).toBe('close');
    port.respond({ id: close.id, ok: true });
    await closing;
    expect(port.terminations).toBe(1);
  });

  it('acknowledges streamed chunks only after the consumer has handled them', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const chunks: number[][] = [];

    const streaming = database.execProtocolRawStream(Uint8Array.of(1, 2), (chunk) => {
      chunks.push([...chunk]);
    });
    const request = await postedRequest(port, 1);
    if (request.method !== 'execStream') throw new Error('expected streaming request');
    const control = new Int32Array(request.control);
    expect(Atomics.load(control, 0)).toBe(0);
    port.respond({
      id: request.id,
      kind: 'chunk',
      sequence: 1,
      value: Uint8Array.of(3, 4),
    });
    expect(chunks).toEqual([[3, 4]]);
    expect(Atomics.load(control, 0)).toBe(1);
    port.respond({ id: request.id, ok: true, streamOutcome: 'complete' });
    await streaming;

    const closing = database.close();
    const close = await postedRequest(port, 2);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('buffers and chunks streams without shared memory across a process transport', async () => {
    const port = new FakeWorkerPort();
    Object.defineProperty(port, 'supportsSharedMemory', { value: false });
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const chunkLengths: number[] = [];

    const streaming = database.execProtocolRawStream(Uint8Array.of(1), (chunk) => {
      chunkLengths.push(chunk.length);
    });
    const request = await postedRequest(port, 1);
    expect(request.method).toBe('exec');
    const response = new Uint8Array(WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES + 3);
    port.respond({ id: request.id, ok: true, value: response });

    await streaming;
    expect(chunkLengths).toEqual([WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES, 3]);

    const closing = database.close();
    const close = await postedRequest(port, 2);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('preserves the stream consumer failure and signals the blocked worker', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const consumerFailure = { reason: 'consumer stopped' };
    let consumerCalls = 0;

    const streaming = database.execProtocolRawStream(Uint8Array.of(1), () => {
      consumerCalls += 1;
      throw consumerFailure;
    });
    const request = await postedRequest(port, 1);
    if (request.method !== 'execStream') throw new Error('expected streaming request');
    const control = new Int32Array(request.control);
    port.respond({ id: request.id, kind: 'chunk', sequence: 1, value: Uint8Array.of(2) });
    expect(Atomics.load(control, 0)).toBe(1);
    expect(Atomics.load(control, 1)).toBe(1);
    // A stale or faulty worker must still be acknowledged without reentering a
    // consumer whose first failure has already stopped delivery.
    port.respond({ id: request.id, kind: 'chunk', sequence: 2, value: Uint8Array.of(3) });
    expect(Atomics.load(control, 0)).toBe(2);
    expect(consumerCalls).toBe(1);
    port.respond({ id: request.id, ok: true, streamOutcome: 'callbackAborted' });
    await expect(streaming).rejects.toBe(consumerFailure);

    const closing = database.close();
    const close = await postedRequest(port, 2);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('keeps a worker recovery failure primary over the stream consumer failure', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;
    const consumerFailure = { reason: 'consumer stopped' };

    const streaming = database.execProtocolRawStream(Uint8Array.of(1), () => {
      throw consumerFailure;
    });
    const request = await postedRequest(port, 1);
    if (request.method !== 'execStream') throw new Error('expected streaming request');
    const control = new Int32Array(request.control);
    port.respond({ id: request.id, kind: 'chunk', sequence: 1, value: Uint8Array.of(2) });
    expect(Atomics.load(control, 0)).toBe(1);
    expect(Atomics.load(control, 1)).toBe(1);
    port.respond({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'ReadyForQuery recovery failed' },
    });
    await expect(streaming).rejects.toMatchObject({ message: 'ReadyForQuery recovery failed' });
    await expect(database.execProtocolRaw(Uint8Array.of(3))).rejects.toMatchObject({
      message: expect.stringContaining('transaction outcome became unknown'),
      cause: expect.objectContaining({ message: 'ReadyForQuery recovery failed' }),
    });
    expect(port.requests.map(({ message }) => message.method)).toEqual(['open', 'execStream']);

    const closing = database.close();
    const close = await postedRequest(port, 2);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('rejects async stream consumers before acknowledging worker completion', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const dynamicallyTypedAsyncCallback: (chunk: Uint8Array) => unknown = async () => undefined;
    const streaming = database.execProtocolRawStream(
      Uint8Array.of(1),
      dynamicallyTypedAsyncCallback as unknown as (chunk: Uint8Array) => undefined,
    );
    const request = await postedRequest(port, 1);
    if (request.method !== 'execStream') throw new Error('expected streaming request');
    const control = new Int32Array(request.control);
    port.respond({ id: request.id, kind: 'chunk', sequence: 1, value: Uint8Array.of(2) });
    expect(Atomics.load(control, 0)).toBe(1);
    expect(Atomics.load(control, 1)).toBe(1);
    port.respond({ id: request.id, ok: true, streamOutcome: 'callbackAborted' });
    await expect(streaming).rejects.toThrow(/must complete synchronously.*Promise or thenable/);

    const closing = database.close();
    const close = await postedRequest(port, 2);
    port.respond({ id: close.id, ok: true });
    await closing;
  });

  it('rejects malformed byte responses from a worker without poisoning the session', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const open = await postedRequest(port, 0);
    port.respond({ id: open.id, ok: true });
    const database = await opening;

    const raw = database.execProtocolRaw(Uint8Array.of(1));
    const exec = await postedRequest(port, 1);
    port.respond({ id: exec.id, ok: true });
    await expect(raw).rejects.toThrow('invalid protocol response');

    const backup = database.backup();
    const backupRequest = await postedRequest(port, 2);
    port.respond({ id: backupRequest.id, ok: true });
    await expect(backup).rejects.toThrow('invalid physical archive');

    const closing = database.close();
    const close = await postedRequest(port, 3);
    port.respond({ id: close.id, ok: true });
    await closing;
  });
});

async function postedRequest(port: FakeWorkerPort, index: number) {
  for (let attempt = 0; attempt < 10 && port.requests[index] === undefined; attempt += 1) {
    await Promise.resolve();
  }
  const request = port.requests[index]?.message;
  if (request === undefined) {
    throw new Error(`worker request ${index} was not posted`);
  }
  return request;
}
