import { assertSuccessfulQueryResponse } from './query.js';

const encoder = new TextEncoder();

export function startupPacket(username: string, database: string): Uint8Array {
  assertStartupValue('username', username);
  assertStartupValue('database', database);

  const body: number[] = [];
  pushI32(body, 196_608);
  pushCString(body, 'user');
  pushCString(body, username);
  pushCString(body, 'database');
  pushCString(body, database);
  pushCString(body, 'client_encoding');
  pushCString(body, 'UTF8');
  pushCString(body, 'DateStyle');
  pushCString(body, 'ISO, MDY');
  pushCString(body, 'TimeZone');
  pushCString(body, 'UTC');
  body.push(0);

  const packet: number[] = [];
  pushI32(packet, body.length + 4);
  packet.push(...body);
  return Uint8Array.from(packet);
}

export function terminatePacket(): Uint8Array {
  return Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4);
}

export class PgwireStream {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #closed = false;

  constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    this.#reader = readable.getReader();
    this.#writer = writable.getWriter();
  }

  async exchange(input: Uint8Array): Promise<Uint8Array> {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX pgwire stream is closed');
    }
    await this.#writer.write(input);
    return this.#readUntilReady(false);
  }

  /**
   * PostgreSQL startup failures terminate this single-user guest after writing
   * ErrorResponse; they are not required to emit ReadyForQuery first. Stop at
   * the complete ErrorResponse so the caller can preserve its SQLSTATE rather
   * than converting a normal startup rejection into an stdout-EOF failure.
   */
  async startup(input: Uint8Array): Promise<Uint8Array> {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX pgwire stream is closed');
    }
    await this.#writer.write(input);
    return this.#readUntilReady(true);
  }

  async settleStartup(): Promise<void> {
    const response = await this.#readUntilReady(false);
    let offset = 0;
    while (offset < response.length) {
      const tag = response[offset];
      const messageLength = readI32(response, offset + 1) + 1;
      const isFinalReady = tag === 'Z'.charCodeAt(0) && offset + messageLength === response.length;
      if (tag !== 'S'.charCodeAt(0) && !isFinalReady) {
        throw new Error(
          `unexpected PostgreSQL message while settling WASIX startup: ${String.fromCharCode(tag ?? 0)}`,
        );
      }
      offset += messageLength;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    let failure: unknown;
    try {
      await this.#writer.write(terminatePacket());
    } catch (error) {
      failure = error;
    }
    try {
      await this.#writer.close();
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              `${describeError(failure)}; pgwire writer close also failed: ${describeError(error)}`,
            );
    } finally {
      this.#writer.releaseLock();
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  async #readUntilReady(stopAtError: boolean): Promise<Uint8Array> {
    const messages: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      await this.#fill(5);
      const tag = this.#buffer[0];
      const bodyLength = readI32(this.#buffer, 1);
      if (bodyLength < 4) {
        throw new Error(`invalid PostgreSQL backend message length ${bodyLength}`);
      }
      const messageLength = bodyLength + 1;
      if (messageLength > 64 * 1024 * 1024) {
        throw new Error(`PostgreSQL backend message exceeds 64 MiB: ${messageLength} bytes`);
      }
      await this.#fill(messageLength);
      const message = this.#buffer.slice(0, messageLength);
      this.#buffer = this.#buffer.slice(messageLength);
      messages.push(message);
      totalLength += message.length;

      if (tag === 'Z'.charCodeAt(0) || (stopAtError && tag === 'E'.charCodeAt(0))) {
        return concatenate(messages, totalLength);
      }
    }
  }

  async #fill(length: number): Promise<void> {
    while (this.#buffer.length < length) {
      const next = await this.#reader.read();
      if (next.done) {
        throw new Error('Oliphaunt WASIX process closed stdout before ReadyForQuery');
      }
      this.#buffer = concatenate(
        [this.#buffer, next.value],
        this.#buffer.length + next.value.length,
      );
    }
  }
}

/** Validate the first PostgreSQL startup exchange before settling the host loop. */
export function assertSuccessfulStartupResponse(response: Uint8Array): void {
  let offset = 0;
  let sawAuthenticationOk = false;
  let sawReady = false;
  while (offset < response.length) {
    if (response.length - offset < 5) {
      throw new Error('PostgreSQL startup response ended inside a backend message header');
    }
    const tag = response[offset] ?? 0;
    const bodyLength = readI32(response, offset + 1);
    if (bodyLength < 4) {
      throw new Error(`invalid PostgreSQL startup message length ${bodyLength}`);
    }
    const messageLength = bodyLength + 1;
    if (offset + messageLength > response.length) {
      throw new Error('PostgreSQL startup response ended inside a backend message');
    }
    if (tag === 'E'.charCodeAt(0)) {
      // Reuse the shared pgwire error decoder so startup and query failures
      // expose the same PostgresError/SQLSTATE contract.
      const ready = Uint8Array.of('Z'.charCodeAt(0), 0, 0, 0, 5, 'I'.charCodeAt(0));
      const withReady = concatenate(
        [response.slice(offset, offset + messageLength), ready],
        messageLength + ready.length,
      );
      // Imported lazily would obscure the synchronous error contract. Keep
      // the parser dependency at module scope through this helper below.
      throwStartupPostgresError(withReady);
    }
    if (tag === 'R'.charCodeAt(0)) {
      if (bodyLength !== 8 || readI32(response, offset + 5) !== 0) {
        throw new Error('Oliphaunt WASIX supports only PostgreSQL AuthenticationOk startup');
      }
      sawAuthenticationOk = true;
    }
    if (tag === 'Z'.charCodeAt(0)) {
      if (bodyLength !== 5) {
        throw new Error('invalid PostgreSQL ReadyForQuery startup message');
      }
      sawReady = true;
      if (offset + messageLength !== response.length) {
        throw new Error('PostgreSQL startup returned bytes after ReadyForQuery');
      }
    }
    offset += messageLength;
  }
  if (!sawAuthenticationOk || !sawReady) {
    throw new Error('PostgreSQL startup response omitted AuthenticationOk or ReadyForQuery');
  }
}

function throwStartupPostgresError(response: Uint8Array): never {
  assertSuccessfulQueryResponse(response);
  throw new Error('PostgreSQL startup ErrorResponse was not rejected');
}

function assertStartupValue(label: string, value: string): void {
  if (value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
}

function pushCString(output: number[], value: string): void {
  output.push(...encoder.encode(value), 0);
}

function pushI32(output: number[], value: number): void {
  output.push((value >>> 24) & 0xff);
  output.push((value >>> 16) & 0xff);
  output.push((value >>> 8) & 0xff);
  output.push(value & 0xff);
}

function readI32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function concatenate(chunks: ReadonlyArray<Uint8Array>, totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
