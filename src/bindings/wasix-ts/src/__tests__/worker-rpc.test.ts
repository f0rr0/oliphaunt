import { describe, expect, it } from 'vitest';
import { runWasixPgDumpProcess } from '../database.js';
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

  it('rejects every pending and later request with one fatal worker error', async () => {
    const port = new FakeWorkerPort();
    const rpc = new WorkerRpc(port);
    const first = rpc.request({
      method: 'exec',
      input: Uint8Array.of(1),
      persistence: 'sync',
    });
    const second = rpc.request({ method: 'sync', boundary: 'checkpoint' });
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

    const streaming = database.execProtocolStream(Uint8Array.of(1, 2), (chunk) => {
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
    port.respond({ id: request.id, ok: true });
    await streaming;

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
    const consumerFailure = new Error('consumer stopped');

    const streaming = database.execProtocolStream(Uint8Array.of(1), () => {
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
      error: { name: 'Error', message: 'protocol stream consumer failed' },
    });
    await expect(streaming).rejects.toBe(consumerFailure);

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
