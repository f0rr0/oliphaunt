import { describe, expect, it } from 'vitest';

import { parseQueryResponse } from '../query.js';

describe('query response parsing', () => {
  it('keeps row values as zero-copy views into the transferred response', () => {
    const response = concatenate(
      backendMessage('T', rowDescription('answer')),
      backendMessage('D', dataRow('42')),
      backendMessage('C', cString('SELECT 1')),
      backendMessage('Z', Uint8Array.of('I'.charCodeAt(0))),
    );

    const result = parseQueryResponse(response);

    expect(result.getText(0, 'answer')).toBe('42');
    expect(result.rows[0]?.values[0]?.buffer).toBe(response.buffer);
  });

  it('retains precise diagnostics for malformed UTF-8 off the hot path', () => {
    const malformedDescription = concatenate(Uint8Array.of(0, 1, 0xc0, 0), new Uint8Array(18));

    expect(() => parseQueryResponse(backendMessage('T', malformedDescription))).toThrow(
      'field name is not valid UTF-8 at byte 0',
    );
  });
});

function rowDescription(name: string): Uint8Array {
  return concatenate(
    Uint8Array.of(0, 1),
    cString(name),
    Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 0, 4, 0xff, 0xff, 0xff, 0xff, 0, 0),
  );
}

function dataRow(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const body = new Uint8Array(bytes.length + 6);
  body[1] = 1;
  new DataView(body.buffer).setUint32(2, bytes.length);
  body.set(bytes, 6);
  return body;
}

function backendMessage(tag: string, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.length + 5);
  result[0] = tag.charCodeAt(0);
  new DataView(result.buffer).setUint32(1, body.length + 4);
  result.set(body, 5);
  return result;
}

function cString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes);
  return result;
}

function concatenate(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
