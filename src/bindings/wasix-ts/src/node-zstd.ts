import type { ZstdDecompressor } from './zstd.js';

/** @internal Adapts Node's optional experimental zstd API without linking it by name. */
export function nodeZstdDecompressor(
  candidate: unknown,
  receiver: object,
): ZstdDecompressor | undefined {
  if (typeof candidate !== 'function') return undefined;
  return (bytes) => {
    const output: unknown = Reflect.apply(candidate, receiver, [bytes]);
    if (!(output instanceof Uint8Array)) {
      throw new TypeError('Node zstd decompressor returned non-byte output');
    }
    return output;
  };
}
