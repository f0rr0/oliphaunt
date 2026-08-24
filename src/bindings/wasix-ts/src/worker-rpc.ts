import {
  WasixDatabaseImpl,
  normalizeWasixDatabaseIdentity,
  type WasixDatabaseIdentity,
  type WasixDatabaseSession,
  type WasixPersistenceMode,
  type WasixProtocolConnectionMode,
} from './database.js';
import type { SerializedOpenOptions, WorkerRequest, WorkerResponse } from './rpc.js';
import { deserializeWorkerError } from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { OliphauntDatabase } from './types.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type { WasixPgDumpProcessOptions, WasixToolProcessResult } from './tool-runtime.js';

type WorkerResponseValue = Uint8Array | WasixToolProcessResult | undefined;

const STREAM_ACK = 0;
const STREAM_FAILED = 1;

type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export type WasixWorkerPort = {
  postMessage(message: WorkerRequest, transfer: readonly Transferable[]): void;
  terminate(): void | Promise<void>;
  onMessage(listener: (message: WorkerResponse) => void): void;
  onFatal(listener: (error: Error) => void): void;
};

/** @internal Correlates worker requests and fails them as one unit if the worker exits. */
export class WorkerRpc {
  readonly #worker: WasixWorkerPort;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: WorkerResponseValue) => void;
      reject: (error: Error) => void;
      onChunk?: (chunk: Uint8Array) => void;
      control?: Int32Array;
      callbackFailure?: Error;
    }
  >();
  #nextId = 1;
  #fatal: Error | undefined;
  #termination: Promise<void> | undefined;

  constructor(worker: WasixWorkerPort) {
    this.#worker = worker;
    worker.onMessage((message) => {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      if ('kind' in message) {
        try {
          pending.onChunk?.(message.value);
        } catch (error) {
          pending.callbackFailure = error instanceof Error ? error : new Error(String(error));
          if (pending.control !== undefined) {
            Atomics.store(pending.control, STREAM_FAILED, 1);
          }
        } finally {
          if (pending.control !== undefined) {
            Atomics.store(pending.control, STREAM_ACK, message.sequence);
            Atomics.notify(pending.control, STREAM_ACK);
          }
        }
        return;
      }
      this.#pending.delete(message.id);
      if (pending.callbackFailure !== undefined) {
        pending.reject(pending.callbackFailure);
        return;
      }
      if (message.ok) {
        pending.resolve(message.value);
      } else {
        pending.reject(deserializeWorkerError(message.error));
      }
    });
    worker.onFatal((error) => this.#stop(error));
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
  ): Promise<void> {
    if (this.#fatal !== undefined) {
      return Promise.reject(this.#fatal);
    }
    const id = this.#nextId++;
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: () => resolve(),
        reject,
        onChunk,
        control,
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

  #stop(error: Error): void {
    if (this.#fatal === undefined) {
      this.#fatal = error;
      this.#rejectAll(error);
    }
    if (this.#termination !== undefined) {
      return;
    }
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
    await rpc.terminate().catch(() => undefined);
    throw error;
  }
}

class WorkerDatabaseSession implements WasixDatabaseSession {
  readonly isolated = true;
  readonly identity: WasixDatabaseIdentity;
  readonly #rpc: WorkerRpc;

  constructor(rpc: WorkerRpc, options: SerializedOpenOptions) {
    this.#rpc = rpc;
    this.identity = normalizeWasixDatabaseIdentity(options.username, options.database);
  }

  async exec(input: Uint8Array, persistence: WasixPersistenceMode = 'sync'): Promise<Uint8Array> {
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
  ): Promise<void> {
    return this.#rpc.stream(input, persistence, onChunk);
  }

  async sync(boundary: WasixStorageSyncBoundary): Promise<void> {
    await this.#rpc.request({ method: 'sync', boundary });
  }

  async backup(): Promise<Uint8Array> {
    const response = await this.#rpc.request({ method: 'backup' });
    if (!(response instanceof Uint8Array)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid physical archive');
    }
    return response;
  }

  async runPgDump(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult> {
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

  async serve(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): Promise<void> {
    await this.#rpc.request({ method: 'serve', connection, mode });
  }

  close(): Promise<void> {
    return this.#closeOrderly();
  }

  abort(): Promise<void> {
    return this.#rpc.terminate();
  }

  async #closeOrderly(): Promise<void> {
    let requestFailure: unknown;
    try {
      await this.#rpc.request({ method: 'close' });
    } catch (error) {
      requestFailure = error;
    }
    try {
      await this.#rpc.terminate();
    } catch (terminationFailure) {
      if (requestFailure === undefined) {
        throw terminationFailure;
      }
    }
    if (requestFailure !== undefined) {
      throw requestFailure;
    }
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
