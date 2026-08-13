import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { WasixDatabaseImpl, type WasixDatabaseSession } from './database.js';
import { serializeWasixExtensionDescriptors } from './extension-descriptor.js';
import type {
  SerializedAssetSource,
  SerializedOpenOptions,
  WorkerRequest,
  WorkerResponse,
} from './rpc.js';
import { deserializeWorkerError } from './rpc.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import { serializeWasixStorage } from './storage.js';
import type { OliphauntDatabase, OpenConfig } from './types.js';

export function serializeOpenConfig(config: OpenConfig = {}): SerializedOpenOptions {
  const extensions = serializeWasixExtensionDescriptors(config.extensions ?? []);
  const runtime = serializeWasixRuntimeDescriptor(config.advanced?.runtime ?? defaultWasixRuntime);
  const storage = serializeWasixStorage(config.storage);
  return {
    runtime,
    extensionCarriers: extensions.carriers,
    extensions: extensions.selectedSqlNames,
    username: config.username ?? 'postgres',
    database: config.database ?? 'postgres',
    startupGUCs: { ...(config.startupGUCs ?? {}) },
    storage,
  };
}

export async function openWasixWithWorker(
  createWorker: () => WasixWorkerPort,
  openOptions: SerializedOpenOptions,
): Promise<OliphauntDatabase> {
  const rpc = new WorkerRpc(createWorker());
  const transfer = assetTransfers(openOptions);
  try {
    await rpc.request({ method: 'open', options: openOptions }, transfer);
    return new WasixDatabaseImpl(new WorkerDatabaseSession(rpc));
  } catch (error) {
    rpc.terminate();
    throw error;
  }
}

type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export type WasixWorkerPort = {
  postMessage(message: WorkerRequest, transfer: readonly Transferable[]): void;
  terminate(): void;
  onMessage(listener: (message: WorkerResponse) => void): void;
  onFatal(listener: (error: Error) => void): void;
};

class WorkerRpc {
  readonly #worker: WasixWorkerPort;
  readonly #pending = new Map<
    number,
    { resolve: (value: Uint8Array | undefined) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;
  #fatal: Error | undefined;

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
    worker.onFatal((error) => this.#fail(error));
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

  terminate(): void {
    this.#worker.terminate();
    const error = this.#fatal ?? new Error('Oliphaunt WASIX worker was terminated');
    this.#fatal = error;
    this.#rejectAll(error);
  }

  #fail(error: Error): void {
    if (this.#fatal !== undefined) {
      return;
    }
    this.#fatal = error;
    this.#worker.terminate();
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

class WorkerDatabaseSession implements WasixDatabaseSession {
  readonly #rpc: WorkerRpc;

  constructor(rpc: WorkerRpc) {
    this.#rpc = rpc;
  }

  async exec(input: Uint8Array): Promise<Uint8Array> {
    const response = await this.#rpc.request({ method: 'exec', input }, [input.buffer]);
    if (!(response instanceof Uint8Array)) {
      throw new Error('Oliphaunt WASIX worker returned an invalid protocol response');
    }
    return response;
  }

  async checkpoint(): Promise<void> {
    await this.#rpc.request({ method: 'checkpoint' });
  }

  async close(): Promise<void> {
    try {
      await this.#rpc.request({ method: 'close' });
    } finally {
      this.#rpc.terminate();
    }
  }
}

function assetTransfers(options: SerializedOpenOptions): Transferable[] {
  const transfer: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  appendAssetTransfer(options.runtime.runtimeArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.pgdataArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.manifest.source, transfer, seen);
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
