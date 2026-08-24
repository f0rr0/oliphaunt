import type { WasixPersistenceMode, WasixProtocolConnectionMode } from './database.js';
import { WASIX_STREAM_CHUNK_BYTES } from './byte-channel.js';
import {
  type SerializedOpenOptions,
  serializeWorkerError,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import { prepareTransferableBytes } from './worker-transfer.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

type WorkerSession = Readonly<{
  exec(input: Uint8Array, persistence?: WasixPersistenceMode): Promise<Uint8Array>;
  execStream?(
    input: Uint8Array,
    onChunk: (chunk: Uint8Array) => void,
    persistence?: WasixPersistenceMode,
  ): Promise<void>;
  sync(boundary: WasixStorageSyncBoundary): Promise<void>;
  backup?(): Promise<Uint8Array>;
  serve?(connection: WasixProtocolConnection, mode: WasixProtocolConnectionMode): Promise<void>;
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
        case 'execStream': {
          const session = requireProcess(process);
          const control = new Int32Array(request.control);
          let sequence = 0;
          const onChunk = (chunk: Uint8Array): void => {
            sequence += 1;
            const prepared = prepareTransferableBytes(chunk);
            respond(
              {
                id: request.id,
                kind: 'chunk',
                sequence,
                value: prepared.value,
              },
              prepared.transfer,
            );
            while (Atomics.load(control, 0) < sequence) {
              Atomics.wait(control, 0, sequence - 1);
            }
            if (Atomics.load(control, 1) !== 0) {
              throw new Error('protocol stream consumer failed');
            }
          };
          if (session.execStream === undefined) {
            const response = await session.exec(request.input, request.persistence);
            for (let offset = 0; offset < response.length; offset += WASIX_STREAM_CHUNK_BYTES) {
              onChunk(response.slice(offset, offset + WASIX_STREAM_CHUNK_BYTES));
            }
          } else {
            await session.execStream(request.input, onChunk, request.persistence);
          }
          respond({ id: request.id, ok: true });
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
        case 'serve': {
          const session = requireProcess(process);
          if (session.serve === undefined) {
            throw new Error('this WASIX worker session does not support protocol connections');
          }
          await session.serve(request.connection, request.mode);
          respond({ id: request.id, ok: true });
          return;
        }
        case 'close':
          await requireProcess(process).close();
          process = undefined;
          respond({ id: request.id, ok: true });
          return;
      }
    } catch (error) {
      respond({
        id: request.id,
        ok: false,
        error: serializeWorkerError(error),
      });
    }
  };
}

function requireProcess(process: WorkerSession | undefined): WorkerSession {
  if (process === undefined) {
    throw new Error('Oliphaunt WASIX process is not open');
  }
  return process;
}
