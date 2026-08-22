import { describe, expect, it } from 'vitest';

import { extendedQuery, parseQueryResponse } from '../query.js';

// liboliphaunt-doc-example:wasix-typescript-query
describe('WASIX query protocol codec', () => {
  it('writes the exact PostgreSQL extended-query packet', () => {
    const packet = extendedQuery('SELECT $1::text, $2::bytea, $3::bool', [
      { format: 'text', value: 'hé' },
      { format: 'binary', value: Uint8Array.of(0, 255, 1) },
      true,
    ]);

    expect(Buffer.from(packet).toString('hex')).toBe(
      '500000002c0053454c4543542024313a3a746578742c2024323a3a62797465612c2024333a3a626f6f6c000000' +
        '420000002a0000000300000001000000030000000368c3a90000000300ff01000000047472756500010000' +
        '44000000065000450000000900000000005300000004',
    );
  });

  it('writes large binary parameters without argument spreading', () => {
    const value = new Uint8Array(256 * 1024).fill(0xab);
    const packet = extendedQuery('SELECT $1::bytea', [{ format: 'binary', value }]);
    const messages = frontendMessages(packet);

    expect(messages.map(({ tag }) => tag)).toEqual(['P', 'B', 'D', 'E', 'S']);
    const bind = messages[1]?.body;
    if (bind === undefined) throw new Error('extended query omitted Bind');
    const parameterLengthOffset = 2 + 2 + 2 + 2;
    expect(readU32(bind, parameterLengthOffset)).toBe(value.length);
    expect(
      bind.subarray(parameterLengthOffset + 4, parameterLengthOffset + 4 + value.length),
    ).toEqual(value);
  });

  it('parses integers without copies and keeps row values as response views', () => {
    const response = queryResponse(new TextEncoder().encode('λ-value'));
    const result = parseQueryResponse(response);

    expect(result.fields).toEqual([
      {
        name: 'value',
        tableOid: 0x01020304,
        tableAttribute: -2,
        typeOid: 25,
        typeSize: -1,
        typeModifier: -1,
        format: 'text',
      },
    ]);
    expect(result.getText(0, 'value')).toBe('λ-value');
    expect(result.rows[0]?.values[0]?.buffer).toBe(response.buffer);
  });

  it('retains exact invalid UTF-8 field-name byte-offset diagnostics', () => {
    const malformedDescription = concatenate(Uint8Array.of(0, 1, 0xc0, 0), new Uint8Array(18));

    expect(() => parseQueryResponse(backendMessage('T', malformedDescription))).toThrow(
      'field name is not valid UTF-8 at byte 0',
    );
  });

  it('retains exact invalid UTF-8 row-value byte-offset diagnostics', () => {
    const result = parseQueryResponse(queryResponse(Uint8Array.of(0x61, 0xe2, 0x28, 0xa1)));

    expect(() => result.rows[0]?.text(0)).toThrow('query value is not valid UTF-8 at byte 2');
  });

  it('retains truncated integer and body diagnostics', () => {
    expect(() => parseQueryResponse(Uint8Array.of(0x54, 0, 0))).toThrow(
      'truncated backend message length',
    );
    expect(() => parseQueryResponse(Uint8Array.of(0x54, 0, 0, 0, 6, 0))).toThrow(
      'truncated backend message body',
    );
  });
});

function frontendMessages(packet: Uint8Array): Array<{ tag: string; body: Uint8Array }> {
  const messages: Array<{ tag: string; body: Uint8Array }> = [];
  let offset = 0;
  while (offset < packet.length) {
    const length = readU32(packet, offset + 1);
    messages.push({
      tag: String.fromCharCode(packet[offset] ?? 0),
      body: packet.subarray(offset + 5, offset + 1 + length),
    });
    offset += length + 1;
  }
  return messages;
}

function queryResponse(value: Uint8Array): Uint8Array {
  const fieldName = new TextEncoder().encode('value');
  const rowDescription = new Uint8Array(2 + fieldName.length + 1 + 4 + 2 + 4 + 2 + 4 + 2);
  const rowView = new DataView(
    rowDescription.buffer,
    rowDescription.byteOffset,
    rowDescription.byteLength,
  );
  let offset = 0;
  rowView.setInt16(offset, 1);
  offset += 2;
  rowDescription.set(fieldName, offset);
  offset += fieldName.length;
  rowDescription[offset] = 0;
  offset += 1;
  rowView.setUint32(offset, 0x01020304);
  offset += 4;
  rowView.setInt16(offset, -2);
  offset += 2;
  rowView.setUint32(offset, 25);
  offset += 4;
  rowView.setInt16(offset, -1);
  offset += 2;
  rowView.setInt32(offset, -1);
  offset += 4;
  rowView.setInt16(offset, 0);

  const dataRow = new Uint8Array(2 + 4 + value.length);
  const dataView = new DataView(dataRow.buffer, dataRow.byteOffset, dataRow.byteLength);
  dataView.setInt16(0, 1);
  dataView.setInt32(2, value.length);
  dataRow.set(value, 6);

  return concatenate(
    backendMessage('T', rowDescription),
    backendMessage('D', dataRow),
    backendMessage('C', new TextEncoder().encode('SELECT 1\0')),
    backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
  );
}

function backendMessage(tag: string, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(body.length + 5);
  message[0] = tag.charCodeAt(0);
  new DataView(message.buffer).setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
