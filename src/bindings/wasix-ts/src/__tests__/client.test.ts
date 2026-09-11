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

import { openWasixWithHost, Oliphaunt as browser } from '../client.js';
import { directory } from '../storage/node.js';
import { indexedDB } from '../storage/indexed-db.js';
import { restoreNativeWasix, restoreNativeWasixDirect } from '../native-session.js';
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

it('rejects host-incompatible storage before loading engines or touching restore bytes', async () => {
  const load = vi.fn();
  await expect(openWasixWithHost({ storage: directory('/db') } as never, load)).rejects.toThrow(
    'native-only',
  );
  await expect(browser.restore(directory('/db') as never, [])).rejects.toThrow('native-only');
  expect(load).not.toHaveBeenCalled();
  const { Oliphaunt: native } = await import('../node-client.js');
  await expect(native.open({ storage: indexedDB('db') } as never)).rejects.toThrow('browser-only');
  await expect(native.restore(indexedDB('db') as never, [])).rejects.toThrow('browser-only');
});

it('passes the exact restore byte view to N-API without another JavaScript copy', async () => {
  const bytes = Uint8Array.of(9, 1, 2, 9).subarray(1, 3);
  const { Oliphaunt: native } = await import('../node-client.js');
  const { Oliphaunt: direct } = await import('../direct-client.js');
  await native.restore(directory('/db'), bytes);
  await direct.restore(directory('/db'), bytes);
  expect(vi.mocked(restoreNativeWasix).mock.calls.at(-1)?.[1]).toBe(bytes);
  expect(vi.mocked(restoreNativeWasixDirect).mock.calls.at(-1)?.[1]).toBe(bytes);
});

it('rejects an explicit browser import in a native host', async () => {
  await expect(import('../browser.js')).rejects.toThrow('requires a browser');
});
