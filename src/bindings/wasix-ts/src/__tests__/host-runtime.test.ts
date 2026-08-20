import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostRuntime, hostRuntimeName } from '../host-runtime.js';

afterEach(() => vi.unstubAllGlobals());

describe('WASIX JavaScript host identity', () => {
  it('uses explicit runtime globals and stable diagnostic names', () => {
    vi.stubGlobal('Bun', {});
    expect(hostRuntime()).toBe('bun');
    expect(hostRuntimeName()).toBe('Bun');

    vi.stubGlobal('Bun', undefined);
    vi.stubGlobal('Deno', {});
    expect(hostRuntime()).toBe('deno');
    expect(hostRuntimeName()).toBe('Deno');

    vi.stubGlobal('Deno', undefined);
    expect(hostRuntime()).toBe('node');
    expect(hostRuntimeName()).toBe('Node');
  });
});
