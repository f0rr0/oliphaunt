import { describe, expect, it } from 'vitest';

import {
  binary,
  extendedQuery,
  parseDescribeResponse,
  parseExecResponse,
  parseQueryRawResponse,
  parseSimpleQueryRawResponse,
  postgresOids,
  text,
} from '../query.js';

// liboliphaunt-doc-example:wasix-typescript-query
describe('WASIX query protocol codec', () => {
  it('writes the exact PostgreSQL extended-query packet', () => {
    const packet = extendedQuery('SELECT $1::text, $2::bytea, $3::bool', [
      text('hé', postgresOids.text),
      binary(Uint8Array.of(0, 255, 1), postgresOids.bytea),
      text(true, postgresOids.bool),
    ]);

    expect(Buffer.from(packet).toString('hex')).toBe(
      '50000000380053454c4543542024313a3a746578742c2024323a3a62797465612c2024333a3a626f6f6c000003000000190000001100000010' +
        '420000002a0000000300000001000000030000000368c3a90000000300ff01000000047472756500010000' +
        '44000000065000450000000900000000005300000004',
    );
  });

  it('writes large binary parameters without argument spreading', () => {
    const value = new Uint8Array(256 * 1024).fill(0xab);
    const packet = extendedQuery('SELECT $1::bytea', [binary(value, postgresOids.bytea)]);
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
    const result = parseSimpleQueryRawResponse(response);

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

    expect(() => parseSimpleQueryRawResponse(backendMessage('T', malformedDescription))).toThrow(
      'field name is not valid UTF-8 at byte 0',
    );
  });

  it('retains exact invalid UTF-8 row-value byte-offset diagnostics', () => {
    const result = parseSimpleQueryRawResponse(
      queryResponse(Uint8Array.of(0x61, 0xe2, 0x28, 0xa1)),
    );

    expect(() => result.rows[0]?.text(0)).toThrow('query value is not valid UTF-8 at byte 2');
  });

  it('retains truncated integer and body diagnostics', () => {
    expect(() => parseSimpleQueryRawResponse(Uint8Array.of(0x54, 0, 0))).toThrow(
      'truncated backend message length',
    );
    expect(() => parseSimpleQueryRawResponse(Uint8Array.of(0x54, 0, 0, 0, 6, 0))).toThrow(
      'truncated backend message body',
    );
  });

  it('rejects incomplete and out-of-order completions while exec admits empty statements', () => {
    const ready = backendMessage('Z', Uint8Array.of('I'.charCodeAt(0)));
    expect(() => parseSimpleQueryRawResponse(ready)).toThrow(
      'omitted CommandComplete or EmptyQueryResponse',
    );
    expect(() =>
      parseSimpleQueryRawResponse(
        concatenate(
          backendMessage('C', new TextEncoder().encode('SELECT 1\0')),
          backendMessage('D', Uint8Array.of(0, 0)),
          ready,
        ),
      ),
    ).toThrow('DataRow arrived after statement completion');
    expect(() =>
      parseDescribeResponse(
        concatenate(
          backendMessage('t', Uint8Array.of(0, 0)),
          backendMessage('n', new Uint8Array()),
          ready,
        ),
      ),
    ).toThrow(/before ParseComplete|omitted ParseComplete/);

    const result = parseExecResponse(
      concatenate(
        backendMessage('C', new TextEncoder().encode('UPDATE 1\0')),
        backendMessage('I', new Uint8Array()),
        backendMessage('C', new TextEncoder().encode('DELETE 2\0')),
        ready,
      ),
    );
    expect(result.statements.map((statement) => statement.commandTag)).toEqual([
      'UPDATE 1',
      'DELETE 2',
    ]);

    for (const completion of [
      backendMessage('C', new TextEncoder().encode('UPDATE 1\0')),
      backendMessage('I', new Uint8Array()),
    ]) {
      expect(() => parseQueryRawResponse(concatenate(completion, ready))).toThrow(
        'before the extended-query result description',
      );
    }
    expect(() =>
      parseQueryRawResponse(
        concatenate(
          backendMessage('2', new Uint8Array()),
          backendMessage('n', new Uint8Array()),
          backendMessage('C', new TextEncoder().encode('UPDATE 1\0')),
          ready,
        ),
      ),
    ).toThrow('BindComplete arrived before ParseComplete');
    expect(() =>
      parseExecResponse(
        concatenate(
          backendMessage('1', new Uint8Array()),
          backendMessage('C', new TextEncoder().encode('UPDATE 1\0')),
          ready,
        ),
      ),
    ).toThrow('simple-query response contained ParseComplete');
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
