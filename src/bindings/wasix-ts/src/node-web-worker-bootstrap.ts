import { parentPort, type TransferListItem, workerData } from 'node:worker_threads';

import { installNodeWebWorker } from './node-web-worker.js';

type WorkerTarget = Readonly<{ url: string }> | Readonly<{ source: string }>;
type WorkerMessageHandler = ((event: MessageEvent) => void) | null;

if (parentPort === null) throw new Error('Wasmer Node worker has no parent port');
const port = parentPort;

installNodeWebWorker();

const pending: unknown[] = [];
let handler: WorkerMessageHandler = null;
Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  get: () => handler,
  set(value: WorkerMessageHandler) {
    handler = value;
    if (handler !== null) {
      for (const data of pending.splice(0)) handler({ data } as MessageEvent);
    }
  },
});
Object.defineProperty(globalThis, 'postMessage', {
  configurable: true,
  value: (message: unknown, transfer: readonly TransferListItem[] = []) =>
    port.postMessage(message, transfer),
});

port.on('message', (data) => {
  if (handler === null) pending.push(data);
  else handler({ data } as MessageEvent);
});

const target = workerData as WorkerTarget;
if ('url' in target) {
  await import(target.url);
} else {
  const source = `data:text/javascript;base64,${Buffer.from(target.source).toString('base64')}`;
  await import(source);
}
