import type { WasixPersistenceMode } from './database.js';
import {
  type SerializedOpenOptions,
  serializeWorkerError,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import { type WasixHost, WasixProcess } from './wasix-process.js';
import { prepareTransferableBytes } from './worker-transfer.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

type WorkerSession = Readonly<{
  exec(input: Uint8Array, persistence?: WasixPersistenceMode): Promise<Uint8Array>;
  sync(boundary: WasixStorageSyncBoundary): Promise<void>;
  close(): Promise<void>;
}>;

export type WorkerSessionOpener = (options: SerializedOpenOptions) => Promise<WorkerSession>;

/** One RPC dispatcher shared by browser Workers and Node worker_threads. */
export function createWorkerDispatcher(host: WasixHost, respond: WorkerResponder) {
  return createWorkerSessionDispatcher((options) => WasixProcess.open(options, host), respond);
}

/** @internal One request state machine shared by stream and in-realm worker hosts. */
export function createWorkerSessionDispatcher(
  openSession: WorkerSessionOpener,
  respond: WorkerResponder,
) {
  let process: WorkerSession | undefined;

  return async (request: WorkerRequest): Promise<void> => {
    try {
      switch (request.method) {
        case 'open':
          if (process !== undefined) {
            throw new Error('this worker already owns an Oliphaunt WASIX process');
          }
          process = await openSession(request.options);
          respond({ id: request.id, ok: true });
          return;
        case 'exec': {
          const response = prepareTransferableBytes(
            await requireProcess(process).exec(request.input, request.persistence),
          );
          respond({ id: request.id, ok: true, value: response.value }, response.transfer);
          return;
        }
        case 'sync':
          await requireProcess(process).sync(request.boundary);
          respond({ id: request.id, ok: true });
          return;
        case 'close':
          await requireProcess(process).close();
          process = undefined;
          respond({ id: request.id, ok: true });
          return;
      }
    } catch (error) {
      respond({ id: request.id, ok: false, error: serializeWorkerError(error) });
    }
  };
}

function requireProcess(process: WorkerSession | undefined): WorkerSession {
  if (process === undefined) {
    throw new Error('Oliphaunt WASIX process is not open');
  }
  return process;
}
