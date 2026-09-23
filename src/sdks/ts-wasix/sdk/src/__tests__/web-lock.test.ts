import { afterEach, describe, expect, it } from 'bun:test';
import { acquireExclusiveWebLock } from '../storage/web-lock.js';
import { restoreGlobals, stubGlobal } from './test-globals.js';

afterEach(() => restoreGlobals());

describe('WASIX Web Lock ownership', () => {
  it('requires Web Locks and reports an unavailable lock without taking ownership', async () => {
    stubGlobal('navigator', {});
    await expect(acquireExclusiveWebLock('database', 'database storage')).rejects.toMatchObject({
      code: 'unavailable',
      commitState: 'unchanged',
    });

    stubGlobal('navigator', {
      locks: {
        async request(
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => unknown,
        ) {
          return await callback(null);
        },
      },
    });
    await expect(acquireExclusiveWebLock('database', 'database storage')).rejects.toMatchObject({
      code: 'busy',
      commitState: 'unchanged',
    });
  });

  it('normalizes request failures and releases an acquired lock exactly once', async () => {
    stubGlobal('navigator', {
      locks: {
        async request() {
          throw 'request failed';
        },
      },
    });
    await expect(acquireExclusiveWebLock('database', 'database storage')).rejects.toThrow(
      'could not acquire ownership of database storage: request failed',
    );

    let releases = 0;
    stubGlobal('navigator', {
      locks: {
        async request(
          name: string,
          options: LockOptions,
          callback: (lock: Lock | null) => unknown,
        ) {
          expect(name).toBe('database');
          expect(options).toMatchObject({
            mode: 'exclusive',
            ifAvailable: true,
          });
          const result = await callback({ name, mode: 'exclusive' } as Lock);
          releases += 1;
          return result;
        },
      },
    });
    const lock = await acquireExclusiveWebLock('database', 'database storage');
    await lock.release();
    await lock.release();
    expect(releases).toBe(1);
  });
});
