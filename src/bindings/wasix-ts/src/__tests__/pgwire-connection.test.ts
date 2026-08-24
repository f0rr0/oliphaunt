import { describe, expect, it } from 'vitest';
import {
  BackendResponseGate,
  classifyFrontendFrame,
  FrontendFrameReader,
} from '../pgwire-connection.js';

describe('WASIX PostgreSQL connection framing', () => {
  it('buffers split frontend messages without combining protocol batches', () => {
    const query = Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 6, '1'.charCodeAt(0), 0);
    const reader = new FrontendFrameReader();
    reader.append(query.subarray(0, 3));
    expect(reader.shift()).toBeUndefined();
    reader.append(query.subarray(3));
    expect(reader.shift()).toEqual(query);
  });

  it('keeps coalesced COPY input available without pulling a later frame early', () => {
    const query = frontend('Q', new TextEncoder().encode('COPY items FROM STDIN\0'));
    const copyData = frontend('d', new TextEncoder().encode('1\tvalue\n'));
    const copyDone = frontend('c', new Uint8Array());
    const reader = new FrontendFrameReader();
    reader.append(concat([query, copyData, copyDone]));

    expect(reader.shift()).toEqual(query);
    expect(reader.readFrameChunk(3, unexpectedRead)).toEqual(copyData.subarray(0, 3));
    expect(reader.readFrameChunk(64, unexpectedRead)).toEqual(copyData.subarray(3));
    expect(reader.readFrameChunk(64, unexpectedRead)).toEqual(copyDone);
    reader.finishPull();
    expect(reader.shift()).toBeUndefined();
  });

  it('classifies startup, SSL, cancel, terminate, and protocol frames', () => {
    expect(classifyFrontendFrame(control(196_608))).toBe('startup');
    expect(classifyFrontendFrame(control(80_877_103))).toBe('ssl');
    expect(classifyFrontendFrame(control(80_877_102))).toBe('cancel');
    expect(classifyFrontendFrame(Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4))).toBe('terminate');
    expect(classifyFrontendFrame(Uint8Array.of('S'.charCodeAt(0), 0, 0, 0, 4))).toBe('protocol');
  });

  it('holds only ReadyForQuery while streaming COPY data', () => {
    const gate = new BackendResponseGate();
    const output: Uint8Array[] = [];
    const copyData = backend('d', new Uint8Array(1024 * 1024));
    const ready = backend('Z', Uint8Array.of('I'.charCodeAt(0)));
    gate.push(copyData, (chunk) => output.push(chunk));
    gate.push(ready.subarray(0, 5), (chunk) => output.push(chunk));
    gate.push(ready.subarray(5), (chunk) => output.push(chunk));
    expect(concat(output)).toEqual(copyData);
    expect(gate.finish()).toEqual({ status: 'I'.charCodeAt(0), frame: ready });
    expect(() =>
      gate.push(backend('C', new TextEncoder().encode('SELECT 1\0')), () => undefined),
    ).toThrow(/after ReadyForQuery/);
  });
});

function control(code: number): Uint8Array {
  const output = new Uint8Array(8);
  const view = new DataView(output.buffer);
  view.setInt32(0, 8);
  view.setInt32(4, code);
  return output;
}

function backend(tag: string, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(5 + body.length);
  output[0] = tag.charCodeAt(0);
  new DataView(output.buffer).setInt32(1, body.length + 4);
  output.set(body, 5);
  return output;
}

function frontend(tag: string, body: Uint8Array): Uint8Array {
  return backend(tag, body);
}

function unexpectedRead(): Uint8Array {
  throw new Error('reader unexpectedly requested more frontend bytes');
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
