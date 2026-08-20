import { describe, expect, it } from 'vitest';

import { assertSuccessfulStartupResponse, startupPacket } from '../pgwire.js';
import { PostgresError } from '../query.js';

describe('direct PostgreSQL startup protocol', () => {
  it('encodes a normal PostgreSQL startup packet', () => {
    const packet = startupPacket('postgres', 'postgres');
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

    expect(view.getUint32(0)).toBe(packet.length);
    expect(view.getUint32(4)).toBe(196_608);
    expect(new TextDecoder().decode(packet)).toContain('user\0postgres\0');
    expect(new TextDecoder().decode(packet)).toContain('DateStyle\0ISO, MDY\0TimeZone\0UTC\0');
  });

  it('accepts empty startup values and rejects only unencodable NUL bytes', () => {
    expect(() => startupPacket('', '  ')).not.toThrow();
    expect(() => startupPacket('bad\0user', 'postgres')).toThrow('must not contain NUL bytes');
  });

  it('accepts AuthenticationOk followed by ReadyForQuery', () => {
    expect(() => assertSuccessfulStartupResponse(backendResponse('RZ'))).not.toThrow();
  });

  it('preserves a startup ErrorResponse as PostgresError', () => {
    expect(() =>
      assertSuccessfulStartupResponse(backendError('3D000', 'database does not exist')),
    ).toThrowError(PostgresError);
    try {
      assertSuccessfulStartupResponse(backendError('3D000', 'database does not exist'));
    } catch (error) {
      expect(error).toMatchObject({
        severity: 'FATAL',
        sqlstate: '3D000',
        postgresMessage: 'database does not exist',
      });
    }
  });
});

function backendResponse(tags: string): Uint8Array {
  return [...tags]
    .map((tag) =>
      tag === 'Z'
        ? Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 5, 'I'.charCodeAt(0))
        : tag === 'R'
          ? Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 8, 0, 0, 0, 0)
          : Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 4),
    )
    .reduce(concatenate, new Uint8Array());
}

function backendError(sqlstate: string, message: string): Uint8Array {
  const body = new Uint8Array([
    0x53,
    ...new TextEncoder().encode('FATAL'),
    0,
    0x43,
    ...new TextEncoder().encode(sqlstate),
    0,
    0x4d,
    ...new TextEncoder().encode(message),
    0,
    0,
  ]);
  const result = new Uint8Array(body.length + 5);
  result[0] = 'E'.charCodeAt(0);
  new DataView(result.buffer).setUint32(1, body.length + 4);
  result.set(body, 5);
  return result;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
