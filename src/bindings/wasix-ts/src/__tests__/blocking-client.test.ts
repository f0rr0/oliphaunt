import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const blockingMocks = vi.hoisted(() => ({
  openWasixDirect: vi.fn(),
}));

vi.mock('../direct-client-common.js', () => ({
  openWasixDirect: blockingMocks.openWasixDirect,
}));

import { openWasixBlockingWithHost } from '../blocking-client.js';
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
        throw new Error('blocking entrypoint constructed a Worker');
      }
    },
  });
  blockingMocks.openWasixDirect.mockReset();
  blockingMocks.openWasixDirect.mockResolvedValue({} as OliphauntDatabase);
});

afterEach(() => {
  restoreGlobal('crossOriginIsolated', crossOriginDescriptor);
  restoreGlobal('Worker', workerDescriptor);
});

describe('WASIX browser blocking calling contract', () => {
  it('opens through the caller-realm engine and never constructs a Worker', async () => {
    const database = await openWasixBlockingWithHost(
      { username: 'application' },
      async () => ({}) as never,
    );

    expect(database).toBe(await blockingMocks.openWasixDirect.mock.results[0]?.value);
    expect(blockingMocks.openWasixDirect).toHaveBeenCalledOnce();
    expect(blockingMocks.openWasixDirect.mock.calls[0]?.[2]).toBe('browser-main');
  });

  it('rejects legacy placement before loading the caller-realm engine', async () => {
    await expect(
      openWasixBlockingWithHost({ execution: 'worker' } as never, async () => ({}) as never),
    ).rejects.toThrow(/no longer accepts the "execution" option/);
    expect(blockingMocks.openWasixDirect).not.toHaveBeenCalled();
  });
});

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
