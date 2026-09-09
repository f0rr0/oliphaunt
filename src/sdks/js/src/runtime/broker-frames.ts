import type { ByteStream } from './byte-stream.js';

const MAGIC = new Uint8Array([0x50, 0x47, 0x4f, 0x42]);
const HEADER_LEN = 13;
const MAX_FRAME_LEN = 128 * 1024 * 1024;

export type BrokerRequestFrame =
  | { kind: 'authenticate'; token: string }
  | { kind: 'execProtocol'; bytes: Uint8Array }
  | { kind: 'execProtocolStream'; bytes: Uint8Array }
  | { kind: 'execSimpleQuery'; sql: string }
  | { kind: 'close' }
  | { kind: 'backup' }
  | { kind: 'cancel' };

export type BrokerResponseFrame =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'chunk'; bytes: Uint8Array }
  | { kind: 'error'; message: string }
  | { kind: 'streamCallbackAborted'; message: string };

export async function writeBrokerRequest(
  stream: ByteStream,
  frame: BrokerRequestFrame,
): Promise<void> {
  await stream.writeAll(encodeBrokerRequest(frame));
}

export async function readBrokerResponse(stream: ByteStream): Promise<BrokerResponseFrame> {
  const { kind, payload } = await readFrame(stream);
  return decodeBrokerResponse(kind, payload);
}

export function encodeBrokerRequest(frame: BrokerRequestFrame): Uint8Array {
  switch (frame.kind) {
    case 'authenticate':
      return encodeFrame(6, encodeUtf8(frame.token));
    case 'execProtocol':
      return encodeFrame(1, frame.bytes);
    case 'execProtocolStream':
      return encodeFrame(4, frame.bytes);
    case 'execSimpleQuery':
      return encodeFrame(8, encodeUtf8(frame.sql));
    case 'close':
      return encodeFrame(3, emptyPayload);
    case 'backup':
      return encodeFrame(5, emptyPayload);
    case 'cancel':
      return encodeFrame(7, emptyPayload);
  }
}

export function decodeBrokerResponse(kind: number, payload: Uint8Array): BrokerResponseFrame {
  switch (kind) {
    case 101:
      return { kind: 'ok', bytes: payload };
    case 102:
      return {
        kind: 'error',
        message: decodeUtf8(payload, 'broker error frame'),
      };
    case 103:
      return { kind: 'chunk', bytes: payload };
    case 104:
      return {
        kind: 'streamCallbackAborted',
        message: decodeUtf8(payload, 'broker stream callback-aborted frame'),
      };
    default:
      throw new Error(`unknown broker response frame ${kind}`);
  }
}

async function readFrame(stream: ByteStream): Promise<{ kind: number; payload: Uint8Array }> {
  const header = await stream.readExactly(HEADER_LEN);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (header[i] !== MAGIC[i]) {
      throw new Error('broker frame magic mismatch');
    }
  }
  const kind = header[4];
  if (kind === undefined) {
    throw new Error('broker frame header is missing a kind byte');
  }
  const length = Number(new DataView(header.buffer, header.byteOffset + 5, 8).getBigUint64(0));
  if (length > MAX_FRAME_LEN) {
    throw new Error(`broker frame payload length ${length} exceeds limit ${MAX_FRAME_LEN}`);
  }
  return { kind, payload: await stream.readExactly(length) };
}

function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_LEN) {
    throw new Error(`broker frame payload length ${payload.length} exceeds limit ${MAX_FRAME_LEN}`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out.set(MAGIC, 0);
  out[4] = kind;
  new DataView(out.buffer, out.byteOffset + 5, 8).setBigUint64(0, BigInt(payload.length));
  out.set(payload, HEADER_LEN);
  return out;
}

const emptyPayload = new Uint8Array();
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function encodeUtf8(value: string): Uint8Array {
  return utf8.encode(value);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return strictUtf8.decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not UTF-8: ${String(error)}`);
  }
}
