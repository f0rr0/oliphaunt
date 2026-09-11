import {
  WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES,
  type WasixDatabaseSession,
  type WasixProtocolStreamOutcome,
} from './database.js';
import { restoreWasixSerialized } from './client-common.js';
import {
  type SerializedOpenOptions,
  serializeWorkerError,
  type WorkerRequest,
  type WorkerResponse,
} from './rpc.js';
import { prepareTransferableBytes } from './worker-transfer.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

export type WorkerSessionOpener = (options: SerializedOpenOptions) => Promise<WasixDatabaseSession>;
export type WorkerStorageRestorer = (
  storage: SerializedOpenOptions['storage'],
  bytes: Uint8Array,
) => Promise<void>;
export type WorkerDispatcherLifecycle = Readonly<{
  /** Called only after close has settled and its response has been posted. */
  onQuiescentClose?(): void;
}>;

class WorkerStreamCallbackAborted extends Error {}

/** @internal One request state machine shared by browser and server worker realms. */
export function createWorkerSessionDispatcher(
  openSession: WorkerSessionOpener,
  respond: WorkerResponder,
  restore: WorkerStorageRestorer = restoreWasixSerialized,
  lifecycle: WorkerDispatcherLifecycle = {},
) {
  let process: WasixDatabaseSession | undefined;
  let terminal = false;

  return async (request: WorkerRequest): Promise<void> => {
    let quiescentClose = false;
    try {
      if (terminal) {
        throw new Error('Oliphaunt WASIX worker session is closed');
      }
      switch (request.method) {
        case 'open':
          if (process !== undefined) {
            throw new Error('this worker already owns an Oliphaunt WASIX process');
          }
          process = await openSession(request.options);
          respond({ id: request.id, ok: true });
          return;
        case 'restore':
          if (process !== undefined) {
            throw new Error('this worker already owns an Oliphaunt WASIX process');
          }
          await restore(request.storage, request.bytes);
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
          const onChunk = (chunk: Uint8Array): undefined => {
            if (Atomics.load(control, 1) !== 0) {
              throw new WorkerStreamCallbackAborted('protocol stream consumer failed');
            }
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
              throw new WorkerStreamCallbackAborted('protocol stream consumer failed');
            }
            return undefined;
          };
          let outcome: WasixProtocolStreamOutcome;
          if (session.execStream === undefined) {
            const response = await session.exec(request.input, request.persistence);
            outcome = 'complete';
            try {
              for (
                let offset = 0;
                offset < response.length;
                offset += WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES
              ) {
                onChunk(response.slice(offset, offset + WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES));
              }
            } catch (error) {
              if (!(error instanceof WorkerStreamCallbackAborted)) throw error;
              outcome = 'callbackAborted';
            }
          } else {
            outcome = await session.execStream(request.input, onChunk, request.persistence);
          }
          respond({ id: request.id, ok: true, streamOutcome: outcome });
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
        case 'runTool': {
          const session = requireProcess(process);
          if (session.runTool === undefined) {
            throw new Error('this WASIX worker session does not support native tools');
          }
          const result = await session.runTool(request.options);
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
        case 'close': {
          const closing = requireProcess(process);
          // Retire the dispatcher before awaiting guest/provider teardown. A
          // rejected close cannot make a Worker whose transport will be
          // destroyed by its owner safe to reopen or use again.
          process = undefined;
          terminal = true;
          quiescentClose = true;
          await closing.close();
          respond({ id: request.id, ok: true });
          return;
        }
      }
    } catch (error) {
      respond({
        id: request.id,
        ok: false,
        error: serializeWorkerError(error),
      });
    } finally {
      if (quiescentClose) lifecycle.onQuiescentClose?.();
    }
  };
}

function requireProcess(process: WasixDatabaseSession | undefined): WasixDatabaseSession {
  if (process === undefined) {
    throw new Error('Oliphaunt WASIX process is not open');
  }
  return process;
}
