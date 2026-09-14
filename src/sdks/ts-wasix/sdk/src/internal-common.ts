import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
  type WasixByteChannel,
  wasixByteChannelProtocolOutcomeUnknown,
} from './byte-channel.js';
import {
  assertWasixProtocolConnectionTarget,
  registerWasixDatabaseResource,
  reserveWasixProtocolConnection,
  runWasixPgDumpProcess,
  type WasixProtocolConnectionReservation,
} from './database.js';
import type { OliphauntDatabase } from './types.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';
import {
  type WasixToolDescriptor,
  type WasixToolProcessOptions,
  type WasixToolProcessResult,
  validateWasixToolDescriptor,
} from './tool-runtime.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './tool-runtime.js';

export type WasixToolWorkerPort = Readonly<{
  postMessage(request: WasixToolWorkerRequest, transfer?: ArrayBuffer[]): void;
  terminate(): void | Promise<void>;
  onMessage(listener: (response: WasixToolWorkerResponse) => void): void;
  onFatal(listener: (error: Error) => void): void;
}>;

type PendingResponse = Readonly<{
  resolve(response: WasixToolWorkerResponse): void;
  reject(error: Error): void;
}>;

type ToolConnectionReservation = {
  readonly frontend: WasixByteChannel;
  readonly backend: WasixByteChannel;
  readonly database: WasixProtocolConnectionReservation;
  serving?: Promise<{ ok: true } | { ok: false; error: unknown }>;
  started: boolean;
  failure?: Error;
};

type ToolWorkerRequestWithoutId = WasixToolWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

const controllers = new WeakMap<OliphauntDatabase, WasixToolController>();
type PsqlToolDescriptor = WasixToolDescriptor & Readonly<{ name: 'psql' }>;

/** @internal Shared browser/server tool orchestration; public API lives in the optional package. */
export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
  createWorker: () => WasixToolWorkerPort,
): Promise<WasixToolProcessResult> {
  if (options.runtimeVersion !== defaultWasixRuntime.version) {
    throw new Error(
      `WASIX tools runtime ${options.runtimeVersion} is incompatible with database runtime ${defaultWasixRuntime.version}`,
    );
  }
  validateWasixToolDescriptor(options.tool);
  if (options.tool.name === 'pg_dump') {
    return runWasixPgDumpProcess(database, options);
  }
  assertWasixProtocolConnectionTarget(database);
  let controller = controllers.get(database);
  if (controller === undefined) {
    controller = new WasixToolController(database, createWorker);
    registerWasixDatabaseResource(database, controller);
    controllers.set(database, controller);
  }
  return controller.run(options);
}

class WasixToolController {
  readonly #database: OliphauntDatabase;
  readonly #createWorker: () => WasixToolWorkerPort;
  readonly #pending = new Map<number, PendingResponse>();
  #preparedPsqlIdentity: string | undefined;
  readonly #retiredWorkerTerminations = new Set<Promise<void>>();
  readonly #connections = new Set<ToolConnectionReservation>();
  #worker: WasixToolWorkerPort | undefined;
  #nextId = 1;
  #tail = Promise.resolve();
  #closing = false;
  #fatal: Error | undefined;
  #termination: Promise<void> | undefined;

  constructor(database: OliphauntDatabase, createWorker: () => WasixToolWorkerPort) {
    this.#database = database;
    this.#createWorker = createWorker;
  }

  run(options: WasixToolProcessOptions): Promise<WasixToolProcessResult> {
    if (this.#closing) {
      return Promise.reject(new Error('Oliphaunt WASIX tool worker is closing'));
    }
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    if (options.tool.name !== 'psql') {
      return Promise.reject(new TypeError('the bounded tool worker supports only psql'));
    }
    let connection: ToolConnectionReservation;
    try {
      // Reserve the database FIFO during the public call. Preparing a cold
      // tool must not let a later query or tool overtake this invocation.
      connection = this.#reserveConnection();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#tail.then(() => this.#runOne(options, connection));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(): Promise<void> {
    if (this.#termination !== undefined) return this.#termination;
    this.#closing = true;
    const error = this.#fatal ?? new Error('Oliphaunt WASIX tool worker is closing');
    this.#fatal = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#failConnections(error);
    const worker = this.#worker;
    this.#worker = undefined;
    this.#preparedPsqlIdentity = undefined;
    const terminations = [...this.#retiredWorkerTerminations];
    if (worker !== undefined) terminations.push(terminateWorker(worker));
    this.#termination = Promise.all(terminations).then(() => undefined);
    return this.#termination;
  }

  async #runOne(
    options: WasixToolProcessOptions,
    connection: ToolConnectionReservation,
  ): Promise<WasixToolProcessResult> {
    const { frontend, backend } = connection;
    try {
      if (this.#closing) throw this.#fatal;
      if (this.#fatal !== undefined) throw this.#fatal;
      if (connection.failure !== undefined) throw connection.failure;
      await this.#prepare(options.tool as PsqlToolDescriptor);
      if (this.#closing) throw this.#fatal;
      if (this.#fatal !== undefined) throw this.#fatal;
      if (connection.failure !== undefined) throw connection.failure;
      const databaseServing = connection.database.start();
      connection.started = true;
      const serving = databaseServing.then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          connection.failure ??= asError(error);
          failWasixByteChannel(frontend);
          failWasixByteChannel(backend);
          return { ok: false as const, error };
        },
      );
      connection.serving = serving;

      const stdin = options.stdin;
      let response: WasixToolWorkerResponse | undefined;
      let responseFailure: unknown;
      try {
        response = await this.#request(
          {
            kind: 'run',
            tool: 'psql',
            args: [...options.args],
            stdin,
            frontend,
            backend,
          },
          stdin === undefined ||
            !(stdin.buffer instanceof ArrayBuffer) ||
            stdin.byteOffset !== 0 ||
            stdin.byteLength !== stdin.buffer.byteLength
            ? []
            : [stdin.buffer],
        );
        if (!response.ok) throw new Error(response.message);
        if (response.kind !== 'completed') {
          throw new Error('Oliphaunt WASIX tool worker returned an invalid completion response');
        }
        closeWasixByteChannel(frontend);
      } catch (error) {
        responseFailure = error;
        finishFailedToolChannels(connection);
      }

      if (responseFailure !== undefined) throw responseFailure;
      const served = await serving;
      if (!served.ok) throw served.error;
      if (response === undefined || !response.ok || response.kind !== 'completed') {
        throw new Error('Oliphaunt WASIX tool worker did not return a result');
      }
      return {
        exitCode: response.exitCode,
        stdout: response.stdout,
        stderr: response.stderr,
      };
    } finally {
      closeWasixByteChannel(frontend);
      if (!connection.started) connection.database.cancel();
      if (connection.serving !== undefined && !this.#closing) await connection.serving;
      closeWasixByteChannel(backend);
      this.#connections.delete(connection);
    }
  }

  #reserveConnection(): ToolConnectionReservation {
    const frontend = createWasixByteChannel();
    const backend = createWasixByteChannel();
    try {
      const database = reserveWasixProtocolConnection(
        this.#database,
        { frontend, backend },
        'tool',
      );
      const connection: ToolConnectionReservation = {
        frontend,
        backend,
        database,
        started: false,
      };
      this.#connections.add(connection);
      return connection;
    } catch (error) {
      failWasixByteChannel(frontend);
      failWasixByteChannel(backend);
      throw error;
    }
  }

  #failConnections(error: Error): void {
    for (const connection of this.#connections) {
      connection.failure ??= error;
      if (!connection.started) connection.database.cancel();
      finishFailedToolChannels(connection);
    }
  }

  async #prepare(tool: PsqlToolDescriptor): Promise<void> {
    const identity = `${tool.sha256}:${tool.size}`;
    if (this.#preparedPsqlIdentity === identity) return;
    const response = await this.#request({
      kind: 'prepare',
      tool,
    });
    if (!response.ok) throw new Error(response.message);
    if (response.kind !== 'prepared') {
      throw new Error('Oliphaunt WASIX tool worker returned an invalid preparation response');
    }
    this.#preparedPsqlIdentity = identity;
  }

  #request(
    request: ToolWorkerRequestWithoutId,
    transfer: ArrayBuffer[] = [],
  ): Promise<WasixToolWorkerResponse> {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...request, id } as WasixToolWorkerRequest, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(asError(error));
      }
    });
  }

  #ensureWorker(): WasixToolWorkerPort {
    if (this.#worker !== undefined) return this.#worker;
    const worker = this.#createWorker();
    this.#worker = worker;
    worker.onMessage((response) => {
      if (this.#worker !== worker) return;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      pending.resolve(response);
    });
    worker.onFatal((error) => {
      if (this.#worker !== worker) return;
      this.#handleFatal(error);
    });
    return worker;
  }

  #handleFatal(error: Error): void {
    const protocolOutcomeUnknown = [...this.#connections].some((connection) =>
      wasixByteChannelProtocolOutcomeUnknown(connection.frontend),
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#failConnections(error);
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) {
      const termination = terminateWorker(worker);
      // The worker fatal path has no awaiting caller, but database.close()
      // must still observe a failed termination instead of reporting a clean
      // shutdown while the retired worker may remain alive.
      void termination.catch(() => undefined);
      this.#retiredWorkerTerminations.add(termination);
    }
    this.#preparedPsqlIdentity = undefined;
    if (protocolOutcomeUnknown || this.#closing) this.#fatal = error;
  }
}

function finishFailedToolChannels(connection: ToolConnectionReservation): void {
  if (wasixByteChannelProtocolOutcomeUnknown(connection.frontend)) {
    failWasixByteChannel(connection.frontend);
    failWasixByteChannel(connection.backend);
  }
  closeWasixByteChannel(connection.frontend);
}

function terminateWorker(worker: WasixToolWorkerPort): Promise<void> {
  return Promise.resolve()
    .then(() => worker.terminate())
    .then(() => undefined);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
