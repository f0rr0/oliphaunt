import type { WasixPersistenceMode } from './database.js';
import {
  type SerializedOpenOptions,
  serializeWorkerError,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import { prepareTransferableBytes } from './worker-transfer.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

type WorkerSession = Readonly<{
  exec(input: Uint8Array, persistence?: WasixPersistenceMode): Promise<Uint8Array>;
  sync(boundary: WasixStorageSyncBoundary): Promise<void>;
  backup?(): Promise<Uint8Array>;
  close(): Promise<void>;
}>;

export type WorkerSessionOpener = (options: SerializedOpenOptions) => Promise<WorkerSession>;

/** @internal One request state machine shared by browser and server worker realms. */
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
        case 'backup': {
          const session = requireProcess(process);
          if (session.backup === undefined) {
            throw new Error('this WASIX worker session does not support physical backup');
          }
          const archive = prepareTransferableBytes(await session.backup());
          respond({ id: request.id, ok: true, value: archive.value }, archive.transfer);
          return;
        }
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
