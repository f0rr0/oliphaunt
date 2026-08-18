export type TransferableBytes = Readonly<{
  value: Uint8Array;
  transfer: readonly ArrayBuffer[];
}>;

/** @internal Never transfer unrelated bytes from a larger backing buffer. */
export function prepareTransferableBytes(value: Uint8Array): TransferableBytes {
  if (!(value.buffer instanceof ArrayBuffer)) {
    return { value, transfer: [] };
  }
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return { value, transfer: [value.buffer] };
  }
  const exact = value.slice();
  return { value: exact, transfer: [exact.buffer] };
}
