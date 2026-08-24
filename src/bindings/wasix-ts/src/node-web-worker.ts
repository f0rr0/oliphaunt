import { Worker as ThreadWorker, type TransferListItem } from 'node:worker_threads';

type WorkerMessage = Readonly<{ message: unknown; transfer: readonly TransferListItem[] }>;

/** @internal Install the browser Worker shape expected by Wasmer on Node. */
export function installNodeWebWorker(): void {
  if (typeof globalThis.Worker !== 'undefined') return;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: NodeWebWorker,
    writable: true,
  });
}

class NodeWebWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  #worker: ThreadWorker | undefined;
  #pending: WorkerMessage[] = [];
  #terminated = false;

  constructor(url: string | URL, options: WorkerOptions = {}) {
    void this.#start(url, options);
  }

  postMessage(message: unknown, transfer: readonly TransferListItem[] = []): void {
    if (this.#terminated) return;
    if (this.#worker === undefined) {
      this.#pending.push({ message, transfer });
      return;
    }
    this.#worker.postMessage(message, transfer);
  }

  terminate(): void {
    this.#terminated = true;
    this.#pending = [];
    void this.#worker?.terminate();
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.onmessage = listener as (event: MessageEvent) => void;
    if (type === 'messageerror') {
      this.onmessageerror = listener as (event: MessageEvent) => void;
    }
    if (type === 'error') this.onerror = listener as (event: ErrorEvent) => void;
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message' && this.onmessage === listener) this.onmessage = null;
    if (type === 'messageerror' && this.onmessageerror === listener) {
      this.onmessageerror = null;
    }
    if (type === 'error' && this.onerror === listener) this.onerror = null;
  }

  async #start(url: string | URL, options: WorkerOptions): Promise<void> {
    try {
      const target = await nodeWorkerTarget(url);
      if (this.#terminated) return;
      const worker = new ThreadWorker(new URL('./node-web-worker-bootstrap.js', import.meta.url), {
        name: options.name,
        workerData: target,
      });
      this.#worker = worker;
      worker.on('message', (data) => this.onmessage?.(messageEvent(data)));
      worker.on('messageerror', (error) => this.onmessageerror?.(messageEvent(error)));
      worker.on('error', (error) => this.#reportError(error));
      worker.on('exit', (code) => {
        if (!this.#terminated && code !== 0) {
          this.#reportError(new Error(`Wasmer worker exited with code ${code}`));
        }
      });
      for (const pending of this.#pending.splice(0)) {
        worker.postMessage(pending.message, pending.transfer);
      }
    } catch (error) {
      this.#reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #reportError(error: Error): void {
    if (this.onerror !== null) {
      this.onerror({ error, message: error.message } as ErrorEvent);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  }
}

async function nodeWorkerTarget(
  input: string | URL,
): Promise<Readonly<{ url: string }> | Readonly<{ source: string }>> {
  const url = input instanceof URL ? input : new URL(input, import.meta.url);
  if (url.protocol !== 'blob:') return { url: url.href };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not read Wasmer worker blob (${response.status})`);
  return { source: await response.text() };
}

function messageEvent(data: unknown): MessageEvent {
  return { data } as MessageEvent;
}
