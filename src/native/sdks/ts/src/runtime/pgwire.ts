import { type ByteStream, withStreamDeadline } from './byte-stream.js';
import { connectEndpoint, type LocalEndpoint } from './node-adapter.js';
import { throwCollectedCloseFailures } from './close.js';
import { DEFAULT_CONTROL_TIMEOUT_MS } from './timeouts.js';

const PROTOCOL_VERSION_3 = 196_608;
const MAX_FRAME_LEN = 128 * 1024 * 1024;

export class PostgresWireClient {
  readonly #stream: ByteStream;
  #terminateRequested = false;
  #streamClosed = false;

  constructor(stream: ByteStream) {
    this.#stream = stream;
  }

  static async connect(
    endpoint: LocalEndpoint,
    username: string,
    database: string,
    timeoutMs: number,
    password?: string,
    deadline = performance.now() + timeoutMs,
  ): Promise<PostgresWireClient> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
    let stream: ByteStream | undefined;
    try {
      stream = await connectEndpoint(endpoint, controller.signal);
      clearTimeout(timeout);
      const connected = stream;
      await withStreamDeadline(
        connected,
        deadline,
        async () => {
          await connected.writeAll(encodeStartupMessage(username, database));
          return readUntilReady(connected, password);
        },
        'PostgreSQL startup',
      );
      return new PostgresWireClient(stream);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await stream?.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      throwCollectedCloseFailures(failures, 'native server startup connection cleanup failed');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    if (!this.#streamClosed) {
      await this.#stream.close();
      this.#streamClosed = true;
    }
  }

  async terminate(timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS): Promise<void> {
    const failures: unknown[] = [];
    if (!this.#terminateRequested) {
      this.#terminateRequested = true;
      try {
        await withStreamDeadline(
          this.#stream,
          performance.now() + timeoutMs,
          () => this.#stream.writeAll(new Uint8Array([0x58, 0, 0, 0, 4])),
          'PostgreSQL termination',
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.#streamClosed) {
      try {
        await this.close();
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

/** Authenticate an already connected stream before selecting a transport. */
export async function authenticatePostgresStream(
  stream: ByteStream,
  username: string,
  database: string,
  password: string,
  parameters: Readonly<Record<string, string>> = {},
): Promise<void> {
  await stream.writeAll(encodeStartupMessage(username, database, parameters));
  await readUntilReady(stream, password);
}

export function encodeStartupMessage(
  username: string,
  database: string,
  parameters: Readonly<Record<string, string>> = {},
): Uint8Array {
  const body: number[] = [];
  pushI32(body, PROTOCOL_VERSION_3);
  pushCString(body, 'user');
  pushCString(body, username);
  pushCString(body, 'database');
  pushCString(body, database);
  pushCString(body, 'client_encoding');
  pushCString(body, 'UTF8');
  for (const [key, value] of Object.entries(parameters)) {
    pushCString(body, key);
    pushCString(body, value);
  }
  body.push(0);
  const out: number[] = [];
  pushI32(out, body.length + 4);
  out.push(...body);
  return Uint8Array.from(out);
}

async function readUntilReady(
  stream: ByteStream,
  password?: string,
): Promise<Uint8Array | undefined> {
  let authenticated = false;
  let passwordSent = false;
  let cancelKey: Uint8Array | undefined;
  for (;;) {
    const frame = await readBackendFrame(stream);
    const tag = frame[0];
    const body = frame.subarray(5);
    switch (tag) {
      case 0x52: {
        if (body.length !== 4 || authenticated)
          throw new Error('invalid PostgreSQL authentication response');
        const method = readI32(body, 0);
        if (method === 0) authenticated = true;
        else if (method === 3 && password !== undefined && !passwordSent) {
          if (password.includes('\0'))
            throw new Error('PostgreSQL password must not contain NUL bytes');
          const payload = new TextEncoder().encode(password);
          const message = new Uint8Array(payload.length + 6);
          message[0] = 0x70;
          new DataView(message.buffer).setUint32(1, payload.length + 5);
          message.set(payload, 5);
          await stream.writeAll(message);
          passwordSent = true;
        } else
          throw new Error(`native server requested unsupported authentication method ${method}`);
        break;
      }
      case 0x4b:
        if (!authenticated || body.length !== 8 || cancelKey)
          throw new Error('invalid PostgreSQL cancellation key');
        cancelKey = body.slice();
        break;
      case 0x45:
        throw new Error(parseErrorResponse(body));
      case 0x5a:
        if (!authenticated || (password !== undefined && !cancelKey))
          throw new Error('PostgreSQL startup was not authenticated');
        return cancelKey;
      default:
        break;
    }
  }
}

async function readBackendFrame(stream: ByteStream): Promise<Uint8Array> {
  const header = await stream.readExactly(5);
  const length = readI32(header, 1);
  if (length < 4 || length > MAX_FRAME_LEN)
    throw new Error(`invalid PostgreSQL message length ${length}`);
  const frame = new Uint8Array(length + 1);
  frame.set(header);
  frame.set(await stream.readExactly(length - 4), 5);
  if (frame[0] === 0x5a && (length !== 5 || ![0x49, 0x54, 0x45].includes(frame[5]!)))
    throw new Error('invalid PostgreSQL ReadyForQuery frame');
  return frame;
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
