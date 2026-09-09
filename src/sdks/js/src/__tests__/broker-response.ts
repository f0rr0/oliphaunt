import type { BrokerResponseFrame } from '../runtime/broker-frames.js';

// Simulate the Rust broker's reply; the SDK only encodes requests and reads replies.
export function encodeBrokerResponse(frame: BrokerResponseFrame): Uint8Array {
  const kind = { ok: 101, error: 102, chunk: 103, streamCallbackAborted: 104 }[frame.kind];
  const payload =
    frame.kind === 'ok' || frame.kind === 'chunk'
      ? frame.bytes
      : new TextEncoder().encode(frame.message);
  const bytes = new Uint8Array(13 + payload.length);
  bytes.set([0x50, 0x47, 0x4f, 0x42, kind]);
  new DataView(bytes.buffer).setBigUint64(5, BigInt(payload.length));
  bytes.set(payload, 13);
  return bytes;
}
