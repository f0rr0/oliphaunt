import { describe, expect, it } from 'vitest';

import { resolveExecutionMode } from '../open-options.js';

// liboliphaunt-doc-example:wasix-typescript-direct-placement
describe('WASIX execution selection', () => {
  it('keeps worker isolation as the default', () => {
    expect(resolveExecutionMode({})).toBe('worker');
    expect(resolveExecutionMode({ execution: 'direct' })).toBe('direct');
  });

  it('rejects invalid JavaScript values before opening a host', () => {
    expect(() => resolveExecutionMode({ execution: 'main-thread' } as never)).toThrowError(
      /execution must be "direct" or "worker"/,
    );
  });
});
