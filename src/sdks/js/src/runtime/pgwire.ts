import type { ByteStream } from './byte-stream.js';
import { connectEndpoint, type LocalEndpoint } from './node-adapter.js';
import { throwCollectedCloseFailures } from './close.js';

const PROTOCOL_VERSION_3 = 196_608;

export class PostgresWireClient {
  readonly #stream: ByteStream;
  #terminateRequested = false;
  #streamClosed = false;

  private constructor(stream: ByteStream) {
    this.#stream = stream;
  }

  static async connect(
    endpoint: LocalEndpoint,
    username: string,
    database: string,
  ): Promise<PostgresWireClient> {
    const stream = await connectEndpoint(endpoint);
    try {
      await stream.writeAll(encodeStartupMessage(username, database));
      await readUntilReady(stream, {
        includeMessages: false,
        errorIsFatal: true,
      });
      return new PostgresWireClient(stream);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await stream.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      throwCollectedCloseFailures(failures, 'native server startup connection cleanup failed');
      throw error;
    }
  }

  async execProtocolRaw(request: Uint8Array): Promise<Uint8Array> {
    await this.#stream.writeAll(request);
    return readUntilReady(this.#stream, {
      includeMessages: true,
      errorIsFatal: false,
    });
  }

  async terminate(): Promise<void> {
    const failures: unknown[] = [];
    if (!this.#terminateRequested) {
      this.#terminateRequested = true;
      try {
        await this.#stream.writeAll(new Uint8Array([0x58, 0, 0, 0, 4]));
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.#streamClosed) {
      try {
        await this.#stream.close();
        this.#streamClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    throwCollectedCloseFailures(failures, 'native server client termination failed');
  }

  /** @internal Whether the exact client stream has been released. */
  get isTerminated(): boolean {
    return this.#streamClosed;
  }
}

export function encodeStartupMessage(username: string, database: string): Uint8Array {
  const body: number[] = [];
  pushI32(body, PROTOCOL_VERSION_3);
  pushCString(body, 'user');
  pushCString(body, username);
  pushCString(body, 'database');
  pushCString(body, database);
  pushCString(body, 'client_encoding');
  pushCString(body, 'UTF8');
  body.push(0);
  const out: number[] = [];
  pushI32(out, body.length + 4);
  out.push(...body);
  return Uint8Array.from(out);
}

async function readUntilReady(
  stream: ByteStream,
  options: {
    includeMessages: boolean;
    errorIsFatal: boolean;
  },
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const header = await stream.readExactly(5);
    const tag = header[0];
    if (tag === undefined) {
      throw new Error('native server returned an empty backend frame header');
    }
    const length = readI32(header, 1);
    if (length < 4) {
      throw new Error(`native server returned invalid message length ${length}`);
    }
    const body = await stream.readExactly(length - 4);
    const frame = new Uint8Array(5 + body.length);
    frame.set(header, 0);
    frame.set(body, 5);
    if (options.includeMessages) {
      chunks.push(frame);
    }
    switch (tag) {
      case 0x52:
        handleAuthentication(body);
        break;
      case 0x45:
        if (options.errorIsFatal) {
          throw new Error(parseErrorResponse(body));
        }
        break;
      case 0x5a:
        return concat(chunks);
      default:
        break;
    }
  }
}

function handleAuthentication(body: Uint8Array): void {
  if (body.length < 4) {
    throw new Error('native server returned truncated authentication message');
  }
  const method = readI32(body, 0);
  if (method !== 0) {
    throw new Error(`native server requested unsupported authentication method ${method}`);
  }
}

function parseErrorResponse(body: Uint8Array): string {
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = body[offset];
    offset += 1;
    const end = body.indexOf(0, offset);
    if (end < 0) {
      break;
    }
    if (code === 0x4d) {
      return strictUtf8.decode(body.subarray(offset, end));
    }
    offset = end + 1;
  }
  return 'native server returned an error response';
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pushCString(out: number[], value: string): void {
  if (value.includes('\0')) {
    throw new Error('PostgreSQL startup string must not contain NUL bytes');
  }
  out.push(...new TextEncoder().encode(value), 0);
}

function pushI32(out: number[], value: number): void {
  const bits = value >>> 0;
  out.push((bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff);
}

function readI32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
