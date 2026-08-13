import { describe, expect, it, vi } from 'vitest';

import { nodeZstdDecompressor } from '../node-zstd.js';

describe('Node zstd adapter', () => {
  it('leaves older Node versions on the portable fallback', () => {
    expect(nodeZstdDecompressor(undefined, {})).toBeUndefined();
    expect(nodeZstdDecompressor('not a function', {})).toBeUndefined();
  });

  it('preserves native byte output and receiver', () => {
    const receiver = {};
    const output = new Uint8Array(Uint8Array.of(4, 2).buffer, 1, 1);
    const native = vi.fn(function (this: object) {
      expect(this).toBe(receiver);
      return output;
    });

    expect(nodeZstdDecompressor(native, receiver)?.(Uint8Array.of(1))).toBe(output);
  });

  it('fails closed for invalid output and native errors', () => {
    expect(() => nodeZstdDecompressor(() => 'bytes', {})?.(Uint8Array.of(1))).toThrow(
      'returned non-byte output',
    );
    const failure = new Error('corrupt frame');
    expect(() =>
      nodeZstdDecompressor(() => {
        throw failure;
      }, {})?.(Uint8Array.of(1)),
    ).toThrow(failure);
  });
});
