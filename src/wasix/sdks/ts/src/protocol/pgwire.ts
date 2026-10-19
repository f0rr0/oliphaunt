import { assertSuccessfulQueryResponse } from './query.js';

const encoder = new TextEncoder();

export function startupPacket(username: string, database: string): Uint8Array {
  assertStartupValue('username', username);
  assertStartupValue('database', database);

  const body: number[] = [];
  pushI32(body, 196_608);
  pushCString(body, 'user');
  pushCString(body, username);
  pushCString(body, 'database');
  pushCString(body, database);
  pushCString(body, 'client_encoding');
  pushCString(body, 'UTF8');
  pushCString(body, 'DateStyle');
  pushCString(body, 'ISO, MDY');
  pushCString(body, 'TimeZone');
  pushCString(body, 'UTC');
  body.push(0);

  const packet: number[] = [];
  pushI32(packet, body.length + 4);
  packet.push(...body);
  return Uint8Array.from(packet);
}

/** Validate the first PostgreSQL startup exchange before settling the host loop. */
export function assertSuccessfulStartupResponse(response: Uint8Array): void {
  let offset = 0;
  let sawAuthenticationOk = false;
  let sawReady = false;
  while (offset < response.length) {
    if (response.length - offset < 5) {
      throw new Error('PostgreSQL startup response ended inside a backend message header');
    }
    const tag = response[offset] ?? 0;
    const bodyLength = readI32(response, offset + 1);
    if (bodyLength < 4) {
      throw new Error(`invalid PostgreSQL startup message length ${bodyLength}`);
    }
    const messageLength = bodyLength + 1;
    if (offset + messageLength > response.length) {
      throw new Error('PostgreSQL startup response ended inside a backend message');
    }
    if (tag === 'E'.charCodeAt(0)) {
      // Reuse the shared pgwire error decoder so startup and query failures
      // expose the same PostgresError/SQLSTATE contract.
      const ready = Uint8Array.of('Z'.charCodeAt(0), 0, 0, 0, 5, 'I'.charCodeAt(0));
      const withReady = concatenate(
        [response.slice(offset, offset + messageLength), ready],
        messageLength + ready.length,
      );
      // Imported lazily would obscure the synchronous error contract. Keep
      // the parser dependency at module scope through this helper below.
      throwStartupPostgresError(withReady);
    }
    if (tag === 'R'.charCodeAt(0)) {
      if (bodyLength !== 8 || readI32(response, offset + 5) !== 0) {
        throw new Error('Oliphaunt WASIX supports only PostgreSQL AuthenticationOk startup');
      }
      sawAuthenticationOk = true;
    }
    if (tag === 'Z'.charCodeAt(0)) {
      if (bodyLength !== 5) {
        throw new Error('invalid PostgreSQL ReadyForQuery startup message');
      }
      sawReady = true;
      if (offset + messageLength !== response.length) {
        throw new Error('PostgreSQL startup returned bytes after ReadyForQuery');
      }
    }
    offset += messageLength;
  }
  if (!sawAuthenticationOk || !sawReady) {
    throw new Error('PostgreSQL startup response omitted AuthenticationOk or ReadyForQuery');
  }
}

function throwStartupPostgresError(response: Uint8Array): never {
  assertSuccessfulQueryResponse(response);
  throw new Error('PostgreSQL startup ErrorResponse was not rejected');
}

function assertStartupValue(label: string, value: string): void {
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
}

function pushCString(output: number[], value: string): void {
  output.push(...encoder.encode(value), 0);
}

function pushI32(output: number[], value: number): void {
  output.push((value >>> 24) & 0xff);
  output.push((value >>> 16) & 0xff);
  output.push((value >>> 8) & 0xff);
  output.push(value & 0xff);
}

function readI32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function concatenate(chunks: ReadonlyArray<Uint8Array>, totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
