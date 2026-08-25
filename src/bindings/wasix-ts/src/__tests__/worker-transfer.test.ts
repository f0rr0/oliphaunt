import { describe, expect, it } from 'vitest';

import { toolWorkerResponseTransfers } from '../tool-worker-common.js';
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

  it('transfers each owned tool output buffer exactly once', () => {
    const diagnostics = Uint8Array.of(1, 2, 3);

    expect(
      toolWorkerResponseTransfers({
        id: 1,
        ok: true,
        kind: 'completed',
        exitCode: 0,
        stdout: diagnostics,
        stderr: diagnostics.subarray(1),
      }),
    ).toEqual([diagnostics.buffer]);
    expect(toolWorkerResponseTransfers({ id: 1, ok: false, message: 'failed' })).toEqual([]);
  });
});
