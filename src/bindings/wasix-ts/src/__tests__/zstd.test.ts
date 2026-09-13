import { expect, it } from 'vitest';
import { decompressIfNeeded } from '../archive.js';

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

it('decompresses zstd archive bytes with the portable decoder', () => {
  expect(new TextDecoder().decode(decompressIfNeeded(frame))).toBe('oliphaunt-zstd-test');
});
