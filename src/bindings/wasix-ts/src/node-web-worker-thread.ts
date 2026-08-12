import { parentPort, workerData } from 'node:worker_threads';

import { installNodeWebWorker } from './node-web-worker.js';

const port = parentPort;
const source = (workerData as { source?: unknown } | undefined)?.source;
if (port === null || typeof source !== 'string' || source.length === 0) {
  throw new Error('Oliphaunt WASIX inner worker has invalid worker_threads bootstrap data');
}

type MessageListener = ((event: { data: unknown }) => void) | null;
let onmessage: MessageListener = null;
const queued: unknown[] = [];

Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  get: () => onmessage,
  set: (listener: MessageListener) => {
    onmessage = typeof listener === 'function' ? listener : null;
    if (onmessage !== null) {
      for (const data of queued.splice(0)) onmessage({ data });
    }
  },
});
Object.defineProperty(globalThis, 'postMessage', {
  configurable: true,
  value: (value: unknown) => port.postMessage(value),
});
port.on('message', (data) => {
  if (onmessage === null) queued.push(data);
  else onmessage({ data });
});

installNodeWebWorker();
await import(source);
