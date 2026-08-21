import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import { releaseRestoreLock } from '../storage/restore-cleanup.js';

describe('WASIX restore ownership cleanup', () => {
  it('reports a release-only failure after completed publication as persisted', async () => {
    const failure = await releaseRestoreLock(
      { release: async () => Promise.reject(new Error('release failed')) },
      'test storage',
      'persisted',
      undefined,
    );

    expect(failure).toMatchObject({
      code: 'unavailable',
      commitState: 'persisted',
    });
  });

  it('preserves a primary storage classification when release also fails', async () => {
    const primary = new WasixStorageError('restore destination is not empty', {
      code: 'incomplete',
      commitState: 'unchanged',
    });
    const failure = await releaseRestoreLock(
      { release: async () => Promise.reject(new Error('release failed')) },
      'test storage',
      'unknown',
      primary,
    );

    expect(failure).toMatchObject({
      code: 'incomplete',
      commitState: 'unchanged',
    });
    expect(failure).toHaveProperty(
      'message',
      expect.stringContaining('ownership release also failed'),
    );
  });
});
