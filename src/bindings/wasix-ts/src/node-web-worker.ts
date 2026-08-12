import { Worker as ThreadWorker, type TransferListItem } from 'node:worker_threads';

type WebWorkerListener = (event: { data: unknown }) => void;
type WebWorkerErrorListener = (error: Error) => void;

/** Minimal Web Worker contract backed by worker_threads for Wasmer's inner workers. */
export class NodeWebWorker {
  onmessage: WebWorkerListener | null = null;
  onmessageerror: WebWorkerErrorListener | null = null;
  onerror: WebWorkerErrorListener | null = null;

  readonly #worker: ThreadWorker;
  readonly #messageListeners = new Set<WebWorkerListener>();
  readonly #errorListeners = new Set<WebWorkerErrorListener>();
  readonly #messageErrorListeners = new Set<WebWorkerErrorListener>();

  constructor(source: string | URL, options: { name?: string } = {}) {
    this.#worker = new ThreadWorker(new URL('./node-web-worker-thread.js', import.meta.url), {
      name: options.name,
      workerData: { source: String(source) },
    });
    this.#worker.on('message', (data) => {
      const event = { data };
      this.onmessage?.(event);
      for (const listener of this.#messageListeners) listener(event);
    });
    this.#worker.on('messageerror', (error) => {
      this.onmessageerror?.(error);
      for (const listener of this.#messageErrorListeners) listener(error);
    });
    this.#worker.on('error', (error) => {
      this.onerror?.(error);
      for (const listener of this.#errorListeners) listener(error);
    });
  }

  postMessage(value: unknown, transfer: readonly TransferListItem[] = []): void {
    this.#worker.postMessage(value, transfer);
  }

  terminate(): void {
    void this.#worker.terminate();
  }

  addEventListener(type: string, listener: WebWorkerListener | WebWorkerErrorListener): void {
    if (type === 'message') this.#messageListeners.add(listener as WebWorkerListener);
    else if (type === 'error') this.#errorListeners.add(listener as WebWorkerErrorListener);
    else if (type === 'messageerror') {
      this.#messageErrorListeners.add(listener as WebWorkerErrorListener);
    }
  }

  removeEventListener(type: string, listener: WebWorkerListener | WebWorkerErrorListener): void {
    if (type === 'message') this.#messageListeners.delete(listener as WebWorkerListener);
    else if (type === 'error') this.#errorListeners.delete(listener as WebWorkerErrorListener);
    else if (type === 'messageerror') {
      this.#messageErrorListeners.delete(listener as WebWorkerErrorListener);
    }
  }
}

export function installNodeWebWorker(): void {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: NodeWebWorker,
    writable: true,
  });
  // Wasmer's blocking helper falls back to a portable data URL when object
  // URLs are unavailable. Node cannot import its own blob:nodedata URLs.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}
