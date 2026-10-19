import type { ByteStream } from './byte-stream.js';

const MAGIC = new Uint8Array([0x50, 0x47, 0x4f, 0x42]);
const HEADER_LEN = 13;
const MAX_FRAME_LEN = 128 * 1024 * 1024;
const BACKUP_CHUNK_LEN = 64 * 1024;

export type BrokerRequestFrame =
  | { kind: 'authenticate'; token: string }
  | { kind: 'close' }
  | { kind: 'backup' }
  | { kind: 'backup-stream' }
  | { kind: 'cancel'; token: string; epoch: Uint8Array; request: bigint };

export type BrokerResponseFrame =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'error'; message: string };

export async function writeBrokerRequest(
  stream: ByteStream,
  frame: BrokerRequestFrame,
): Promise<void> {
  await stream.writeAll(encodeBrokerRequest(frame));
}

export async function readBrokerRequest(stream: ByteStream): Promise<BrokerRequestFrame> {
  const { kind, payload } = await readFrame(stream);
  return decodeBrokerRequest(kind, payload);
}

export async function writeBrokerResponse(
  stream: ByteStream,
  frame: BrokerResponseFrame,
): Promise<void> {
  await stream.writeAll(encodeBrokerResponse(frame));
}

export async function readBrokerResponse(stream: ByteStream): Promise<BrokerResponseFrame> {
  const { kind, payload } = await readFrame(stream);
  return decodeBrokerResponse(kind, payload);
}

export async function readBrokerBackup(
  stream: ByteStream,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ response: BrokerResponseFrame; destinationFailure?: { error: unknown } }> {
  let destinationFailure: { error: unknown } | undefined;
  for (;;) {
    const { kind, payload } = await readFrame(stream);
    if (kind === 103 && payload.length > 0) {
      if (destinationFailure === undefined) {
        try {
          await onChunk(payload);
        } catch (error) {
          destinationFailure = { error };
        }
      }
    } else if (kind === 102 || (kind === 101 && payload.length === 0)) {
      return { response: decodeBrokerResponse(kind, payload), destinationFailure };
    } else {
      throw new Error(`unexpected broker backup frame ${kind}`);
    }
  }
}

export function encodeBrokerRequest(frame: BrokerRequestFrame): Uint8Array {
  switch (frame.kind) {
    case 'authenticate':
      return encodeFrame(6, encodeUtf8(frame.token));
    case 'close':
      return encodeFrame(3, emptyPayload);
    case 'backup':
      return encodeFrame(5, emptyPayload);
    case 'backup-stream':
      return encodeFrame(7, emptyPayload);
    case 'cancel': {
      if (frame.epoch.length !== 16) throw new Error('invalid broker generation');
      const token = encodeUtf8(frame.token);
      const payload = new Uint8Array(24 + token.length);
      payload.set(frame.epoch);
      new DataView(payload.buffer).setBigUint64(16, frame.request);
      payload.set(token, 24);
      return encodeFrame(8, payload);
    }
  }
}

export function encodeBrokerResponse(frame: BrokerResponseFrame): Uint8Array {
  switch (frame.kind) {
    case 'ok':
      return encodeFrame(101, frame.bytes);
    case 'error':
      return encodeFrame(102, encodeUtf8(frame.message));
  }
}

export function decodeBrokerRequest(kind: number, payload: Uint8Array): BrokerRequestFrame {
  switch (kind) {
    case 6:
      return {
        kind: 'authenticate',
        token: decodeUtf8(payload, 'broker auth frame'),
      };
    case 3:
      assertEmptyPayload(payload);
      return { kind: 'close' };
    case 5:
      assertEmptyPayload(payload);
      return { kind: 'backup' };
    case 7:
      assertEmptyPayload(payload);
      return { kind: 'backup-stream' };
    case 8:
      if (payload.length < 24) throw new Error('invalid broker cancel frame');
      return {
        kind: 'cancel',
        token: decodeUtf8(payload.subarray(24), 'broker cancel credential'),
        epoch: payload.slice(0, 16),
        request: new DataView(payload.buffer, payload.byteOffset + 16, 8).getBigUint64(0),
      };
    default:
      throw new Error(`unknown broker request frame ${kind}`);
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
  const limit = kind === 103 ? BACKUP_CHUNK_LEN : MAX_FRAME_LEN;
  if (length > limit) {
    throw new Error(`broker frame payload length ${length} exceeds limit ${limit}`);
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

function assertEmptyPayload(payload: Uint8Array): void {
  if (payload.length > 0) {
    throw new Error('broker control frame unexpectedly had a payload');
  }
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

// Shared with the native mobile brokers: bounded raw exchange records, not PGWire messages.
export const BROKER_EXCHANGE_CHUNK_BYTES = 256 * 1024;
const EXCHANGE_HEADER_BYTES = 36;
export type BrokerExchangeKind = 1 | 2 | 3 | 4 | 5 | 6;
export type BrokerExchangeFrame = {
  kind: BrokerExchangeKind;
  epoch: Uint8Array;
  request: bigint;
  payload: Uint8Array;
};

export type BrokerCompletion = {
  reason:
    | 'success'
    | 'invalid-request'
    | 'cancelled'
    | 'deadline'
    | 'worker-interrupted'
    | 'transport'
    | 'database'
    | 'callback';
  execution: 'not-started' | 'completed' | 'unknown';
  requiresReopen: boolean;
  detail: string;
};

export function encodeBrokerExchangeFrame(frame: BrokerExchangeFrame): Uint8Array {
  validateExchangeLength(frame.kind, frame.payload.length);
  if (frame.epoch.length !== 16 || (frame.request === 0n && frame.kind !== 6))
    throw new Error('invalid broker exchange identity');
  const bytes = new Uint8Array(EXCHANGE_HEADER_BYTES + frame.payload.length);
  bytes.set([0x4f, 0x4c, 0x4d, 0x42]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1);
  bytes[6] = frame.kind;
  bytes.set(frame.epoch, 8);
  view.setBigUint64(24, frame.request);
  view.setUint32(32, frame.payload.length);
  bytes.set(frame.payload, EXCHANGE_HEADER_BYTES);
  return bytes;
}

export async function readBrokerExchangeFrame(stream: ByteStream): Promise<BrokerExchangeFrame> {
  const header = await stream.readExactly(EXCHANGE_HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (
    header[0] !== 0x4f ||
    header[1] !== 0x4c ||
    header[2] !== 0x4d ||
    header[3] !== 0x42 ||
    view.getUint16(4) !== 1 ||
    header[7] !== 0
  )
    throw new Error('incompatible broker exchange protocol');
  const kind = header[6] as BrokerExchangeKind;
  const length = view.getUint32(32);
  validateExchangeLength(kind, length);
  const request = view.getBigUint64(24);
  if (request === 0n && kind !== 6) throw new Error('invalid broker exchange request id');
  return { kind, epoch: header.slice(8, 24), request, payload: await stream.readExactly(length) };
}

export function decodeBrokerCompletion(payload: Uint8Array): BrokerCompletion {
  if (payload.length < 3 || payload.length > 1027) throw new Error('invalid broker terminal size');
  const reason = (
    [
      'success',
      'invalid-request',
      'cancelled',
      'deadline',
      'worker-interrupted',
      'transport',
      'database',
      'callback',
    ] as const
  )[payload[0]!];
  const execution = (['not-started', 'completed', 'unknown'] as const)[payload[1]!];
  if (reason === undefined || execution === undefined || (payload[2] !== 0 && payload[2] !== 1))
    throw new Error('invalid broker terminal result');
  const requiresReopen = payload[2] === 1;
  if (
    (reason === 'success' && (execution !== 'completed' || requiresReopen)) ||
    (execution === 'unknown' && !requiresReopen)
  )
    throw new Error('inconsistent broker terminal result');
  return {
    reason,
    execution,
    requiresReopen,
    detail: decodeUtf8(payload.subarray(3), 'broker terminal detail'),
  };
}

function validateExchangeLength(kind: BrokerExchangeKind, length: number): void {
  const valid =
    kind === 1 || kind === 2 || kind === 3
      ? length === 16
      : kind === 4
        ? length > 0 && length <= BROKER_EXCHANGE_CHUNK_BYTES
        : kind === 5
          ? length === 0
          : kind === 6
            ? length >= 3 && length <= 1027
            : false;
  if (!valid) throw new Error('invalid broker exchange record length');
}
