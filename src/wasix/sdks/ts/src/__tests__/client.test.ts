import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

const directMocks = {
  openWasixDirect: vi.fn(),
  openNodeActor: vi.fn(),
  openNodeDirect: vi.fn(),
};

vi.mock('../hosts/browser/direct-client-common.js', () => ({
  openWasixDirect: directMocks.openWasixDirect,
}));
vi.mock('../hosts/node-api/node-direct.js', () => ({
  openNodeDirect: directMocks.openNodeDirect,
}));
vi.mock('../hosts/node-api/node-actor.js', () => ({
  openNodeActor: directMocks.openNodeActor,
}));
vi.mock('../workers/worker-rpc.js', () => {
  throw new Error('root entrypoint loaded Worker RPC machinery');
});
vi.mock('../hosts/node-api/native-session.js', () => ({
  restoreNativeWasix: vi.fn(),
  restoreNativeWasixDirect: vi.fn(),
}));

import { openWasixWithHost } from '../hosts/browser/client.js';
import { directory } from '../storage/node.js';
import type { OliphauntDatabase } from '../core/types.js';

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
    const { openWasix } = await import('../hosts/node-api/node-client.js');

    const database = await openWasix();

    expect(database).toBe(await directMocks.openNodeActor.mock.results[0]?.value);
    expect(directMocks.openNodeActor).toHaveBeenCalledTimes(1);
    expect(directMocks.openNodeDirect).not.toHaveBeenCalled();
  });

  it('keeps the explicit direct placement in the importing realm', async () => {
    const { openWasix } = await import('../hosts/node-api/direct-client.js');

    const database = await openWasix();

    expect(database).toBe(await directMocks.openNodeDirect.mock.results[0]?.value);
    expect(directMocks.openNodeDirect).toHaveBeenCalledTimes(1);
    expect(directMocks.openNodeActor).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  restoreGlobal('crossOriginIsolated', crossOriginDescriptor);
  restoreGlobal('Worker', workerDescriptor);
});

describe('WASIX browser root execution surface', () => {
  it('rejects explicit browser entrypoint imports on native hosts', async () => {
    await expect(import('../browser.js')).rejects.toThrow('requires a browser or browser worker');
  });

  it('rejects native storage before loading the browser host', async () => {
    const loadHost = vi.fn();
    // @ts-expect-error Exercise the JavaScript boundary with native-only storage.
    await expect(openWasixWithHost({ storage: directory('/db') }, loadHost)).rejects.toThrow(
      'directory storage is native-only',
    );
    expect(loadHost).not.toHaveBeenCalled();
  });

  it('opens through the caller-realm engine and never constructs a Worker', async () => {
    const database = await openWasixWithHost(
      { username: 'application' },
      async () => ({}) as never,
    );

    expect(database).toBe(await directMocks.openWasixDirect.mock.results[0]?.value);
    expect(directMocks.openWasixDirect).toHaveBeenCalledTimes(1);
    expect(directMocks.openWasixDirect.mock.calls[0]?.[2]).toBe('browser-main');
  });
});

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
