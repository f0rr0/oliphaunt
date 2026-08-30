import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NativeWasixSession } from '../native-session.js';
import { workerOpenOptions } from './worker-helpers.js';

const nativeMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('../native-session.js', () => ({
  NativeWasixSession: { open: nativeMocks.open },
}));

import { openNodeDirectSession } from '../node-direct.js';

beforeEach(() => nativeMocks.open.mockReset());

describe('WASIX Node direct native routing', () => {
  // liboliphaunt-doc-example:wasix-typescript-direct-entrypoint
  it('opens one synchronous native session in the importing realm', async () => {
    const options = workerOpenOptions();
    const session = {} as NativeWasixSession;
    nativeMocks.open.mockResolvedValueOnce(session);

    await expect(openNodeDirectSession(options)).resolves.toBe(session);
    expect(nativeMocks.open).toHaveBeenCalledOnce();
    expect(nativeMocks.open).toHaveBeenCalledWith(options);
  });
});
