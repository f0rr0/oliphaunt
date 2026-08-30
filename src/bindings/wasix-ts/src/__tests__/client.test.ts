import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const directMocks = vi.hoisted(() => ({
  openWasixDirect: vi.fn(),
  openNodeActor: vi.fn(),
  openNodeDirect: vi.fn(),
}));

vi.mock('../direct-client-common.js', () => ({
  openWasixDirect: directMocks.openWasixDirect,
}));
vi.mock('../node-direct.js', () => ({
  openNodeDirect: directMocks.openNodeDirect,
}));
vi.mock('../node-actor.js', () => ({
  openNodeActor: directMocks.openNodeActor,
}));
vi.mock('../worker-rpc.js', () => {
  throw new Error('root entrypoint loaded Worker RPC machinery');
});
vi.mock('../native-session.js', () => ({
  restoreNativeWasix: vi.fn(),
  restoreNativeWasixDirect: vi.fn(),
}));

import { openWasixWithHost } from '../client.js';
import type { OliphauntDatabase } from '../types.js';

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
    value: class ForbiddenWorker {
      constructor() {
        throw new Error('root entrypoint constructed a Worker');
      }
    },
  });
  directMocks.openWasixDirect.mockReset();
  directMocks.openWasixDirect.mockResolvedValue({} as OliphauntDatabase);
  directMocks.openNodeDirect.mockReset();
  directMocks.openNodeDirect.mockResolvedValue({} as OliphauntDatabase);
  directMocks.openNodeActor.mockReset();
  directMocks.openNodeActor.mockResolvedValue({} as OliphauntDatabase);
});

describe('WASIX Node-compatible root execution surface', () => {
  it('opens through the Rust actor without loading Worker RPC machinery', async () => {
    const { openWasix } = await import('../node-client.js');

    const database = await openWasix();

    expect(database).toBe(await directMocks.openNodeActor.mock.results[0]?.value);
    expect(directMocks.openNodeActor).toHaveBeenCalledOnce();
    expect(directMocks.openNodeDirect).not.toHaveBeenCalled();
  });

  it('keeps the explicit direct placement in the importing realm', async () => {
    const { openWasix } = await import('../direct-client.js');

    const database = await openWasix();

    expect(database).toBe(await directMocks.openNodeDirect.mock.results[0]?.value);
    expect(directMocks.openNodeDirect).toHaveBeenCalledOnce();
    expect(directMocks.openNodeActor).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  restoreGlobal('crossOriginIsolated', crossOriginDescriptor);
  restoreGlobal('Worker', workerDescriptor);
});

describe('WASIX browser root execution surface', () => {
  it('opens through the caller-realm engine and never constructs a Worker', async () => {
    const database = await openWasixWithHost(
      { username: 'application' },
      async () => ({}) as never,
    );

    expect(database).toBe(await directMocks.openWasixDirect.mock.results[0]?.value);
    expect(directMocks.openWasixDirect).toHaveBeenCalledOnce();
    expect(directMocks.openWasixDirect.mock.calls[0]?.[2]).toBe('browser-main');
  });
});

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
