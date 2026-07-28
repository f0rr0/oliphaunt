import type { BackupFormat } from '../types.js';
import type { ByteStream } from './byte-stream.js';

const MAGIC = new Uint8Array([0x50, 0x47, 0x4f, 0x42]);
const HEADER_LEN = 13;
const MAX_FRAME_LEN = 128 * 1024 * 1024;

export type BrokerRequestFrame =
  | { kind: 'authenticate'; token: string }
  | { kind: 'execProtocol'; bytes: Uint8Array }
  | { kind: 'execSimpleQuery'; sql: string }
  | { kind: 'checkpoint' }
  | { kind: 'close' }
  | { kind: 'execProtocolStream'; bytes: Uint8Array }
  | { kind: 'backup'; format: BackupFormat }
  | { kind: 'cancel' };

export type BrokerResponseFrame =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'error'; message: string }
  | { kind: 'chunk'; bytes: Uint8Array };

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

export function encodeBrokerRequest(frame: BrokerRequestFrame): Uint8Array {
  switch (frame.kind) {
    case 'authenticate':
      return encodeFrame(6, encodeUtf8(frame.token));
    case 'execProtocol':
      return encodeFrame(1, frame.bytes);
    case 'execSimpleQuery':
      return encodeFrame(8, encodeUtf8(frame.sql));
    case 'checkpoint':
      return encodeFrame(2, emptyPayload);
    case 'close':
      return encodeFrame(3, emptyPayload);
    case 'execProtocolStream':
      return encodeFrame(4, frame.bytes);
    case 'backup':
      return encodeFrame(5, new Uint8Array([encodeBackupFormat(frame.format)]));
    case 'cancel':
      return encodeFrame(7, emptyPayload);
  }
}

export function encodeBrokerResponse(frame: BrokerResponseFrame): Uint8Array {
  switch (frame.kind) {
    case 'ok':
      return encodeFrame(101, frame.bytes);
    case 'error':
      return encodeFrame(102, encodeUtf8(frame.message));
    case 'chunk':
      return encodeFrame(103, frame.bytes);
  }
}

export function decodeBrokerRequest(kind: number, payload: Uint8Array): BrokerRequestFrame {
  switch (kind) {
    case 6:
      return { kind: 'authenticate', token: decodeUtf8(payload, 'broker auth frame') };
    case 1:
      return { kind: 'execProtocol', bytes: payload };
    case 8:
      return { kind: 'execSimpleQuery', sql: decodeUtf8(payload, 'broker simple-query frame') };
    case 2:
      assertEmptyPayload(payload);
      return { kind: 'checkpoint' };
    case 3:
      assertEmptyPayload(payload);
      return { kind: 'close' };
    case 4:
      return { kind: 'execProtocolStream', bytes: payload };
    case 5:
      return { kind: 'backup', format: decodeBackupFormat(payload) };
    case 7:
      assertEmptyPayload(payload);
      return { kind: 'cancel' };
    default:
      throw new Error(`unknown broker request frame ${kind}`);
  }
}

export function decodeBrokerResponse(kind: number, payload: Uint8Array): BrokerResponseFrame {
  switch (kind) {
    case 101:
      return { kind: 'ok', bytes: payload };
    case 102:
      return { kind: 'error', message: decodeUtf8(payload, 'broker error frame') };
    case 103:
      return { kind: 'chunk', bytes: payload };
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

function encodeBackupFormat(format: BackupFormat): number {
  switch (format) {
    case 'sql':
      return 1;
    case 'physicalArchive':
      return 2;
    case 'oliphauntArchive':
      return 3;
  }
}

function decodeBackupFormat(payload: Uint8Array): BackupFormat {
  if (payload.length === 0) {
    throw new Error('broker backup request frame is missing a format');
  }
  if (payload.length > 1) {
    throw new Error('broker backup request frame unexpectedly had extra payload');
  }
  switch (payload[0]) {
    case 1:
      return 'sql';
    case 2:
      return 'physicalArchive';
    case 3:
      return 'oliphauntArchive';
    default:
      throw new Error(`unknown broker backup format ${payload[0]}`);
  }
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
