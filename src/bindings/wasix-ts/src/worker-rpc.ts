import {
  WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES,
  WasixDatabaseImpl,
  createWasixDeferred,
  normalizeWasixDatabaseIdentity,
  type WasixDatabaseIdentity,
  type WasixDatabaseSession,
  type WasixDatabaseSessionTerminalState,
  type WasixPersistenceMode,
  type WasixProtocolConnectionMode,
  type WasixProtocolStreamOutcome,
} from './database.js';
import { serializeOpenConfig } from './client-common.js';
import { toUint8Array } from './query.js';
import type {
  SerializedAssetSource,
  SerializedOpenOptions,
  WorkerRequest,
  WorkerResponse,
} from './rpc.js';
import { deserializeWorkerError } from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { BinaryInput, OliphauntDatabase, OpenConfig } from './types.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type {
  WasixPgDumpProcessOptions,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './tool-runtime.js';

type WorkerResponseValue =
  | Uint8Array
  | WasixToolProcessResult
  | WasixProtocolStreamOutcome
  | undefined;

const STREAM_ACK = 0;
const STREAM_FAILED = 1;

type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export type WasixWorkerPort = {
  /** Shared memory is available only for a same-process Worker transport. */
  readonly supportsSharedMemory?: boolean;
  postMessage(message: WorkerRequest, transfer: readonly Transferable[]): void;
  /** Mark and await a Worker-initiated exit after its quiescent close reply. */
  expectSelfExit?(): Promise<void>;
  terminate(): void | Promise<void>;
  onMessage(listener: (message: WorkerResponse) => void): void;
  onFatal(listener: (error: Error) => void): void;
};

/** @internal Open through a package-owned isolated host without burdening the direct graph. */
export async function openWasixWithWorker(
  createWorker: (options: SerializedOpenOptions) => WasixWorkerPort,
  openOptions: SerializedOpenOptions,
  validate?: (options: SerializedOpenOptions) => void,
  transferAssets = true,
): Promise<OliphauntDatabase> {
  validate?.(openOptions);
  return openWorkerDatabase(
    createWorker(openOptions),
    openOptions,
    transferAssets ? assetTransfers(openOptions) : [],
  );
}

/** @internal Restore through a temporary package-owned isolated host. */
export async function restoreWasixWithWorker(
  createWorker: (options: SerializedOpenOptions) => WasixWorkerPort,
  storage: OpenConfig['storage'],
  bytes: BinaryInput,
  validate?: (options: SerializedOpenOptions) => void,
): Promise<void> {
  if (storage === undefined) throw new TypeError('WASIX restore requires persistent storage');
  const openOptions = serializeOpenConfig({ storage });
  validate?.(openOptions);
  const input = toUint8Array(bytes).slice();
  const rpc = new WorkerRpc(createWorker(openOptions));
  try {
    await rpc.request({ method: 'restore', storage: openOptions.storage, bytes: input }, [
      input.buffer,
    ]);
  } catch (error) {
    return rethrowAfterWorkerTermination(
      rpc,
      error,
      'Oliphaunt WASIX worker restore and termination both failed',
    );
  }
  await rpc.terminate();
}

/** @internal Correlates worker requests and fails them as one unit if the worker exits. */
export class WorkerRpc {
  readonly terminalState: WasixDatabaseSessionTerminalState;
  readonly #worker: WasixWorkerPort;
  readonly #terminalState = new WorkerTerminalState();
  readonly #pending = new Map<
    number,
    {
      resolve: (value: WorkerResponseValue) => void;
      reject: (error: unknown) => void;
      onChunk?: (chunk: Uint8Array) => void;
      control?: Int32Array;
      stream?: true;
    }
  >();
  #nextId = 1;
  #fatal: Error | undefined;
  #terminationRequested = false;
  #termination: Promise<void> | undefined;

  constructor(worker: WasixWorkerPort) {
    this.#worker = worker;
    this.terminalState = this.#terminalState;
    worker.onMessage((message) => {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      if ('kind' in message) {
        if (pending.control === undefined || Atomics.load(pending.control, STREAM_FAILED) === 0) {
          try {
            pending.onChunk?.(message.value);
          } catch {
            if (pending.control !== undefined) {
              Atomics.store(pending.control, STREAM_FAILED, 1);
            }
          }
        }
        if (pending.control !== undefined) {
          Atomics.store(pending.control, STREAM_ACK, message.sequence);
          Atomics.notify(pending.control, STREAM_ACK);
        }
        return;
      }
      this.#pending.delete(message.id);
      if (message.ok) {
        if (pending.stream) {
          if (!('streamOutcome' in message)) {
            pending.reject(new Error('Oliphaunt WASIX worker omitted its protocol stream outcome'));
            return;
          }
          pending.resolve(message.streamOutcome);
        } else if ('streamOutcome' in message) {
          pending.reject(
            new Error('Oliphaunt WASIX worker returned a stream outcome for a non-stream request'),
          );
        } else {
          pending.resolve(message.value);
        }
      } else {
        pending.reject(deserializeWorkerError(message.error));
      }
    });
    worker.onFatal((error) => this.#fail(error));
  }

  get supportsSharedMemory(): boolean {
    return this.#worker.supportsSharedMemory !== false;
  }

  request(
    request: WorkerRequestWithoutId,
    transfer: Transferable[] = [],
  ): Promise<WorkerResponseValue> {
    if (this.#fatal !== undefined) {
      return Promise.reject(this.#fatal);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ ...request, id } satisfies WorkerRequest, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stream(
    input: Uint8Array,
    persistence: WasixPersistenceMode,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<WasixProtocolStreamOutcome> {
    if (this.#fatal !== undefined) {
      return Promise.reject(this.#fatal);
    }
    const id = this.#nextId++;
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => {
          if (value === 'complete' || value === 'callbackAborted') {
            resolve(value);
          } else {
            reject(new Error('Oliphaunt WASIX worker returned an invalid protocol stream outcome'));
          }
        },
        reject,
        onChunk,
        control,
        stream: true,
      });
      const request: WorkerRequest = {
        id,
        method: 'execStream',
        input,
        persistence,
        control: control.buffer as SharedArrayBuffer,
      };
      try {
        this.#worker.postMessage(request, [input.buffer]);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): Promise<void> {
    this.#stop(this.#fatal ?? new Error('Oliphaunt WASIX worker was terminated'));
    return this.#termination ?? Promise.resolve();
  }

  expectSelfExit(): Promise<void> | undefined {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    try {
      return this.#worker.expectSelfExit?.();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    // A package-requested terminate is expected ownership teardown, not an
    // independently observed crash. The public close state remains governed
    // by its memoized close attempt in that case.
    if (!this.#terminationRequested) {
      this.#terminalState.fail(error);
    }
    this.#stop(error);
  }

  #stop(error: Error): void {
    if (this.#fatal === undefined) {
      this.#fatal = error;
      this.#rejectAll(error);
    }
    if (this.#termination !== undefined) {
      return;
    }
    this.#terminationRequested = true;
    try {
      this.#termination = Promise.resolve(this.#worker.terminate());
    } catch (terminationError) {
      this.#termination = Promise.reject(
        terminationError instanceof Error ? terminationError : new Error(String(terminationError)),
      );
    }
    // Fatal-event cleanup has no awaiting caller. Keep the original promise
    // available to close/open while preventing an unhandled rejection.
    void this.#termination.catch(() => undefined);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/** @internal Opens exactly one database and guarantees worker cleanup on failure. */
export async function openWorkerDatabase(
  worker: WasixWorkerPort,
  options: SerializedOpenOptions,
  transfer: Transferable[] = [],
): Promise<OliphauntDatabase> {
  const rpc = new WorkerRpc(worker);
  try {
    await rpc.request({ method: 'open', options }, transfer);
    return new WasixDatabaseImpl(new WorkerDatabaseSession(rpc, options));
  } catch (error) {
    return rethrowAfterWorkerTermination(
      rpc,
      error,
      'Oliphaunt WASIX worker open and termination both failed',
    );
  }
}

async function rethrowAfterWorkerTermination(
  rpc: WorkerRpc,
  primaryFailure: unknown,
  aggregateMessage: string,
): Promise<never> {
  try {
    await rpc.terminate();
  } catch (terminationFailure) {
    throw new AggregateError([primaryFailure, terminationFailure], aggregateMessage);
  }
  throw primaryFailure;
}

function assetTransfers(options: SerializedOpenOptions): Transferable[] {
  const transfer: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  appendAssetTransfer(options.runtime.runtimeArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.manifest.source, transfer, seen);
  if (options.icu !== undefined) {
    appendAssetTransfer(options.icu.dataArchive.source, transfer, seen);
    appendAssetTransfer(options.icu.clusterSeedArchive.source, transfer, seen);
    appendAssetTransfer(options.icu.clusterSeedManifest.source, transfer, seen);
  } else {
    appendAssetTransfer(options.runtime.standardSeedArchive.source, transfer, seen);
    appendAssetTransfer(options.runtime.standardSeedManifest.source, transfer, seen);
  }
  for (const carrier of Object.values(options.extensionCarriers)) {
    appendAssetTransfer(carrier.source, transfer, seen);
  }
  return transfer;
}

function appendAssetTransfer(
  source: SerializedAssetSource | undefined,
  transfer: Transferable[],
  seen: Set<ArrayBuffer>,
): void {
  if (!(source instanceof Uint8Array) || !(source.buffer instanceof ArrayBuffer)) {
    return;
  }
  if (!seen.has(source.buffer)) {
    seen.add(source.buffer);
    transfer.push(source.buffer);
  }
}

class WorkerDatabaseSession implements WasixDatabaseSession {
  readonly supportsProtocolConnections: boolean;
  readonly identity: WasixDatabaseIdentity;
  readonly terminalState: WasixDatabaseSessionTerminalState;
  readonly #rpc: WorkerRpc;
  #closed = false;
  #closeAttempt: Promise<void> | undefined;

  constructor(rpc: WorkerRpc, options: SerializedOpenOptions) {
    this.#rpc = rpc;
    this.supportsProtocolConnections = rpc.supportsSharedMemory;
    this.terminalState = rpc.terminalState;
    this.identity = normalizeWasixDatabaseIdentity(options.username, options.database);
  }

  async exec(input: Uint8Array, persistence: WasixPersistenceMode = 'sync'): Promise<Uint8Array> {
    this.#assertOpen();
    const response = await this.#rpc.request({ method: 'exec', input, persistence }, [
      input.buffer,
    ]);
    if (!(response instanceof Uint8Array)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid protocol response');
    }
    return response;
  }

  execStream(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    persistence: WasixPersistenceMode = 'sync',
  ): Promise<WasixProtocolStreamOutcome> {
    this.#assertOpen();
    if (!this.#rpc.supportsSharedMemory) {
      return this.#execBufferedStream(input, onChunk, persistence);
    }
    return this.#rpc.stream(input, persistence, onChunk);
  }

  async #execBufferedStream(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    persistence: WasixPersistenceMode,
  ): Promise<WasixProtocolStreamOutcome> {
    const response = await this.exec(input, persistence);
    try {
      for (
        let offset = 0;
        offset < response.length;
        offset += WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES
      ) {
        onChunk(response.slice(offset, offset + WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES));
      }
      return 'complete';
    } catch {
      // The complete response is already owned by the parent, so stopping
      // callback delivery cannot leave the database protocol state unknown.
      return 'callbackAborted';
    }
  }

  async sync(boundary: WasixStorageSyncBoundary): Promise<void> {
    this.#assertOpen();
    await this.#rpc.request({ method: 'sync', boundary });
  }

  async backup(): Promise<Uint8Array> {
    this.#assertOpen();
    const response = await this.#rpc.request({ method: 'backup' });
    if (!(response instanceof Uint8Array)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid physical archive');
    }
    return response;
  }

  async runPgDump(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertOpen();
    const response = await this.#rpc.request({
      method: 'runPgDump',
      tool: options.tool,
      args: [...options.args],
    });
    if (!isWasixToolProcessResult(response)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid pg_dump result');
    }
    return response;
  }

  async runTool(options: WasixToolProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertOpen();
    const stdin = options.stdin;
    const transferableStdin =
      stdin !== undefined &&
      stdin.buffer instanceof ArrayBuffer &&
      stdin.byteOffset === 0 &&
      stdin.byteLength === stdin.buffer.byteLength;
    const response = await this.#rpc.request(
      {
        method: 'runTool',
        options: {
          ...options,
          // The release addon owns the verified tool payload. Preserve only
          // the descriptor identity across the Worker boundary.
          tool: { ...options.tool, source: 'oliphaunt:wasix-napi-embedded' },
          args: [...options.args],
          ...(stdin === undefined ? {} : { stdin }),
        },
      },
      transferableStdin && stdin !== undefined ? [stdin.buffer as ArrayBuffer] : [],
    );
    if (!isWasixToolProcessResult(response)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid native tool result');
    }
    return response;
  }

  async serve(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): Promise<void> {
    this.#assertOpen();
    if (!this.#rpc.supportsSharedMemory) {
      throw new Error(
        'Oliphaunt WASIX worker execution does not support shared-memory protocol connections',
      );
    }
    await this.#rpc.request({ method: 'serve', connection, mode });
  }

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    this.#closed = true;
    const attempt = createWasixDeferred<void>();
    this.#closeAttempt = attempt.promise;
    void this.#closeOrderly().then(attempt.resolve, attempt.reject);
    return attempt.promise;
  }

  async #closeOrderly(): Promise<void> {
    const selfExit = this.#rpc.expectSelfExit();
    // An early Worker failure can reject this before the close reply rejects.
    // Observe it immediately, then preserve the same rejection for the ordered
    // aggregation below.
    void selfExit?.catch(() => undefined);
    let requestFailed = false;
    let requestFailure: unknown;
    try {
      await this.#rpc.request({ method: 'close' });
    } catch (error) {
      requestFailed = true;
      requestFailure = error;
    }
    let terminationFailed = false;
    let terminationFailure: unknown;
    try {
      if (selfExit !== undefined) {
        // A Node-compatible Worker acknowledges close only by exiting itself
        // after the dispatcher has unwound and released its direct native
        // handle. Wait for that full quiescence even when native close reports
        // an error; the error response alone is not permission to terminate a
        // Worker which may still be finishing Node-API cleanup. The observed
        // exit is the completed host teardown contract; Bun does not settle a
        // redundant terminate() after that event.
        await selfExit;
      } else {
        // Browser Workers retain their existing post-close termination path.
        await this.#rpc.terminate();
      }
    } catch (error) {
      terminationFailed = true;
      terminationFailure = error;
    }
    if (requestFailed && terminationFailed) {
      if (requestFailure === terminationFailure) {
        throw requestFailure;
      }
      throw new AggregateError(
        [requestFailure, terminationFailure],
        'Oliphaunt WASIX worker close and termination both failed',
      );
    }
    if (requestFailed) {
      throw requestFailure;
    }
    if (terminationFailed) {
      throw terminationFailure;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX worker session is closed');
    }
  }
}

class WorkerTerminalState implements WasixDatabaseSessionTerminalState {
  #failure: Error | undefined;

  get terminal(): boolean {
    return this.#failure !== undefined;
  }

  get failure(): Error | undefined {
    return this.#failure;
  }

  fail(error: Error): void {
    this.#failure ??= error;
  }
}

function isWasixToolProcessResult(value: WorkerResponseValue): value is WasixToolProcessResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    Number.isSafeInteger(value.exitCode) &&
    value.stdout instanceof Uint8Array &&
    value.stderr instanceof Uint8Array
  );
}
