import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  failWasixByteChannel,
  readWasixByteChannel,
  type WasixByteChannel,
  WASIX_BYTE_CHANNEL_ALLOCATION_BYTES,
  wasixByteChannelProtocolOutcomeUnknown,
  wasixByteChannelProtocolStarted,
} from '../../protocol/byte-channel.js';
import {
  assertWasixProtocolConnectionTarget,
  admitWasixToolProcess,
  registerWasixDatabaseResource,
  reserveWasixProtocolConnection,
  runWasixPgDumpProcess,
  type WasixProtocolConnectionReservation,
  WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES,
  createWasixDeferred,
} from '../../core/database.js';
import type { OliphauntDatabase } from '../../core/types.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';
import {
  type WasixToolDescriptor,
  type WasixToolProcessInput,
  type WasixToolProcessOptions,
  type WasixToolProcessResult,
  validateWasixToolDescriptor,
} from '../../resources/tool-runtime.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from '../../resources/tool-runtime.js';

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
  output?: NonNullable<Extract<WasixToolWorkerRequest, { kind: 'run' }>['output']>;
  outputStopped: AbortController;
  outputDraining?: Promise<void>;
  completed: ReturnType<typeof createWasixDeferred<void>>;
};

type ToolWorkerRequestWithoutId = WasixToolWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

const controllers = new WeakMap<OliphauntDatabase, WasixToolController>();

/** @internal Shared browser/server tool orchestration; public API lives in the optional package. */
export function runWasixToolProcess(
  database: OliphauntDatabase,
  input: WasixToolProcessInput,
  createWorker: () => WasixToolWorkerPort,
): Promise<WasixToolProcessResult> {
  return admitWasixToolProcess(database, input, (options, retain) =>
    runAdmittedTool(database, options, createWorker, retain),
  );
}

function runAdmittedTool(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
  createWorker: () => WasixToolWorkerPort,
  retain: (bytes: number) => void,
): Promise<WasixToolProcessResult> {
  if (options.outputFile !== undefined) {
    throw new Error('WASIX tool file destinations require Node.js, Bun, Deno, or Electron');
  }
  if (options.runtimeVersion !== defaultWasixRuntime.version) {
    throw new Error(
      `WASIX tools runtime ${options.runtimeVersion} is incompatible with database runtime ${defaultWasixRuntime.version}`,
    );
  }
  validateWasixToolDescriptor(options.tool);
  if (options.tool.name === 'pg_dump' && options.output === undefined) {
    return runWasixPgDumpProcess(database, options);
  }
  try {
    assertWasixProtocolConnectionTarget(database);
  } catch (error) {
    if (options.output === undefined) throw error;
    throw new Error('browser async WASIX tool destinations require @oliphaunt/wasix-ts/worker', {
      cause: error,
    });
  }
  let controller = controllers.get(database);
  if (controller === undefined) {
    controller = new WasixToolController(database, createWorker);
    registerWasixDatabaseResource(database, controller);
    controllers.set(database, controller);
  }
  return controller.run(options, retain);
}

class WasixToolController {
  readonly #database: OliphauntDatabase;
  readonly #createWorker: () => WasixToolWorkerPort;
  readonly #pending = new Map<number, PendingResponse>();
  readonly #preparedIdentities = new Map<'pg_dump' | 'psql', string>();
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

  run(
    options: WasixToolProcessOptions,
    retain: (bytes: number) => void,
  ): Promise<WasixToolProcessResult> {
    if (this.#closing) {
      return Promise.reject(new Error('Oliphaunt WASIX tool worker is closing'));
    }
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    let connection: ToolConnectionReservation;
    try {
      // Reserve the database FIFO during the public call. Preparing a cold
      // tool must not let a later query or tool overtake this invocation.
      connection = this.#reserveConnection(retain, options);
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
    this.#preparedIdentities.clear();
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
    let startupFailure: Error | undefined;
    const startupTimer =
      options.startupTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (wasixByteChannelProtocolStarted(frontend)) return;
            startupFailure = new Error(
              'WASIX tool startup deadline exceeded before protocol activity',
            );
            this.#handleFatal(startupFailure);
          }, options.startupTimeoutMs);
    try {
      if (this.#closing) throw this.#fatal;
      if (this.#fatal !== undefined) throw this.#fatal;
      if (connection.failure !== undefined) throw connection.failure;
      await this.#prepare(options.tool);
      if (this.#closing) throw this.#fatal;
      if (this.#fatal !== undefined) throw this.#fatal;
      if (connection.failure !== undefined) throw connection.failure;
      const databaseServing = connection.database.start();
      connection.started = true;
      const serving = databaseServing.then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          connection.failure ??= asError(error);
          finishFailedToolChannels(connection);
          return { ok: false as const, error };
        },
      );
      connection.serving = serving;
      if (connection.output !== undefined) {
        const output = options.output!;
        connection.outputDraining = Promise.all([
          drainToolOutput(connection.output.stdout, output.stdout, connection.outputStopped.signal),
          ...(connection.output.stderr === undefined
            ? []
            : [
                drainToolOutput(
                  connection.output.stderr,
                  output.stderr!,
                  connection.outputStopped.signal,
                ),
              ]),
        ]).then(() => undefined);
        void connection.outputDraining.catch(() => undefined);
      }

      const stdin =
        options.script === undefined ? options.stdin : new TextEncoder().encode(options.script);
      let response: WasixToolWorkerResponse | undefined;
      let responseFailure: unknown;
      try {
        response = await this.#request(
          {
            kind: 'run',
            tool: options.tool.name,
            args: [...options.args],
            stdin,
            frontend,
            backend,
            output: connection.output,
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
      await connection.outputDraining;
      connection.completed.resolve();
      const served = await serving;
      if (!served.ok) throw served.error;
      if (response === undefined || !response.ok || response.kind !== 'completed') {
        throw new Error('Oliphaunt WASIX tool worker did not return a result');
      }
      return {
        exitCode: response.exitCode,
        stdout: response.stdout,
        stderr: response.stderr,
        ...(connection.output === undefined
          ? {}
          : { stdoutBytes: response.stdoutBytes, stderrTruncated: response.stderrTruncated }),
      };
    } finally {
      clearTimeout(startupTimer);
      connection.completed.resolve();
      connection.outputStopped.abort();
      if (connection.output !== undefined) {
        failWasixByteChannel(connection.output.stdout);
        if (connection.output.stderr !== undefined) failWasixByteChannel(connection.output.stderr);
      }
      await connection.outputDraining?.catch(() => undefined);
      closeWasixByteChannel(frontend);
      if (!connection.started) connection.database.cancel();
      if (connection.serving !== undefined && !this.#closing) await connection.serving;
      closeWasixByteChannel(backend);
      this.#connections.delete(connection);
      if (startupFailure !== undefined) {
        await Promise.all(this.#retiredWorkerTerminations).catch((error: unknown) => {
          throw new AggregateError(
            [startupFailure, error],
            'WASIX tool startup and termination both failed',
          );
        });
      }
    }
  }

  #reserveConnection(
    retain: (bytes: number) => void,
    options: WasixToolProcessOptions,
  ): ToolConnectionReservation {
    retain(
      (2 + (options.output === undefined ? 0 : options.output.stderr === undefined ? 1 : 2)) *
        WASIX_BYTE_CHANNEL_ALLOCATION_BYTES,
    );
    const frontend = createWasixByteChannel();
    const backend = createWasixByteChannel();
    try {
      const output =
        options.output === undefined
          ? undefined
          : {
              stdout: createWasixByteChannel(),
              ...(options.output.stderr === undefined ? {} : { stderr: createWasixByteChannel() }),
            };
      const completed = createWasixDeferred<void>();
      const database = reserveWasixProtocolConnection(
        this.#database,
        { frontend, backend },
        'tool',
        options.output === undefined ? undefined : completed.promise,
      );
      const connection: ToolConnectionReservation = {
        frontend,
        backend,
        database,
        started: false,
        outputStopped: new AbortController(),
        completed,
        output,
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

  async #prepare(tool: WasixToolDescriptor): Promise<void> {
    const identity = `${tool.sha256}:${tool.size}`;
    if (this.#preparedIdentities.get(tool.name) === identity) return;
    const response = await this.#request({
      kind: 'prepare',
      tool,
    });
    if (!response.ok) throw new Error(response.message);
    if (response.kind !== 'prepared') {
      throw new Error('Oliphaunt WASIX tool worker returned an invalid preparation response');
    }
    this.#preparedIdentities.set(tool.name, identity);
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
    this.#preparedIdentities.clear();
    if (protocolOutcomeUnknown || this.#closing) this.#fatal = error;
  }
}

function finishFailedToolChannels(connection: ToolConnectionReservation): void {
  connection.outputStopped.abort();
  if (connection.output !== undefined) {
    failWasixByteChannel(connection.output.stdout);
    if (connection.output.stderr !== undefined) failWasixByteChannel(connection.output.stderr);
  }
  if (wasixByteChannelProtocolOutcomeUnknown(connection.frontend)) {
    failWasixByteChannel(connection.frontend);
    failWasixByteChannel(connection.backend);
  }
  closeWasixByteChannel(connection.frontend);
}

async function drainToolOutput(
  channel: WasixByteChannel,
  write: (chunk: Uint8Array) => Promise<void>,
  stopped: AbortSignal,
): Promise<void> {
  let failed = false;
  for (;;) {
    const chunk = await readWasixByteChannel(
      channel,
      WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES,
      async (chunk) => {
        if (failed) return;
        if (stopped.aborted) {
          failed = true;
          return;
        }
        failed = !(await new Promise<boolean>((resolve) => {
          const abort = () => resolve(false);
          stopped.addEventListener('abort', abort, { once: true });
          void Promise.resolve()
            .then(() => write(chunk))
            .then(
              () => {
                stopped.removeEventListener('abort', abort);
                resolve(true);
              },
              () => {
                stopped.removeEventListener('abort', abort);
                resolve(false);
              },
            );
        }));
      },
    );
    if (chunk.length === 0) return;
  }
}

function terminateWorker(worker: WasixToolWorkerPort): Promise<void> {
  return Promise.resolve()
    .then(() => worker.terminate())
    .then(() => undefined);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
