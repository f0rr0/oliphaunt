import { afterEach, describe, expect, it, vi } from 'vitest';

const frame = Uint8Array.of(
  40,
  181,
  47,
  253,
  32,
  19,
  153,
  0,
  0,
  111,
  108,
  105,
  112,
  104,
  97,
  117,
  110,
  116,
  45,
  122,
  115,
  116,
  100,
  45,
  116,
  101,
  115,
  116,
);

afterEach(() => vi.resetModules());

describe('WASIX zstd decompression', () => {
  it('uses the portable fallback by default', async () => {
    const { decompressZstd } = await import('../zstd.js');

    expect(new TextDecoder().decode(decompressZstd(frame))).toBe('oliphaunt-zstd-test');
  });

  it('selects one installed host decompressor', async () => {
    const { decompressZstd, installZstdDecompressor } = await import('../zstd.js');
    const output = Uint8Array.of(4, 2);
    const host = vi.fn(() => output);

    installZstdDecompressor(host);

    expect(decompressZstd(frame)).toBe(output);
    expect(host).toHaveBeenCalledWith(frame);
    expect(() => installZstdDecompressor(host)).toThrow('already installed');
  });

  it('propagates host decoding failures without retrying', async () => {
    const { decompressZstd, installZstdDecompressor } = await import('../zstd.js');
    const failure = new Error('invalid native frame');
    installZstdDecompressor(() => {
      throw failure;
    });

    expect(() => decompressZstd(frame)).toThrow(failure);
  });
});
