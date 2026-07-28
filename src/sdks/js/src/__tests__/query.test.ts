import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  PostgresError,
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  toUint8Array,
} from '../query.js';

test('extendedQuery serializes text, binary, and null parameters', () => {
  const bytes = extendedQuery('SELECT $1, $2, $3', [
    'text',
    null,
    { format: 'binary', value: new Uint8Array([1, 2, 3]) },
  ]);
  const messages = splitFrontendMessages(bytes);

  assert.deepEqual(
    messages.map((message) => message.tag),
    [0x50, 0x42, 0x44, 0x45, 0x53],
  );
  assert.equal(new TextDecoder().decode(messages[0]!.body).includes('SELECT $1, $2, $3'), true);

  const bind = messages[1]!.body;
  assert.deepEqual([...bind.slice(0, 2)], [0, 0], 'portal and statement names are empty');
  assert.equal(readI16(bind, 2), 3, 'three parameter format codes');
  assert.deepEqual([readI16(bind, 4), readI16(bind, 6), readI16(bind, 8)], [0, 0, 1]);
  assert.equal(readI16(bind, 10), 3, 'three parameter values');
  assert.equal(readI32(bind, 12), 4);
  assert.equal(new TextDecoder().decode(bind.slice(16, 20)), 'text');
  assert.equal(readI32(bind, 20), -1);
  assert.equal(readI32(bind, 24), 3);
  assert.deepEqual([...bind.slice(28, 31)], [1, 2, 3]);
});

test('extendedQuery rejects invalid frontend inputs', () => {
  assert.throws(() => extendedQuery('SELECT \0', []), /SQL must not contain NUL/);
  assert.throws(
    () => extendedQuery('SELECT 1', new Array(0x8000).fill(null)),
    /at most 32767 parameters/,
  );

  const view = new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
  assert.deepEqual([...toUint8Array(view)], [8, 7]);
  assert.deepEqual([...toUint8Array([4, 5, 6])], [4, 5, 6]);
});

test('parseQueryResponse validates result ordering and accessors', () => {
  const result = parseQueryResponse(
    Uint8Array.from([
      ...backend(0x53, [...cstring('server_version'), ...cstring('18.4')]),
      ...backend(0x54, rowDescription([{ name: 'value', format: 0 }])),
      ...backend(0x44, dataRow(['hello'])),
      ...backend(0x43, cstring('SELECT 1')),
      ...backend(0x5a, [0x49]),
    ]),
  );

  assert.equal(result.rowCount, 1);
  assert.equal(result.commandTag, 'SELECT 1');
  assert.equal(result.fieldIndex('value'), 0);
  assert.equal(result.getText(0, 'value'), 'hello');
  assert.throws(() => result.getText(0, 'missing'), /no column/);
  assert.throws(() => result.getText(3, 'value'), /no row/);
  assert.throws(() => result.rows[0]!.text(99), /no column/);
});

test('parseQueryResponse surfaces PostgreSQL errors and malformed backend traffic', () => {
  const error = thrownBy(() =>
    parseQueryResponse(
      Uint8Array.from([
        ...backend(0x45, [
          0x53,
          ...cstring('ERROR'),
          0x43,
          ...cstring('42601'),
          0x4d,
          ...cstring('syntax error'),
          0,
        ]),
      ]),
    ),
  );
  assert.ok(error instanceof PostgresError);
  assert.equal(error.severity, 'ERROR');
  assert.equal(error.sqlstate, '42601');
  assert.equal(error.postgresMessage, 'syntax error');
  assert.match(error.message, /ERROR \[42601\]: syntax error/);

  assert.throws(() => parseQueryResponse(Uint8Array.from([0x5a, 0, 0, 0, 3])), /length 3/);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from([...backend(0x44, dataRow(['orphan']))])),
    /before RowDescription/,
  );
  assert.throws(
    () =>
      parseQueryResponse(
        Uint8Array.from([
          ...backend(0x54, rowDescription([{ name: 'one', format: 0 }])),
          ...backend(0x54, rowDescription([{ name: 'two', format: 0 }])),
          ...backend(0x5a, [0x49]),
        ]),
      ),
    /multiple result sets/,
  );
  assert.throws(() => parseQueryResponse(Uint8Array.from([...backend(0x47, [])])), /COPY/);
  assert.throws(() => parseQueryResponse(Uint8Array.from([...backend(0x99, [])])), /0x99/);
  assert.throws(
    () => parseQueryResponse(Uint8Array.from([...backend(0x5a, [0x00])])),
    /invalid transaction status/,
  );
  assert.throws(
    () => parseQueryResponse(Uint8Array.from([...backend(0x5a, [0x49]), ...backend(0x49, [])])),
    /bytes after ReadyForQuery/,
  );
  assert.throws(
    () => parseQueryResponse(Uint8Array.from([...backend(0x49, [])])),
    /before ReadyForQuery/,
  );
});

test('assertSuccessfulQueryResponse and row decoding reject invalid payloads', () => {
  assertSuccessfulQueryResponse(
    Uint8Array.from([...backend(0x43, cstring('CREATE 1')), ...backend(0x5a, [0x49])]),
  );
  assert.throws(
    () => assertSuccessfulQueryResponse(Uint8Array.from([...backend(0x5a, [0x49, 0])])),
    /ReadyForQuery contained 2 bytes/,
  );
  assert.throws(
    () =>
      assertSuccessfulQueryResponse(
        Uint8Array.from([...backend(0x45, [0x4d, ...cstring('boom'), 0])]),
      ),
    PostgresError,
  );

  const result = parseQueryResponse(
    Uint8Array.from([
      ...backend(0x54, rowDescription([{ name: 'bad', format: 0 }])),
      ...backend(0x44, dataRow([new Uint8Array([0xff])])),
      ...backend(0x43, cstring('SELECT 1')),
      ...backend(0x5a, [0x49]),
    ]),
  );
  assert.throws(() => result.getText(0, 'bad'), /not valid UTF-8/);
});

type FrontendMessage = {
  tag: number;
  body: Uint8Array;
};

function splitFrontendMessages(bytes: Uint8Array): FrontendMessage[] {
  const messages: FrontendMessage[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset]!;
    const length = readI32(bytes, offset + 1);
    messages.push({ tag, body: bytes.slice(offset + 5, offset + 1 + length) });
    offset += 1 + length;
  }
  return messages;
}

function backend(tag: number, body: number[] | Uint8Array): number[] {
  return [tag, ...i32(body.length + 4), ...body];
}

function rowDescription(fields: Array<{ name: string; format: number }>): number[] {
  return [
    ...i16(fields.length),
    ...fields.flatMap((field) => [
      ...cstring(field.name),
      ...i32(0),
      ...i16(0),
      ...i32(25),
      ...i16(-1),
      ...i32(-1),
      ...i16(field.format),
    ]),
  ];
}

function dataRow(values: Array<string | Uint8Array | null>): number[] {
  return [
    ...i16(values.length),
    ...values.flatMap((value) => {
      if (value === null) {
        return i32(-1);
      }
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      return [...i32(bytes.byteLength), ...bytes];
    }),
  ];
}

function cstring(value: string): number[] {
  return [...new TextEncoder().encode(value), 0];
}

function i16(value: number): number[] {
  const bits = value & 0xffff;
  return [(bits >>> 8) & 0xff, bits & 0xff];
}

function i32(value: number): number[] {
  const bits = value >>> 0;
  return [(bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff];
}

function readI16(bytes: Uint8Array, offset: number): number {
  const value = (bytes[offset]! << 8) | bytes[offset + 1]!;
  return value > 0x7fff ? value - 0x10000 : value;
}

function readI32(bytes: Uint8Array, offset: number): number {
  const value =
    (bytes[offset]! * 0x1000000 +
      (bytes[offset + 1]! << 16) +
      (bytes[offset + 2]! << 8) +
      bytes[offset + 3]!) >>>
    0;
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected function to throw');
}
