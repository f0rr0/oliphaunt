import { describe, expect, it } from 'vitest';

import {
  assertSuccessfulStartupResponse,
  PgwireStream,
  startupPacket,
  terminatePacket,
} from '../pgwire.js';
import { PostgresError } from '../query.js';

describe('browser pgwire stream', () => {
  it('encodes a normal PostgreSQL startup packet', () => {
    const packet = startupPacket('postgres', 'postgres');
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

    expect(view.getUint32(0)).toBe(packet.length);
    expect(view.getUint32(4)).toBe(196_608);
    expect(new TextDecoder().decode(packet)).toContain('user\0postgres\0');
    expect(new TextDecoder().decode(packet)).toContain('DateStyle\0ISO, MDY\0TimeZone\0UTC\0');
  });

  it('collects arbitrarily chunked backend messages through ReadyForQuery', async () => {
    const response = Uint8Array.of(
      0x43,
      0,
      0,
      0,
      9,
      ...new TextEncoder().encode('OK 1'),
      0,
      0x5a,
      0,
      0,
      0,
      5,
      0x49,
    );
    const writes: Uint8Array[] = [];
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(response.slice(0, 3));
        controller.enqueue(response.slice(3, 11));
        controller.enqueue(response.slice(11));
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk.slice());
      },
    });
    const wire = new PgwireStream(readable, writable);
    const input = Uint8Array.of(1, 2, 3);

    await expect(wire.exchange(input)).resolves.toEqual(response);
    expect(writes).toEqual([input]);
  });

  it('reuses a contiguous stdout chunk for the completed response', async () => {
    const response = backendResponse('CZ');
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(response);
      },
    });
    const wire = new PgwireStream(readable, new WritableStream<Uint8Array>());

    const result = await wire.exchange(Uint8Array.of(1));

    expect(result).toEqual(response);
    expect(result.buffer).toBe(response.buffer);
  });

  it('retains a coalesced following response without slicing the unread tail', async () => {
    const first = backendResponse('CZ');
    const second = backendResponse('CZ');
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(concatenate(first, second));
      },
    });
    const wire = new PgwireStream(readable, new WritableStream<Uint8Array>());

    await expect(wire.exchange(Uint8Array.of(1))).resolves.toEqual(first);
    await expect(wire.exchange(Uint8Array.of(2))).resolves.toEqual(second);
  });

  it('collects a multi-message response across geometric buffer growth', async () => {
    const messages = [
      backendMessage('N', new Uint8Array(3 * 1024).fill(1)),
      backendMessage('N', new Uint8Array(5 * 1024).fill(2)),
      backendMessage('C', new Uint8Array(9 * 1024).fill(3)),
      backendResponse('Z'),
    ];
    const response = messages.reduce(concatenate, new Uint8Array());
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const message of messages) {
          controller.enqueue(message);
        }
      },
    });
    const wire = new PgwireStream(readable, new WritableStream<Uint8Array>());

    await expect(wire.exchange(Uint8Array.of(1))).resolves.toEqual(response);
  });

  it('uses the PostgreSQL Terminate message', () => {
    expect(terminatePacket()).toEqual(Uint8Array.of(0x58, 0, 0, 0, 4));
  });

  it('drains the standalone main-loop startup transition before the first query', async () => {
    const startup = backendResponse('RZ');
    const settled = backendResponse('SSZ');
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(concatenate(startup, settled));
      },
    });
    const writable = new WritableStream<Uint8Array>();
    const wire = new PgwireStream(readable, writable);

    const first = await wire.exchange(Uint8Array.of(1));
    expect(first).toEqual(startup);
    expect(() => assertSuccessfulStartupResponse(first)).not.toThrow();
    await expect(wire.settleStartup()).resolves.toBeUndefined();
  });

  it('stops at a startup ErrorResponse without requiring ReadyForQuery', async () => {
    const response = backendError('3D000', 'database does not exist');
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(response.slice(0, 7));
        controller.enqueue(response.slice(7));
        controller.close();
      },
    });
    const writes: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk.slice());
      },
    });
    const wire = new PgwireStream(readable, writable);

    const startup = await wire.startup(Uint8Array.of(1, 2, 3));
    expect(startup).toEqual(response);
    expect(writes).toEqual([Uint8Array.of(1, 2, 3)]);

    try {
      assertSuccessfulStartupResponse(startup);
      throw new Error('expected startup response to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresError);
      expect(error).toMatchObject({
        severity: 'FATAL',
        sqlstate: '3D000',
        postgresMessage: 'database does not exist',
      });
    }
  });
});

function backendResponse(tags: string): Uint8Array {
  const messages = [...tags].map((tag) =>
    tag === 'Z'
      ? Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 5, 'I'.charCodeAt(0))
      : tag === 'R'
        ? Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 8, 0, 0, 0, 0)
        : Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 4),
  );
  return messages.reduce(concatenate, new Uint8Array());
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
  return backendMessage('E', body);
}

function backendMessage(tag: string, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.length + 5);
  result[0] = tag.charCodeAt(0);
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
