import { serializeWorkerError, type WorkerRequest, type WorkerResponse } from './rpc.js';
import { WasixProcess, type WasixHost } from './wasix-process.js';

export type WorkerResponder = (response: WorkerResponse, transfer?: readonly ArrayBuffer[]) => void;

/** One RPC dispatcher shared by browser Workers and Node worker_threads. */
export function createWorkerDispatcher(host: WasixHost, respond: WorkerResponder) {
  let process: WasixProcess | undefined;

  return async (request: WorkerRequest): Promise<void> => {
    try {
      switch (request.method) {
        case 'open':
          if (process !== undefined) {
            throw new Error('this worker already owns an Oliphaunt WASIX process');
          }
          process = await WasixProcess.open(request.options, host);
          respond({ id: request.id, ok: true });
          return;
        case 'exec': {
          const value = await requireProcess(process).exec(request.input);
          const transfer = value.buffer instanceof ArrayBuffer ? [value.buffer] : [];
          respond({ id: request.id, ok: true, value }, transfer);
          return;
        }
        case 'checkpoint':
          await requireProcess(process).checkpoint();
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

function requireProcess(process: WasixProcess | undefined): WasixProcess {
  if (process === undefined) {
    throw new Error('Oliphaunt WASIX process is not open');
  }
  return process;
}
