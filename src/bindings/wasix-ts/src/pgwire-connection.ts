import {
  closeWasixByteChannel,
  readWasixByteChannelSync,
  type WasixByteChannel,
  writeWasixByteChannelSync,
} from './byte-channel.js';

const SSL_REQUEST = 80_877_103;
const GSSENC_REQUEST = 80_877_104;
const CANCEL_REQUEST = 80_877_102;
const PROTOCOL_3 = 196_608;
const MAX_FRONTEND_MESSAGE_BYTES = 128 * 1024 * 1024;
const POSTGRES_IDENTIFIER_BYTES = 63;

export type WasixProtocolConnection = Readonly<{
  frontend: WasixByteChannel;
  backend: WasixByteChannel;
}>;

export type WasixProtocolExecutor = Readonly<{
  startupResponse: Uint8Array;
  startupIdentity?: Readonly<{ username: string; database: string }>;
  execDuplex(
    input: Uint8Array,
    onRead: (maximumBytes: number) => Uint8Array,
    onWrite: (chunk: Uint8Array) => void,
  ): void;
  publishIdle(): Promise<void>;
  rollback(): Promise<void>;
}>;

export type SynchronousPgDumpExecutor = Readonly<{
  startupResponse: Uint8Array;
  startupIdentity: Readonly<{ username: string; database: string }>;
  exec(input: Uint8Array, onChunk: (chunk: Uint8Array) => void): void;
}>;

/** @internal Connect same-realm pg_dump to the already stepped PostgreSQL backend. */
export class SynchronousPgDumpConnection {
  readonly #executor: SynchronousPgDumpExecutor;
  readonly #frontend = new FrontendFrameReader();
  readonly #backend = new ByteChunkQueue();
  #protocolStarted = false;
  #started = false;
  #terminated = false;

  constructor(executor: SynchronousPgDumpExecutor) {
    this.#executor = executor;
  }

  get protocolStarted(): boolean {
    return this.#protocolStarted;
  }

  write(input: Uint8Array): void {
    this.#protocolStarted = true;
    if (this.#terminated) {
      throw new Error('pg_dump wrote after terminating its PostgreSQL connection');
    }
    this.#frontend.append(input);
    for (;;) {
      const frame = this.#frontend.shift();
      if (frame === undefined) return;
      switch (classifyFrontendFrame(frame)) {
        case 'ssl':
          this.#backend.push(Uint8Array.of('N'.charCodeAt(0)));
          break;
        case 'cancel':
          throw new Error('pg_dump cancellation is not supported');
        case 'terminate':
          this.#terminated = true;
          return;
        case 'startup':
          if (this.#started) throw new Error('duplicate PostgreSQL startup packet');
          assertStartupIdentity(frame, this.#executor.startupIdentity);
          this.#started = true;
          this.#backend.push(this.#executor.startupResponse);
          break;
        case 'protocol':
          if (!this.#started) throw new Error('PostgreSQL protocol message preceded startup');
          this.#executor.exec(frame, (chunk) => this.#backend.push(chunk));
          break;
      }
    }
  }

  read(maximumBytes: number): Uint8Array {
    this.#protocolStarted = true;
    const output = this.#backend.read(maximumBytes);
    if (output.length === 0 && !this.#terminated) {
      throw new Error('pg_dump attempted to read before PostgreSQL produced a response');
    }
    return output;
  }

  finish(): void {
    this.#frontend.finish();
    if (!this.#backend.empty) {
      throw new Error('pg_dump left unread PostgreSQL response bytes');
    }
  }
}

/** Owned backend chunks with O(1) reads and occasional bounded compaction. */
class ByteChunkQueue {
  #chunks: Uint8Array[] = [];
  #head = 0;
  #offset = 0;

  get empty(): boolean {
    return this.#head === this.#chunks.length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length !== 0) this.#chunks.push(chunk);
  }

  read(maximumBytes: number): Uint8Array {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new TypeError('maximum backend byte count must be a positive integer');
    }
    const chunk = this.#chunks[this.#head];
    if (chunk === undefined) return new Uint8Array();
    const end = Math.min(chunk.length, this.#offset + maximumBytes);
    const output = chunk.subarray(this.#offset, end);
    this.#offset = end;
    if (end === chunk.length) {
      this.#head += 1;
      this.#offset = 0;
      if (this.#head === this.#chunks.length) {
        this.#chunks = [];
        this.#head = 0;
      } else if (this.#head > 256 && this.#head * 2 >= this.#chunks.length) {
        this.#chunks = this.#chunks.slice(this.#head);
        this.#head = 0;
      }
    }
    return output;
  }
}

/** @internal Serve one complete frontend connection over bounded byte channels. */
export async function serveWasixProtocolConnection(
  connection: WasixProtocolConnection,
  executor: WasixProtocolExecutor,
): Promise<void> {
  const reader = new FrontendFrameReader();
  let startupComplete = false;
  let transactionStatus: number | undefined;
  try {
    for (;;) {
      const frame = reader.shift();
      if (frame === undefined) {
        const input = readWasixByteChannelSync(connection.frontend);
        if (input.length === 0) {
          reader.finish();
          break;
        }
        reader.append(input);
        continue;
      }
      const classification = classifyFrontendFrame(frame);
      switch (classification) {
        case 'ssl':
          writeWasixByteChannelSync(connection.backend, Uint8Array.of('N'.charCodeAt(0)));
          break;
        case 'cancel':
        case 'terminate':
          return;
        case 'startup':
          if (startupComplete) throw new Error('duplicate PostgreSQL startup packet');
          if (executor.startupIdentity !== undefined) {
            assertStartupIdentity(frame, executor.startupIdentity);
          }
          startupComplete = true;
          writeWasixByteChannelSync(connection.backend, executor.startupResponse);
          transactionStatus = 'I'.charCodeAt(0);
          break;
        case 'protocol': {
          if (!startupComplete) throw new Error('PostgreSQL protocol message preceded startup');
          const response = new BackendResponseGate();
          executor.execDuplex(
            frame,
            (maximumBytes) =>
              reader.readFrameChunk(maximumBytes, () =>
                readWasixByteChannelSync(connection.frontend),
              ),
            (chunk) =>
              response.push(chunk, (output) =>
                writeWasixByteChannelSync(connection.backend, output),
              ),
          );
          reader.finishPull();
          const ready = response.finish();
          if (ready !== undefined) {
            transactionStatus = ready.status;
            if (ready.status === 'I'.charCodeAt(0)) await executor.publishIdle();
            writeWasixByteChannelSync(connection.backend, ready.frame);
          }
          break;
        }
      }
    }
  } finally {
    try {
      if (transactionStatus !== undefined && transactionStatus !== 'I'.charCodeAt(0)) {
        await executor.rollback();
      }
    } finally {
      closeWasixByteChannel(connection.backend);
    }
  }
}

type FrontendKind = 'ssl' | 'cancel' | 'terminate' | 'startup' | 'protocol';

export function classifyFrontendFrame(frame: Uint8Array): FrontendKind {
  if (frame.length === 0) throw new Error('empty PostgreSQL frontend message');
  if (frame[0] !== 0) {
    return frame[0] === 'X'.charCodeAt(0) ? 'terminate' : 'protocol';
  }
  if (frame.length < 8) throw new Error('PostgreSQL startup packet is too short');
  const code = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getInt32(4);
  if (code === SSL_REQUEST || code === GSSENC_REQUEST) return 'ssl';
  if (code === CANCEL_REQUEST) return 'cancel';
  if (code === PROTOCOL_3) return 'startup';
  throw new Error(`unsupported PostgreSQL startup packet code ${code}`);
}

/** @internal Parse the identity selected by a PostgreSQL v3 startup packet. */
export function parseStartupIdentity(
  frame: Uint8Array,
): Readonly<{ username: string; database: string }> {
  if (classifyFrontendFrame(frame) !== 'startup') {
    throw new Error('PostgreSQL startup identity requires a protocol v3 startup packet');
  }
  const declaredLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getInt32(0);
  if (declaredLength !== frame.length) {
    throw new Error(
      `PostgreSQL startup packet length ${declaredLength} does not match ${frame.length} bytes`,
    );
  }

  const parameters = new Map<string, string>();
  let offset = 8;
  for (;;) {
    if (offset >= frame.length) {
      throw new Error('PostgreSQL startup parameters are missing their final NUL byte');
    }
    const nameEnd = frame.indexOf(0, offset);
    if (nameEnd < 0) {
      throw new Error('PostgreSQL startup parameter name is missing its NUL terminator');
    }
    if (nameEnd === offset) {
      if (nameEnd !== frame.length - 1) {
        throw new Error('PostgreSQL startup packet contains bytes after its final NUL byte');
      }
      break;
    }
    const valueOffset = nameEnd + 1;
    const valueEnd = frame.indexOf(0, valueOffset);
    if (valueEnd < 0) {
      throw new Error('PostgreSQL startup parameter value is missing its NUL terminator');
    }
    const name = decodeStartupText(frame.subarray(offset, nameEnd), 'parameter name');
    const value = decodeStartupText(frame.subarray(valueOffset, valueEnd), `parameter ${name}`);
    // PostgreSQL's ProcessStartupPacket applies parameters in packet order,
    // so a repeated key deliberately replaces its earlier value.
    parameters.set(name, value);
    offset = valueEnd + 1;
  }

  const username = parameters.get('user');
  if (username === undefined || username.length === 0) {
    throw new Error('PostgreSQL startup packet requires a non-empty user parameter');
  }
  const normalizedUsername = truncatePostgresIdentifier(username);
  const database = parameters.get('database');
  return {
    username: normalizedUsername,
    database:
      database === undefined || database.length === 0
        ? normalizedUsername
        : truncatePostgresIdentifier(database),
  };
}

function assertStartupIdentity(
  frame: Uint8Array,
  expected: Readonly<{ username: string; database: string }>,
): void {
  const actual = parseStartupIdentity(frame);
  const expectedUsername = truncatePostgresIdentifier(expected.username);
  const expectedDatabase =
    expected.database.length === 0
      ? expectedUsername
      : truncatePostgresIdentifier(expected.database);
  if (actual.username !== expectedUsername) {
    throw new Error(
      `PostgreSQL startup user ${JSON.stringify(actual.username)} does not match endpoint user ${JSON.stringify(expectedUsername)}`,
    );
  }
  if (actual.database !== expectedDatabase) {
    throw new Error(
      `PostgreSQL startup database ${JSON.stringify(actual.database)} does not match endpoint database ${JSON.stringify(expectedDatabase)}`,
    );
  }
}

function truncatePostgresIdentifier(value: string): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > POSTGRES_IDENTIFIER_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function decodeStartupText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`PostgreSQL startup ${label} is not valid UTF-8`, { cause: error });
  }
}

export class FrontendFrameReader {
  #buffer = new Uint8Array();
  #start = 0;
  #end = 0;
  #pullFrame: Uint8Array | undefined;
  #pullOffset = 0;

  append(input: Uint8Array): void {
    if (input.length === 0) return;
    const buffered = this.#end - this.#start;
    if (input.length > this.#buffer.length - this.#end) {
      if (input.length <= this.#buffer.length - buffered) {
        this.#buffer.copyWithin(0, this.#start, this.#end);
      } else {
        const required = buffered + input.length;
        const capacity = Math.max(
          required,
          this.#buffer.length === 0 ? 1024 : this.#buffer.length * 2,
        );
        const grown = new Uint8Array(capacity);
        grown.set(this.#buffer.subarray(this.#start, this.#end));
        this.#buffer = grown;
      }
      this.#start = 0;
      this.#end = buffered;
    }
    this.#buffer.set(input, this.#end);
    this.#end += input.length;
  }

  shift(): Uint8Array | undefined {
    if (this.#pullFrame !== undefined) {
      throw new Error('PostgreSQL frontend pull frame is still active');
    }
    const length = frontendFrameLength(this.#buffer.subarray(this.#start, this.#end));
    if (length === undefined) return undefined;
    const frame = this.#buffer.slice(this.#start, this.#start + length);
    this.#start += length;
    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    }
    return frame;
  }

  /** Supply at most one complete frontend frame at a time to COPY's pull transport. */
  readFrameChunk(maximumBytes: number, read: () => Uint8Array): Uint8Array {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new TypeError('maximum frontend byte count must be a positive integer');
    }
    while (this.#pullFrame === undefined) {
      const frame = this.shift();
      if (frame !== undefined) {
        this.#pullFrame = frame;
        this.#pullOffset = 0;
        break;
      }
      const input = read();
      if (input.length === 0) {
        this.finish();
        return input;
      }
      this.append(input);
    }
    const frame = this.#pullFrame;
    if (frame === undefined) return new Uint8Array();
    const end = Math.min(frame.length, this.#pullOffset + maximumBytes);
    // The pull callback consumes the bytes synchronously, so retain a view of
    // the already-owned frame instead of copying every COPY input chunk.
    const output = frame.subarray(this.#pullOffset, end);
    this.#pullOffset = end;
    if (end === frame.length) {
      this.#pullFrame = undefined;
      this.#pullOffset = 0;
    }
    return output;
  }

  finishPull(): void {
    if (this.#pullFrame !== undefined) {
      throw new Error('PostgreSQL COPY input stopped inside a frontend message');
    }
  }

  finish(): void {
    this.finishPull();
    if (this.#start !== this.#end) {
      throw new Error('PostgreSQL frontend connection ended inside a message');
    }
  }
}

function frontendFrameLength(input: Uint8Array): number | undefined {
  if (input.length < 4) return undefined;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input[0] === 0) {
    const length = view.getInt32(0);
    validateFrontendLength(length, 8, 'startup/control packet');
    return input.length >= length ? length : undefined;
  }
  if (input.length < 5) return undefined;
  const bodyLength = view.getInt32(1);
  validateFrontendLength(bodyLength, 4, 'frontend message');
  const length = bodyLength + 1;
  if (length > MAX_FRONTEND_MESSAGE_BYTES) {
    throw new Error(`PostgreSQL frontend message length ${length} exceeds limit`);
  }
  return input.length >= length ? length : undefined;
}

function validateFrontendLength(length: number, minimum: number, label: string): void {
  if (length < minimum) throw new Error(`invalid PostgreSQL ${label} length ${length}`);
  if (length > MAX_FRONTEND_MESSAGE_BYTES) {
    throw new Error(`PostgreSQL ${label} length ${length} exceeds limit`);
  }
}

/** @internal Hold only ReadyForQuery while streaming every preceding backend message. */
export class BackendResponseGate {
  #header = new Uint8Array(5);
  #headerLength = 0;
  #tag = 0;
  #bodyRemaining = 0;
  #ready: Uint8Array | undefined;

  push(input: Uint8Array, write: (chunk: Uint8Array) => void): void {
    if (this.#ready !== undefined && this.#bodyRemaining === 0) {
      throw new Error('PostgreSQL backend returned bytes after ReadyForQuery');
    }
    // One PostgreSQL host callback may contain many protocol messages. Keep
    // their non-Ready bytes in one bounded write so the shared channel pays
    // for one wakeup, while still flushing before this callback returns. The
    // extra five bytes cover a header begun by the preceding callback.
    const output = new Uint8Array(input.length + 5);
    let outputLength = 0;
    const append = (chunk: Uint8Array): void => {
      output.set(chunk, outputLength);
      outputLength += chunk.length;
    };
    let offset = 0;
    while (offset < input.length) {
      if (this.#bodyRemaining === 0) {
        if (this.#ready !== undefined) {
          throw new Error('PostgreSQL backend returned bytes after ReadyForQuery');
        }
        const copied = Math.min(5 - this.#headerLength, input.length - offset);
        this.#header.set(input.subarray(offset, offset + copied), this.#headerLength);
        this.#headerLength += copied;
        offset += copied;
        if (this.#headerLength < 5) continue;
        this.#tag = this.#header[0] ?? 0;
        const length = new DataView(this.#header.buffer).getInt32(1);
        if (length < 4) throw new Error(`invalid PostgreSQL backend message length ${length}`);
        this.#bodyRemaining = length - 4;
        if (this.#tag === 'Z'.charCodeAt(0)) {
          if (this.#bodyRemaining !== 1) {
            throw new Error(
              `PostgreSQL ReadyForQuery body length ${this.#bodyRemaining}, expected 1`,
            );
          }
          this.#ready = new Uint8Array(6);
          this.#ready.set(this.#header);
        } else {
          append(this.#header);
        }
        this.#headerLength = 0;
        if (this.#bodyRemaining === 0) continue;
      }
      const copied = Math.min(this.#bodyRemaining, input.length - offset);
      const body = input.subarray(offset, offset + copied);
      if (this.#ready !== undefined) {
        this.#ready.set(body, 6 - this.#bodyRemaining);
      } else {
        append(body);
      }
      this.#bodyRemaining -= copied;
      offset += copied;
    }
    if (outputLength !== 0) write(output.subarray(0, outputLength));
  }

  finish(): Readonly<{ status: number; frame: Uint8Array }> | undefined {
    if (this.#headerLength !== 0 || this.#bodyRemaining !== 0) {
      throw new Error('PostgreSQL backend response ended inside a message');
    }
    if (this.#ready === undefined) return undefined;
    const status = this.#ready[5];
    if (
      status !== 'I'.charCodeAt(0) &&
      status !== 'T'.charCodeAt(0) &&
      status !== 'E'.charCodeAt(0)
    ) {
      throw new Error(`PostgreSQL ReadyForQuery contained invalid transaction status ${status}`);
    }
    return { status, frame: this.#ready };
  }
}
