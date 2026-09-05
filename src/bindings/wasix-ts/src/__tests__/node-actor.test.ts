import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeWasixActorSession } from '../native-session.js';
import { workerOpenOptions } from './worker-helpers.js';

const nativeMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('../native-session.js', () => ({
  NativeWasixActorSession: { open: nativeMocks.open },
}));

import { openNodeActorSession } from '../node-actor.js';
import { requireNodeStorage } from '../node-client-common.js';

beforeEach(() => nativeMocks.open.mockReset());

describe('WASIX Node actor routing', () => {
  it('opens one asynchronous native actor session for the root placement', async () => {
    const options = workerOpenOptions();
    const session = {} as NativeWasixActorSession;
    nativeMocks.open.mockResolvedValueOnce(session);

    await expect(openNodeActorSession(options)).resolves.toBe(session);
    expect(nativeMocks.open).toHaveBeenCalledOnce();
    expect(nativeMocks.open).toHaveBeenCalledWith(options);
  });

  it('accepts host storage and rejects browser-only storage before native startup', () => {
    const memory = workerOpenOptions();
    expect(() => requireNodeStorage(memory)).not.toThrow();

    const directory = workerOpenOptions();
    directory.storage = {
      schema: 'oliphaunt-wasix-storage-v1',
      kind: 'directory',
      path: 'relative-database',
    };
    requireNodeStorage(directory);
    expect(directory.storage).toMatchObject({
      kind: 'directory',
      path: expect.stringMatching(/[/\\]relative-database$/),
    });

    for (const kind of ['indexed-db', 'opfs'] as const) {
      const browser = workerOpenOptions();
      browser.storage = { schema: 'oliphaunt-wasix-storage-v1', kind, name: 'database' };
      expect(() => requireNodeStorage(browser)).toThrow(/browser-only/);
    }
  });
});
