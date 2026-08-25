import { describe, expect, it } from 'vitest';
import {
  closeWasixByteChannel,
  createWasixByteChannel,
  writeWasixByteChannelSync,
} from '../byte-channel.js';
import {
  BackendResponseGate,
  classifyFrontendFrame,
  FrontendFrameReader,
  parseStartupIdentity,
  serveWasixProtocolConnection,
  SynchronousPgDumpConnection,
} from '../pgwire-connection.js';

describe('WASIX PostgreSQL connection framing', () => {
  it('bridges fragmented same-realm pg_dump traffic without concatenating backend output', () => {
    const startupResponse = Uint8Array.of(1, 2, 3, 4);
    const query = frontend('Q', new TextEncoder().encode('SELECT 1\0'));
    const response = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const executed: Uint8Array[] = [];
    const connection = new SynchronousPgDumpConnection({
      startupResponse,
      startupIdentity: { username: 'application', database: 'products' },
      exec(input, onChunk) {
        executed.push(input);
        for (let offset = 0; offset < response.length; offset += 73) {
          onChunk(response.subarray(offset, offset + 73));
        }
      },
    });
    expect(connection.protocolStarted).toBe(false);

    const ssl = control(80_877_103);
    connection.write(ssl.subarray(0, 3));
    expect(connection.protocolStarted).toBe(true);
    connection.write(ssl.subarray(3));
    expect(connection.read(1)).toEqual(Uint8Array.of('N'.charCodeAt(0)));

    const start = startup([
      ['user', 'application'],
      ['database', 'products'],
    ]);
    const borrowedPrefix = start.slice(0, 7);
    connection.write(borrowedPrefix);
    // The Wasmer callback lends a guest-memory view only until write returns.
    // Mutating that view must not corrupt the retained fragmented frame.
    borrowedPrefix.fill(0xff);
    connection.write(start.subarray(7));
    expect(connection.read(2)).toEqual(startupResponse.subarray(0, 2));
    expect(connection.read(8)).toEqual(startupResponse.subarray(2));

    connection.write(query.subarray(0, 4));
    connection.write(query.subarray(4));
    const chunks: Uint8Array[] = [];
    for (let remaining = response.length; remaining > 0; ) {
      const chunk = connection.read(31);
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    expect(concat(chunks)).toEqual(response);
    expect(executed).toEqual([query]);
    connection.write(frontend('X', new Uint8Array()));
    connection.finish();
  });

  it('fails same-realm pg_dump closed on identity, cancellation, and premature reads', () => {
    const connection = new SynchronousPgDumpConnection({
      startupResponse: new Uint8Array(),
      startupIdentity: { username: 'application', database: 'products' },
      exec: unexpectedProtocolExecution,
    });
    expect(connection.protocolStarted).toBe(false);
    expect(() => connection.read(1)).toThrow(/before PostgreSQL produced/);
    expect(connection.protocolStarted).toBe(true);
    expect(() =>
      connection.write(
        startup([
          ['user', 'other'],
          ['database', 'products'],
        ]),
      ),
    ).toThrow(/does not match endpoint user/);

    const canceled = new SynchronousPgDumpConnection({
      startupResponse: new Uint8Array(),
      startupIdentity: { username: 'application', database: 'products' },
      exec: unexpectedProtocolExecution,
    });
    expect(() => canceled.write(control(80_877_102))).toThrow(/cancellation is not supported/);
  });

  it('buffers split frontend messages without combining protocol batches', () => {
    const query = Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 6, '1'.charCodeAt(0), 0);
    const reader = new FrontendFrameReader();
    reader.append(query.subarray(0, 3));
    expect(reader.shift()).toBeUndefined();
    reader.append(query.subarray(3));
    expect(reader.shift()).toEqual(query);
  });

  it('grows fragmented frontend messages without recopying the pending prefix', () => {
    const query = frontend('Q', new Uint8Array(64 * 1024));
    const reader = new FrontendFrameReader();
    for (let offset = 0; offset < query.length; offset += 17) {
      reader.append(query.subarray(offset, offset + 17));
    }
    const frame = reader.shift();
    expect(frame?.length).toBe(query.length);
    expect(frame?.every((value, index) => value === query[index])).toBe(true);
    reader.finish();
  });

  it('assembles a large fragmented frontend frame with one linear coalescing pass', () => {
    const body = new Uint8Array(4 * 1024 * 1024);
    body[0] = 1;
    body[body.length - 1] = 2;
    const query = frontend('Q', body);
    const reader = new FrontendFrameReader();
    for (let offset = 0; offset < query.length; offset += 64 * 1024) {
      reader.append(query.subarray(offset, offset + 64 * 1024));
    }

    const result = reader.shift();
    expect(result?.length).toBe(query.length);
    expect(result?.[5]).toBe(1);
    expect(result?.at(-1)).toBe(2);
    expect(reader.shift()).toBeUndefined();
  });

  it('streams an incomplete COPY frame as soon as its header and current bytes arrive', () => {
    const reader = new FrontendFrameReader();
    const headerAndPrefix = new Uint8Array(9);
    headerAndPrefix[0] = 'd'.charCodeAt(0);
    new DataView(headerAndPrefix.buffer).setInt32(1, 1024 * 1024 + 4);
    headerAndPrefix.set([1, 2, 3, 4], 5);
    reader.append(headerAndPrefix);

    const result = reader.readFrameChunk(64 * 1024, unexpectedRead);
    expect(result).toEqual(headerAndPrefix);
    expect(result.buffer).toBe(headerAndPrefix.buffer);
    expect(() => reader.finishPull()).toThrow('stopped inside a frontend message');
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

  it('rejects truncated, oversized, and concurrently shifted pull frames', () => {
    const splitHeader = new FrontendFrameReader();
    splitHeader.append(Uint8Array.of('d'.charCodeAt(0), 0));
    expect(() => splitHeader.readFrameChunk(64, () => new Uint8Array())).toThrow(
      'ended inside a message',
    );

    const splitBody = new FrontendFrameReader();
    const partial = new Uint8Array(6);
    partial[0] = 'd'.charCodeAt(0);
    new DataView(partial.buffer).setInt32(1, 8);
    splitBody.append(partial);
    expect(splitBody.readFrameChunk(64, unexpectedRead)).toEqual(partial);
    expect(() => splitBody.shift()).toThrow('pull frame is still active');
    expect(() => splitBody.readFrameChunk(64, () => new Uint8Array())).toThrow(
      'stopped inside a frontend message',
    );

    const oversized = new FrontendFrameReader();
    const header = new Uint8Array(5);
    header[0] = 'd'.charCodeAt(0);
    new DataView(header.buffer).setInt32(1, 128 * 1024 * 1024 + 4);
    oversized.append(header);
    expect(() => oversized.shift()).toThrow('exceeds limit');
  });

  it('classifies startup, SSL, cancel, terminate, and protocol frames', () => {
    expect(classifyFrontendFrame(control(196_608))).toBe('startup');
    expect(classifyFrontendFrame(control(80_877_103))).toBe('ssl');
    expect(classifyFrontendFrame(control(80_877_102))).toBe('cancel');
    expect(classifyFrontendFrame(Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4))).toBe('terminate');
    expect(classifyFrontendFrame(Uint8Array.of('S'.charCodeAt(0), 0, 0, 0, 4))).toBe('protocol');
  });

  it('parses PostgreSQL startup identity and applies the standard database default', () => {
    expect(
      parseStartupIdentity(
        startup([
          ['user', 'application'],
          ['database', 'products'],
          ['application_name', 'fixture'],
        ]),
      ),
    ).toEqual({ username: 'application', database: 'products' });
    expect(parseStartupIdentity(startup([['user', 'application']]))).toEqual({
      username: 'application',
      database: 'application',
    });
    expect(
      parseStartupIdentity(
        startup([
          ['user', 'application'],
          ['database', ''],
        ]),
      ),
    ).toEqual({ username: 'application', database: 'application' });
  });

  it('uses the final repeated startup value and PostgreSQL identifier limits', () => {
    expect(
      parseStartupIdentity(
        startup([
          ['application_name', 'first'],
          ['user', 'first'],
          ['application_name', 'second'],
          ['user', 'second'],
          ['database', 'products'],
        ]),
      ),
    ).toEqual({ username: 'second', database: 'products' });
    expect(parseStartupIdentity(startup([['user', `${'a'.repeat(62)}🐘tail`]]))).toEqual({
      username: 'a'.repeat(62),
      database: 'a'.repeat(62),
    });
  });

  it('rejects malformed PostgreSQL startup parameters', () => {
    expect(() => parseStartupIdentity(startup([['database', 'postgres']]))).toThrow(
      /requires a non-empty user/,
    );

    const trailing = startup([['user', 'postgres']]);
    const malformed = new Uint8Array(trailing.length + 1);
    malformed.set(trailing);
    new DataView(malformed.buffer).setInt32(0, malformed.length);
    expect(() => parseStartupIdentity(malformed)).toThrow(/bytes after its final NUL/);
  });

  it('rejects a startup identity that differs from the configured endpoint', async () => {
    const frontend = createWasixByteChannel();
    const backend = createWasixByteChannel();
    writeWasixByteChannelSync(
      frontend,
      startup([
        ['user', 'other'],
        ['database', 'products'],
      ]),
    );
    closeWasixByteChannel(frontend);

    await expect(
      serveWasixProtocolConnection(
        { frontend, backend },
        {
          startupResponse: new Uint8Array(),
          startupIdentity: { username: 'application', database: 'products' },
          execDuplex: unexpectedProtocolExecution,
          async publishIdle() {},
          async rollback() {},
        },
      ),
    ).rejects.toThrow(/startup user "other" does not match endpoint user "application"/);
  });

  it('holds only ReadyForQuery while streaming COPY data', () => {
    const gate = new BackendResponseGate();
    const output: Uint8Array[] = [];
    const copyData = backend('d', new Uint8Array(1024 * 1024));
    const ready = backend('Z', Uint8Array.of('I'.charCodeAt(0)));
    gate.push(copyData.subarray(0, 32 * 1024), (chunk) => output.push(chunk));
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(copyData.subarray(0, 32 * 1024));
    gate.push(copyData.subarray(32 * 1024), (chunk) => output.push(chunk));
    expect(output).toHaveLength(2);
    gate.push(ready.subarray(0, 5), (chunk) => output.push(chunk));
    gate.push(ready.subarray(5), (chunk) => output.push(chunk));
    expect(output).toHaveLength(2);
    const streamed = concat(output);
    expect(streamed.length).toBe(copyData.length);
    expect(streamed.every((value, index) => value === copyData[index])).toBe(true);
    expect(gate.finish()).toEqual({ status: 'I'.charCodeAt(0), frame: ready });
    expect(() =>
      gate.push(backend('C', new TextEncoder().encode('SELECT 1\0')), () => undefined),
    ).toThrow(/after ReadyForQuery/);
  });
  it('coalesces fragmented and multiple non-Ready messages within one host callback', () => {
    const gate = new BackendResponseGate();
    const output: Uint8Array[] = [];
    const command = backend('C', new TextEncoder().encode('SELECT 1\0'));
    const emptyQuery = backend('I', new Uint8Array());

    gate.push(command.subarray(0, 3), (chunk) => output.push(chunk));
    expect(output).toHaveLength(0);
    gate.push(concat([command.subarray(3), emptyQuery]), (chunk) => output.push(chunk));

    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(concat([command, emptyQuery]));
    expect(gate.finish()).toBeUndefined();
  });
});

function control(code: number): Uint8Array {
  const output = new Uint8Array(8);
  const view = new DataView(output.buffer);
  view.setInt32(0, 8);
  view.setInt32(4, code);
  return output;
}

function startup(parameters: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parameters.flatMap(([name, value]) => [
    encoder.encode(name),
    encoder.encode(value),
  ]);
  const parameterBytes = chunks.reduce((length, chunk) => length + chunk.length + 1, 1);
  const output = new Uint8Array(8 + parameterBytes);
  const view = new DataView(output.buffer);
  view.setInt32(0, output.length);
  view.setInt32(4, 196_608);
  let offset = 8;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length + 1;
  }
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

function unexpectedProtocolExecution(): never {
  throw new Error('executor unexpectedly received a PostgreSQL protocol message');
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
