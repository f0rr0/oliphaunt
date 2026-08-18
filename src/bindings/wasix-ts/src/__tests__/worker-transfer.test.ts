import { describe, expect, it } from 'vitest';

import { prepareTransferableBytes } from '../worker-transfer.js';

describe('WASIX worker response transfer', () => {
  it('copies a subarray into an exact transferable buffer', () => {
    const backing = Uint8Array.of(1, 2, 3, 4);
    const response = prepareTransferableBytes(backing.subarray(1, 3));

    expect(response.value).toEqual(Uint8Array.of(2, 3));
    expect(response.value.byteOffset).toBe(0);
    expect(response.value.buffer.byteLength).toBe(2);
    expect(response.value.buffer).not.toBe(backing.buffer);
    expect(response.transfer).toEqual([response.value.buffer]);
  });

  it('reuses an already exact ArrayBuffer-backed view', () => {
    const value = Uint8Array.of(1, 2, 3);
    const response = prepareTransferableBytes(value);

    expect(response.value).toBe(value);
    expect(response.transfer).toEqual([value.buffer]);
  });
});
