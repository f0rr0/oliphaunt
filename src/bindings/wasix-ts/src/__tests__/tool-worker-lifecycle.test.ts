import { describe, expect, it, vi } from 'vitest';

import {
  closeWasixByteChannel,
  createWasixByteChannel,
  markWasixByteChannelProtocolComplete,
  markWasixByteChannelProtocolStarted,
  readWasixByteChannel,
  wasixByteChannelProtocolOutcomeUnknown,
  wasixByteChannelProtocolStarted,
} from '../byte-channel.js';
import { WasixDatabaseImpl, type WasixDatabaseSession } from '../database.js';
import {
  runWasixToolProcess,
  type WasixToolProcessOptions,
  type WasixToolWorkerPort,
} from '../internal-common.js';
import {
  createWasixToolWorkerDispatcher,
  type WasixToolHost,
  type WasixToolWorkerRequest,
  type WasixToolWorkerResponse,
} from '../tool-worker-common.js';

const tool: WasixToolProcessOptions['tool'] = {
  name: 'psql',
  sha256: '4'.repeat(64),
  size: 1,
  source: Uint8Array.of(4),
};
const EMPTY_WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const runnableTool = {
  name: 'psql' as const,
  sha256: '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476',
  size: EMPTY_WASM.length,
  source: EMPTY_WASM,
};

describe('persistent WASIX tool worker lifecycle', () => {
  it('closes pre-protocol failures cleanly and fails post-protocol failures', async () => {
    let enterProtocol = false;
    const dispatch = createWasixToolWorkerDispatcher(
      fakeToolHost((_read, write) => {
        if (enterProtocol) write(Uint8Array.of(1));
        throw new Error(enterProtocol ? 'post-protocol failure' : 'pre-protocol failure');
      }),
    );
    await expect(dispatch({ id: 1, kind: 'prepare', tool: runnableTool })).resolves.toMatchObject({
      ok: true,
      kind: 'prepared',
    });

    const beforeFrontend = createWasixByteChannel();
    const beforeBackend = createWasixByteChannel();
    await expect(
      dispatch({
        id: 2,
        kind: 'run',
        tool: 'psql',
        args: [],
        frontend: beforeFrontend,
        backend: beforeBackend,
      }),
    ).resolves.toMatchObject({ ok: false, message: 'pre-protocol failure' });
    expect(wasixByteChannelProtocolStarted(beforeFrontend)).toBe(false);
    await expect(readWasixByteChannel(beforeFrontend)).resolves.toEqual(new Uint8Array());

    enterProtocol = true;
    const afterFrontend = createWasixByteChannel();
    const afterBackend = createWasixByteChannel();
    await expect(
      dispatch({
        id: 3,
        kind: 'run',
        tool: 'psql',
        args: [],
        frontend: afterFrontend,
        backend: afterBackend,
      }),
    ).resolves.toMatchObject({ ok: false, message: 'post-protocol failure' });
    expect(wasixByteChannelProtocolStarted(afterFrontend)).toBe(true);
    await expect(readWasixByteChannel(afterFrontend)).rejects.toThrow('byte channel failed');
  });

  it('reports private mount cleanup failure without failing completed protocol channels', async () => {
    const dispatch = createWasixToolWorkerDispatcher(
      fakeToolHost((_read, write) => {
        write(Uint8Array.of(7));
        return {
          code: 0,
          stdoutBytes: new Uint8Array(),
          stderrBytes: new Uint8Array(),
        };
      }, CleanupFailingToolDirectory),
    );
    await dispatch({ id: 1, kind: 'prepare', tool: runnableTool });
    const frontend = createWasixByteChannel();
    const backend = createWasixByteChannel();

    await expect(
      dispatch({ id: 2, kind: 'run', tool: 'psql', args: [], frontend, backend }),
    ).resolves.toMatchObject({ ok: false, message: 'WASIX tool mount cleanup failed' });
    expect(wasixByteChannelProtocolStarted(frontend)).toBe(true);
    expect(wasixByteChannelProtocolOutcomeUnknown(frontend)).toBe(false);
    await expect(readWasixByteChannel(frontend)).resolves.toEqual(Uint8Array.of(7));
    await expect(readWasixByteChannel(frontend)).resolves.toEqual(new Uint8Array());
  });

  it('runs pg_dump in the owning database realm without creating a tool worker', async () => {
    const createWorker = vi.fn(() => {
      throw new Error('pg_dump must not create a second worker');
    });
    const runPgDump = vi.fn(async () => ({
      exitCode: 0,
      stdout: Uint8Array.of(1, 2),
      stderr: new Uint8Array(),
    }));
    const database = new WasixDatabaseImpl({
      identity: { username: 'application', database: 'application' },
      async exec() {
        return new Uint8Array();
      },
      async sync() {},
      runPgDump,
      async close() {},
    });

    await expect(
      runWasixToolProcess(
        database,
        {
          runtimeVersion: '0.1.1',
          tool: { ...tool, name: 'pg_dump' },
          args: ['--schema-only'],
        },
        createWorker,
      ),
    ).resolves.toMatchObject({ stdout: Uint8Array.of(1, 2) });

    expect(runPgDump).toHaveBeenCalledOnce();
    expect(createWorker).not.toHaveBeenCalled();
    await database.close();
  });

  it('keeps psql unavailable on a direct database handle', async () => {
    const createWorker = vi.fn(() => new FakeToolWorkerPort());
    const database = new WasixDatabaseImpl({
      async exec() {
        return new Uint8Array();
      },
      async sync() {},
      async runPgDump() {
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
      async close() {},
    });

    expect(() => run(database, createWorker)).toThrow(
      'WASIX psql and local servers require @oliphaunt/wasix-ts/worker',
    );
    expect(createWorker).not.toHaveBeenCalled();
    await database.close();
  });

  it('reuses one worker and one listener router with monotonic request ids', async () => {
    const port = new FakeToolWorkerPort();
    let workerCount = 0;
    const database = workerDatabase();
    const createWorker = () => {
      workerCount += 1;
      return port;
    };

    const first = run(database, createWorker);
    const prepare = await port.request(0);
    expect(prepare).toMatchObject({ id: 1, kind: 'prepare' });
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const firstRun = await port.request(1);
    expect(firstRun).toMatchObject({ id: 2, kind: 'run' });
    port.complete(firstRun.id, 'first');
    await expect(first).resolves.toMatchObject({ stdout: new TextEncoder().encode('first') });

    const second = run(database, createWorker);
    const secondRun = await port.request(2);
    expect(secondRun).toMatchObject({ id: 3, kind: 'run' });
    port.complete(secondRun.id, 'second');
    await expect(second).resolves.toMatchObject({ stdout: new TextEncoder().encode('second') });

    expect(workerCount).toBe(1);
    expect(port.messageListenerRegistrations).toBe(1);
    expect(port.fatalListenerRegistrations).toBe(1);
    await database.close();
    expect(port.terminateCount).toBe(1);
  });

  it('reserves cold and queued tool calls in the database invocation order', async () => {
    const port = new FakeToolWorkerPort();
    const events: string[] = [];
    const firstServe = deferred();
    const secondServe = deferred();
    let serveCount = 0;
    const database = new WasixDatabaseImpl({
      supportsProtocolConnections: true,
      identity: { username: 'application', database: 'application' },
      async exec() {
        events.push('query');
        return new Uint8Array();
      },
      async sync() {},
      serve() {
        serveCount += 1;
        events.push(`tool-${serveCount}`);
        return serveCount === 1 ? firstServe.promise : secondServe.promise;
      },
      async close() {},
    });

    const first = run(database, () => port);
    const second = run(database, () => port);
    const query = database.execProtocolRaw(Uint8Array.of(1));

    const prepare = await port.request(0);
    expect(events).toEqual([]);
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const firstInvocation = await port.request(1);
    await Promise.resolve();
    expect(events).toEqual(['tool-1']);
    port.complete(firstInvocation.id, 'first');
    firstServe.resolve();
    await first;

    const secondInvocation = await port.request(2);
    expect(events).toEqual(['tool-1', 'tool-2']);
    port.complete(secondInvocation.id, 'second');
    secondServe.resolve();

    await Promise.all([second, query]);
    expect(events).toEqual(['tool-1', 'tool-2', 'query']);
    await database.close();
  });

  it('waits for an active tool response before terminating during concurrent close', async () => {
    const port = new FakeToolWorkerPort();
    let sessionCloseCount = 0;
    let finishServe: (() => void) | undefined;
    const database = workerDatabase(
      () => {
        sessionCloseCount += 1;
      },
      () =>
        new Promise<void>((resolve) => {
          finishServe = resolve;
        }),
    );
    const running = run(database, () => port);
    const prepare = await port.request(0);
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await port.request(1);

    const firstClose = database.close();
    const secondClose = database.close();
    expect(firstClose).toBe(secondClose);
    await Promise.resolve();
    await Promise.resolve();
    expect(port.terminateCount).toBe(0);

    port.complete(invocation.id, 'done');
    finishServe?.();
    await running;
    await Promise.all([firstClose, secondClose]);
    expect(sessionCloseCount).toBe(1);
    expect(port.terminateCount).toBe(1);
  });

  it('aborts a hung prepare and rejects queued tools when the database closes', async () => {
    const port = new FakeToolWorkerPort();
    const serve = vi.fn(async () => undefined);
    const database = workerDatabase(() => undefined, serve);
    const first = run(database, () => port);
    const queued = run(database, () => port);
    await port.request(0);

    const firstFailure = expect(first).rejects.toThrow('tool worker is closing');
    const queuedFailure = expect(queued).rejects.toThrow('tool worker is closing');
    await database.close();
    await Promise.all([firstFailure, queuedFailure]);

    expect(port.requests).toHaveLength(1);
    expect(port.terminateCount).toBe(1);
    expect(serve).not.toHaveBeenCalled();
  });

  it('settles database close after aborting a hung active tool and serve path', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeToolWorkerPort();
      let abortCount = 0;
      let serveStarted: (() => void) | undefined;
      const serving = new Promise<void>((resolve) => {
        serveStarted = resolve;
      });
      const database = new WasixDatabaseImpl({
        supportsProtocolConnections: true,
        identity: { username: 'application', database: 'application' },
        async exec() {
          return new Uint8Array();
        },
        async sync() {},
        serve() {
          serveStarted?.();
          return new Promise(() => undefined);
        },
        async close() {},
        abort() {
          abortCount += 1;
        },
      });
      const running = run(database, () => port);
      const prepare = await port.request(0);
      port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
      await port.request(1);
      await serving;

      const toolFailure = expect(running).rejects.toThrow('tool worker is closing');
      const closeFailure = expect(database.close()).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
      await vi.advanceTimersByTimeAsync(120_000);

      await Promise.all([toolFailure, closeFailure]);
      expect(abortCount).toBe(1);
      expect(port.terminateCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry or recreate a tool after an active worker crash', async () => {
    const firstPort = new FakeToolWorkerPort();
    let workerCount = 0;
    const database = workerDatabase();
    const createWorker = () => {
      workerCount += 1;
      return firstPort;
    };
    const running = run(database, createWorker);
    const prepare = await firstPort.request(0);
    firstPort.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await firstPort.request(1);
    if (invocation.kind !== 'run') throw new Error('expected tool run request');
    markWasixByteChannelProtocolStarted(invocation.frontend);

    firstPort.crash(new Error('tool worker crashed while active'));
    await expect(running).rejects.toThrow('tool worker crashed while active');
    await expect(run(database, createWorker)).rejects.toThrow('tool worker crashed while active');
    expect(workerCount).toBe(1);
    expect(firstPort.terminateCount).toBe(1);
    await database.close();
  });

  it('keeps the database usable after a pre-protocol psql execution failure', async () => {
    const port = new FakeToolWorkerPort();
    const database = protocolLifecycleDatabase();
    const running = run(database, () => port);
    const prepare = await port.request(0);
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await port.request(1);
    port.respond({ id: invocation.id, ok: false, message: 'psql failed before connect' });

    await expect(running).rejects.toThrow('psql failed before connect');
    await expect(database.execProtocolRaw(Uint8Array.of(1))).resolves.toBeInstanceOf(Uint8Array);
    await database.close();
  });

  it('poisons the database after a post-protocol psql execution failure', async () => {
    const port = new FakeToolWorkerPort();
    const database = protocolLifecycleDatabase();
    const running = run(database, () => port);
    const prepare = await port.request(0);
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await port.request(1);
    if (invocation.kind !== 'run') throw new Error('expected tool run request');
    markWasixByteChannelProtocolStarted(invocation.frontend);
    port.respond({ id: invocation.id, ok: false, message: 'psql trapped after connect' });

    await expect(running).rejects.toThrow('psql trapped after connect');
    await expect(database.execProtocolRaw(Uint8Array.of(1))).rejects.toThrow(
      'database protocol outcome is unknown',
    );
    await database.close();
  });

  it('keeps the database usable after completed psql mount cleanup fails', async () => {
    const port = new FakeToolWorkerPort();
    const database = protocolLifecycleDatabase();
    const running = run(database, () => port);
    const prepare = await port.request(0);
    port.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await port.request(1);
    if (invocation.kind !== 'run') throw new Error('expected tool run request');
    markWasixByteChannelProtocolStarted(invocation.frontend);
    markWasixByteChannelProtocolComplete(invocation.frontend);
    closeWasixByteChannel(invocation.frontend);
    port.respond({ id: invocation.id, ok: false, message: 'private mount cleanup failed' });

    await expect(running).rejects.toThrow('private mount cleanup failed');
    await expect(database.execProtocolRaw(Uint8Array.of(1))).resolves.toBeInstanceOf(Uint8Array);
    await database.close();
  });

  it('can recreate a worker after a prepare-time crash that did not touch PostgreSQL', async () => {
    const firstPort = new FakeToolWorkerPort();
    const secondPort = new FakeToolWorkerPort();
    const ports: FakeToolWorkerPort[] = [firstPort, secondPort];
    let workerCount = 0;
    const serve = vi.fn(async () => undefined);
    const database = workerDatabase(() => undefined, serve);
    const createWorker = () => {
      const port = ports[workerCount];
      workerCount += 1;
      if (port === undefined) throw new Error('unexpected extra tool worker');
      return port;
    };

    const first = run(database, createWorker);
    await firstPort.request(0);
    firstPort.crash(new Error('prepare worker crashed'));
    await expect(first).rejects.toThrow('prepare worker crashed');
    expect(serve).not.toHaveBeenCalled();

    const second = run(database, createWorker);
    const prepare = await secondPort.request(0);
    expect(prepare).toMatchObject({ id: 2, kind: 'prepare' });
    secondPort.respond({ id: prepare.id, ok: true, kind: 'prepared' });
    const invocation = await secondPort.request(1);
    expect(invocation).toMatchObject({ id: 3, kind: 'run' });
    secondPort.complete(invocation.id, 'recovered');
    await expect(second).resolves.toMatchObject({ stdout: new TextEncoder().encode('recovered') });
    expect(workerCount).toBe(2);
    expect(serve).toHaveBeenCalledOnce();
    await database.close();
  });

  it('waits for a retired prepare-crash worker to terminate before database close settles', async () => {
    const port = new FakeToolWorkerPort();
    let finishTermination: (() => void) | undefined;
    port.termination = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const database = workerDatabase();
    const running = run(database, () => port);
    await port.request(0);
    const failure = expect(running).rejects.toThrow('prepare worker crashed');
    port.crash(new Error('prepare worker crashed'));
    await failure;

    let closed = false;
    const closing = database.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    finishTermination?.();
    await closing;
    expect(closed).toBe(true);
    expect(port.terminateCount).toBe(1);
  });

  it('reports a retired prepare-crash worker termination failure during database close', async () => {
    const port = new FakeToolWorkerPort();
    let rejectTermination: ((error: Error) => void) | undefined;
    port.termination = new Promise<void>((_, reject) => {
      rejectTermination = reject;
    });
    const database = workerDatabase();
    const running = run(database, () => port);
    await port.request(0);
    const runFailure = expect(running).rejects.toThrow('prepare worker crashed');
    port.crash(new Error('prepare worker crashed'));
    await runFailure;

    rejectTermination?.(new Error('retired worker termination failed'));

    await expect(database.close()).rejects.toThrow(/resource cleanup failed/);
    expect(port.terminateCount).toBe(1);
  });
});

function run(
  database: WasixDatabaseImpl,
  createWorker: () => WasixToolWorkerPort,
): ReturnType<typeof runWasixToolProcess> {
  return runWasixToolProcess(
    database,
    { runtimeVersion: '0.1.1', tool, args: ['--command=SELECT 1'] },
    createWorker,
  );
}

function workerDatabase(
  onClose: () => void = () => undefined,
  serve: () => Promise<void> = async () => undefined,
): WasixDatabaseImpl {
  const session: WasixDatabaseSession = {
    supportsProtocolConnections: true,
    identity: { username: 'application', database: 'application' },
    async exec() {
      return new Uint8Array();
    },
    async sync() {},
    serve,
    async close() {
      onClose();
    },
  };
  return new WasixDatabaseImpl(session);
}

function protocolLifecycleDatabase(): WasixDatabaseImpl {
  let failed = false;
  return new WasixDatabaseImpl({
    supportsProtocolConnections: true,
    identity: { username: 'application', database: 'application' },
    async exec() {
      if (failed) throw new Error('database protocol outcome is unknown');
      return new Uint8Array();
    },
    async sync() {},
    async serve(connection) {
      try {
        while ((await readWasixByteChannel(connection.frontend)).length !== 0) {
          // The lifecycle test needs only EOF/failure classification.
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async close() {},
  });
}

function fakeToolHost(
  run: (
    read: (maximumBytes: number) => Uint8Array,
    write: (chunk: Uint8Array) => void,
  ) =>
    | never
    | Readonly<{
        code: number;
        stdoutBytes: Uint8Array;
        stderrBytes: Uint8Array;
      }>,
  DirectoryConstructor: typeof FakeToolDirectory = FakeToolDirectory,
): WasixToolHost {
  return {
    Directory: DirectoryConstructor as unknown as WasixToolHost['Directory'],
    async init() {},
    prepareOliphauntTool() {
      return { free() {} } as ReturnType<WasixToolHost['prepareOliphauntTool']>;
    },
    async runOliphauntToolDirect(_prepared, _options, read, write) {
      return run(read, write);
    },
  };
}

class FakeToolDirectory {
  constructor(_files: Record<string, Uint8Array> = {}) {}

  async createDir(): Promise<void> {}

  free(): void {}
}

class CleanupFailingToolDirectory extends FakeToolDirectory {
  override free(): void {
    throw new Error('private mount cleanup failed');
  }
}

class FakeToolWorkerPort implements WasixToolWorkerPort {
  readonly requests: WasixToolWorkerRequest[] = [];
  messageListenerRegistrations = 0;
  fatalListenerRegistrations = 0;
  terminateCount = 0;
  termination: Promise<void> | undefined;
  #messageListener: ((response: WasixToolWorkerResponse) => void) | undefined;
  #fatalListener: ((error: Error) => void) | undefined;
  #requestWaiters: Array<() => void> = [];

  postMessage(request: WasixToolWorkerRequest): void {
    this.requests.push(request);
    for (const wake of this.#requestWaiters.splice(0)) wake();
  }

  onMessage(listener: (response: WasixToolWorkerResponse) => void): void {
    this.messageListenerRegistrations += 1;
    this.#messageListener = listener;
  }

  onFatal(listener: (error: Error) => void): void {
    this.fatalListenerRegistrations += 1;
    this.#fatalListener = listener;
  }

  terminate(): void | Promise<void> {
    this.terminateCount += 1;
    return this.termination;
  }

  async request(index: number): Promise<WasixToolWorkerRequest> {
    while (this.requests[index] === undefined) {
      await new Promise<void>((resolve) => this.#requestWaiters.push(resolve));
    }
    return this.requests[index];
  }

  respond(response: WasixToolWorkerResponse): void {
    this.#messageListener?.(response);
  }

  complete(id: number, stdout: string): void {
    this.respond({
      id,
      ok: true,
      kind: 'completed',
      exitCode: 0,
      stdout: new TextEncoder().encode(stdout),
      stderr: new Uint8Array(),
    });
  }

  crash(error: Error): void {
    this.#fatalListener?.(error);
  }
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}
