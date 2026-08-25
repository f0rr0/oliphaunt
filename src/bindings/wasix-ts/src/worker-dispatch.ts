import { WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES, type WasixDatabaseSession } from './database.js';
import {
  type SerializedOpenOptions,
  serializeWorkerError,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.js';
import { prepareTransferableBytes } from './worker-transfer.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

export type WorkerSessionOpener = (options: SerializedOpenOptions) => Promise<WasixDatabaseSession>;

/** @internal One request state machine shared by browser and server worker realms. */
export function createWorkerSessionDispatcher(
  openSession: WorkerSessionOpener,
  respond: WorkerResponder,
) {
  let process: WasixDatabaseSession | undefined;

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
            for (
              let offset = 0;
              offset < response.length;
              offset += WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES
            ) {
              onChunk(response.slice(offset, offset + WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES));
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
        case 'runPgDump': {
          const session = requireProcess(process);
          if (session.runPgDump === undefined) {
            throw new Error('this WASIX worker session does not support pg_dump');
          }
          const result = await session.runPgDump({ tool: request.tool, args: request.args });
          const stdout = prepareTransferableBytes(result.stdout);
          const stderr = prepareTransferableBytes(result.stderr);
          respond(
            {
              id: request.id,
              ok: true,
              value: {
                exitCode: result.exitCode,
                stdout: stdout.value,
                stderr: stderr.value,
              },
            },
            [...new Set([...stdout.transfer, ...stderr.transfer])],
          );
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

function requireProcess(process: WasixDatabaseSession | undefined): WasixDatabaseSession {
  if (process === undefined) {
    throw new Error('Oliphaunt WASIX process is not open');
  }
  return process;
}
