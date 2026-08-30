import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeWasixActorSession } from '../native-session.js';
import { workerOpenOptions } from './worker-helpers.js';

const nativeMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('../native-session.js', () => ({
  NativeWasixActorSession: { open: nativeMocks.open },
}));

import { openNodeActorSession } from '../node-actor.js';

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
});
