import {
  closeWasixByteChannel,
  type WasixByteChannel,
  readWasixByteChannelSync,
  writeWasixByteChannelSync,
} from './byte-channel.js';

const SSL_REQUEST = 80_877_103;
const GSSENC_REQUEST = 80_877_104;
const CANCEL_REQUEST = 80_877_102;
const PROTOCOL_3 = 196_608;
const MAX_FRONTEND_MESSAGE_BYTES = 128 * 1024 * 1024;

export type WasixProtocolConnection = Readonly<{
  frontend: WasixByteChannel;
  backend: WasixByteChannel;
}>;

export type WasixProtocolExecutor = Readonly<{
  startupResponse: Uint8Array;
  execDuplex(
    input: Uint8Array,
    onRead: (maximumBytes: number) => Uint8Array,
    onWrite: (chunk: Uint8Array) => void,
  ): void;
  publishIdle(): Promise<void>;
  rollback(): Promise<void>;
}>;

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

export class FrontendFrameReader {
  #buffer = new Uint8Array();
  #pullFrame: Uint8Array | undefined;
  #pullOffset = 0;

  append(input: Uint8Array): void {
    if (input.length === 0) return;
    const combined = new Uint8Array(this.#buffer.length + input.length);
    combined.set(this.#buffer);
    combined.set(input, this.#buffer.length);
    this.#buffer = combined;
  }

  shift(): Uint8Array | undefined {
    if (this.#pullFrame !== undefined) {
      throw new Error('PostgreSQL frontend pull frame is still active');
    }
    const length = frontendFrameLength(this.#buffer);
    if (length === undefined) return undefined;
    const frame = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
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
    const output = frame.slice(this.#pullOffset, end);
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
    if (this.#buffer.length !== 0) {
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
          write(this.#header.slice());
        }
        this.#headerLength = 0;
        if (this.#bodyRemaining === 0) continue;
      }
      const copied = Math.min(this.#bodyRemaining, input.length - offset);
      const body = input.subarray(offset, offset + copied);
      if (this.#ready !== undefined) {
        this.#ready.set(body, 6 - this.#bodyRemaining);
      } else {
        write(body.slice());
      }
      this.#bodyRemaining -= copied;
      offset += copied;
    }
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
