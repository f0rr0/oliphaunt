import {
  WasixDatabaseImpl,
  type WasixDatabaseSession,
  type WasixPersistenceMode,
} from './database.js';
import type { SerializedOpenOptions, WorkerRequest, WorkerResponse } from './rpc.js';
import { deserializeWorkerError } from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { OliphauntDatabase } from './types.js';

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
    { resolve: (value: Uint8Array | undefined) => void; reject: (error: Error) => void }
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
      this.#pending.delete(message.id);
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
  ): Promise<Uint8Array | undefined> {
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
    return new WasixDatabaseImpl(new WorkerDatabaseSession(rpc));
  } catch (error) {
    await rpc.terminate().catch(() => undefined);
    throw error;
  }
}

class WorkerDatabaseSession implements WasixDatabaseSession {
  readonly #rpc: WorkerRpc;

  constructor(rpc: WorkerRpc) {
    this.#rpc = rpc;
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
