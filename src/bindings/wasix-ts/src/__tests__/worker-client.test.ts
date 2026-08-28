import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openWasix, Oliphaunt } from '../worker-client.js';
import type { WorkerRequest, WorkerResponse } from '../rpc.js';
import { indexedDB } from '../storage/indexed-db.js';

let crossOriginDescriptor: PropertyDescriptor | undefined;
let workerDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  crossOriginDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
  workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: FakeBrowserWorker,
  });
  FakeBrowserWorker.instances.length = 0;
});

afterEach(() => {
  restoreGlobal('crossOriginIsolated', crossOriginDescriptor);
  restoreGlobal('Worker', workerDescriptor);
});

describe('WASIX browser Worker execution surface', () => {
  it('always opens and closes through exactly one package Worker', async () => {
    const database = await openWasix();
    const worker = FakeBrowserWorker.instances[0];
    expect(FakeBrowserWorker.instances).toHaveLength(1);
    expect(worker?.url.pathname).toMatch(/\/worker\.js$/);
    expect(worker?.options).toEqual({ type: 'module', name: 'oliphaunt-wasix' });
    expect(worker?.requests[0]?.method).toBe('open');

    await database.close();
    expect(worker?.requests[1]?.method).toBe('close');
    expect(worker?.terminations).toBe(1);
  });

  it('uses a temporary package Worker for restore', async () => {
    await Oliphaunt.restore(indexedDB('worker-restore'), Uint8Array.of(1, 2, 3));

    const worker = FakeBrowserWorker.instances[0];
    expect(FakeBrowserWorker.instances).toHaveLength(1);
    expect(worker?.requests[0]?.method).toBe('restore');
    expect(worker?.terminations).toBe(1);
  });

  it('requires Worker support only on the explicit Worker surface', async () => {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: undefined,
    });

    await expect(openWasix()).rejects.toThrow(
      '@oliphaunt/wasix-ts/worker requires a browser with Web Workers',
    );
  });
});

class FakeBrowserWorker {
  static readonly instances: FakeBrowserWorker[] = [];
  readonly requests: WorkerRequest[] = [];
  readonly url: URL;
  readonly options: WorkerOptions;
  terminations = 0;
  readonly #listeners = new Map<string, Array<(event: MessageEvent | ErrorEvent) => void>>();

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeBrowserWorker.instances.push(this);
  }

  postMessage(message: WorkerRequest): void {
    this.requests.push(message);
    queueMicrotask(() => {
      this.#emit('message', { data: { id: message.id, ok: true } satisfies WorkerResponse });
    });
  }

  addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  terminate(): void {
    this.terminations += 1;
  }

  #emit(type: string, event: MessageEvent | { data: WorkerResponse }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as MessageEvent);
    }
  }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
