import type { OliphauntDatabase } from './types.js';
import {
  runWasixToolProcess as runTool,
  type WasixToolProcessOptions,
  type WasixToolProcessResult,
  type WasixToolWorkerPort,
} from './internal-common.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';

import { getWasixDatabaseIdentity } from './database.js';
export { getWasixDatabaseIdentity } from './database.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './internal-common.js';

export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
): Promise<WasixToolProcessResult> {
  const identity = getWasixDatabaseIdentity(database);
  const managed =
    options.tool.name === 'pg_dump'
      ? ['--encoding=UTF8', '--no-password']
      : ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1'];
  return runTool(
    database,
    {
      ...options,
      args: [
        ...options.args,
        ...managed,
        `--username=${identity.username}`,
        '--host=127.0.0.1',
        '--port=65432',
        `--dbname=${identity.database}`,
        ...(options.command !== undefined
          ? ['--command', options.command]
          : options.stdin !== undefined
            ? ['--file=-']
            : []),
      ],
    },
    createBrowserToolWorker,
  );
}

function createBrowserToolWorker(): WasixToolWorkerPort {
  if (typeof Worker === 'undefined') {
    throw new Error('WASIX tools require Web Workers');
  }
  const worker = new Worker(new URL('./tool-worker.js', import.meta.url), {
    type: 'module',
    name: 'oliphaunt-wasix-tool',
  });
  let messageListener: ((response: WasixToolWorkerResponse) => void) | undefined;
  let fatalListener: ((error: Error) => void) | undefined;
  let fatalDelivered = false;
  worker.addEventListener('message', (event: MessageEvent<WasixToolWorkerResponse>) => {
    messageListener?.(event.data);
  });
  worker.addEventListener('error', (event) => {
    if (fatalDelivered) return;
    fatalDelivered = true;
    fatalListener?.(new Error(event.message || 'Oliphaunt WASIX tool worker crashed'));
  });
  worker.addEventListener('messageerror', () => {
    if (fatalDelivered) return;
    fatalDelivered = true;
    fatalListener?.(new Error('Oliphaunt WASIX tool worker returned an unreadable response'));
  });
  return {
    postMessage: (request: WasixToolWorkerRequest, transfer: ArrayBuffer[] = []) =>
      worker.postMessage(request, transfer),
    onMessage: (listener) => {
      messageListener = listener;
    },
    onFatal: (listener) => {
      fatalListener = listener;
    },
    terminate: () => worker.terminate(),
  };
}
