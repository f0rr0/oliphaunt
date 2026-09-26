const READ_OFFSET = 0;
const WRITE_OFFSET = 1;
const CLOSED = 2;
const FAILED = 3;
const PROTOCOL_STATE = 4;
const CONTROL_WORDS = 5;
const PROTOCOL_IDLE = 0;
const PROTOCOL_ACTIVE = 1;
const PROTOCOL_COMPLETE = 2;

const WASIX_BYTE_CHANNEL_CHUNK_BYTES = 64 * 1024;
const WASIX_CHANNEL_BYTES = 256 * 1024 + 1;

/** @internal One bounded single-producer/single-consumer byte channel. */
export type WasixByteChannel = Readonly<{
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
}>;

/** @internal Allocate the fixed-capacity transport used by tools and local sockets. */
export function createWasixByteChannel(): WasixByteChannel {
  return {
    control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CONTROL_WORDS),
    data: new SharedArrayBuffer(WASIX_CHANNEL_BYTES),
  };
}

/** @internal Signal orderly producer EOF. */
export function closeWasixByteChannel(channel: WasixByteChannel): void {
  const control = channelControl(channel);
  Atomics.store(control, CLOSED, 1);
  Atomics.notify(control, READ_OFFSET);
  Atomics.notify(control, WRITE_OFFSET);
}

/** @internal Signal an unrecoverable transport failure. */
export function failWasixByteChannel(channel: WasixByteChannel): void {
  const control = channelControl(channel);
  Atomics.store(control, FAILED, 1);
  Atomics.store(control, CLOSED, 1);
  Atomics.notify(control, READ_OFFSET);
  Atomics.notify(control, WRITE_OFFSET);
}

/** @internal Record that a tool has entered its PostgreSQL protocol callback. */
export function markWasixByteChannelProtocolStarted(channel: WasixByteChannel): void {
  Atomics.store(channelControl(channel), PROTOCOL_STATE, PROTOCOL_ACTIVE);
}

/** @internal Record successful process completion before exposing orderly EOF. */
export function markWasixByteChannelProtocolComplete(channel: WasixByteChannel): void {
  Atomics.compareExchange(
    channelControl(channel),
    PROTOCOL_STATE,
    PROTOCOL_ACTIVE,
    PROTOCOL_COMPLETE,
  );
}

/** @internal Observe protocol activity across the tool/database worker boundary. */
export function wasixByteChannelProtocolStarted(channel: WasixByteChannel): boolean {
  return Atomics.load(channelControl(channel), PROTOCOL_STATE) !== PROTOCOL_IDLE;
}

/** @internal Whether a failed tool may have left an unobserved PostgreSQL outcome. */
export function wasixByteChannelProtocolOutcomeUnknown(channel: WasixByteChannel): boolean {
  return Atomics.load(channelControl(channel), PROTOCOL_STATE) === PROTOCOL_ACTIVE;
}

/** @internal Blocking read for a dedicated worker realm. Empty bytes mean EOF. */
export function readWasixByteChannelSync(
  channel: WasixByteChannel,
  maximumBytes = WASIX_BYTE_CHANNEL_CHUNK_BYTES,
): Uint8Array {
  const control = channelControl(channel);
  const data = new Uint8Array(channel.data);
  for (;;) {
    assertChannelHealthy(control);
    const read = Atomics.load(control, READ_OFFSET);
    const write = Atomics.load(control, WRITE_OFFSET);
    if (read !== write) return consume(control, data, read, write, maximumBytes);
    if (Atomics.load(control, CLOSED) !== 0) return new Uint8Array();
    Atomics.wait(control, WRITE_OFFSET, write);
  }
}

/** @internal Blocking write for a dedicated worker realm. */
export function writeWasixByteChannelSync(channel: WasixByteChannel, input: Uint8Array): void {
  const control = channelControl(channel);
  const data = new Uint8Array(channel.data);
  let offset = 0;
  while (offset < input.length) {
    assertChannelWritable(control);
    const read = Atomics.load(control, READ_OFFSET);
    const write = Atomics.load(control, WRITE_OFFSET);
    const writable = writableBytes(read, write, data.length);
    if (writable === 0) {
      Atomics.wait(control, READ_OFFSET, read);
      continue;
    }
    const copied = produce(control, data, write, input.subarray(offset), writable);
    offset += copied;
  }
}

/** @internal Non-blocking-realm read. Empty bytes mean EOF. */
export async function readWasixByteChannel(
  channel: WasixByteChannel,
  maximumBytes = WASIX_BYTE_CHANNEL_CHUNK_BYTES,
): Promise<Uint8Array> {
  const control = channelControl(channel);
  const data = new Uint8Array(channel.data);
  for (;;) {
    assertChannelHealthy(control);
    const read = Atomics.load(control, READ_OFFSET);
    const write = Atomics.load(control, WRITE_OFFSET);
    if (read !== write) return consume(control, data, read, write, maximumBytes);
    if (Atomics.load(control, CLOSED) !== 0) return new Uint8Array();
    await waitForChange(control, WRITE_OFFSET, write);
  }
}

/** @internal Non-blocking-realm write with bounded backpressure. */
export async function writeWasixByteChannel(
  channel: WasixByteChannel,
  input: Uint8Array,
): Promise<void> {
  const control = channelControl(channel);
  const data = new Uint8Array(channel.data);
  let offset = 0;
  while (offset < input.length) {
    assertChannelWritable(control);
    const read = Atomics.load(control, READ_OFFSET);
    const write = Atomics.load(control, WRITE_OFFSET);
    const writable = writableBytes(read, write, data.length);
    if (writable === 0) {
      await waitForChange(control, READ_OFFSET, read);
      continue;
    }
    const copied = produce(control, data, write, input.subarray(offset), writable);
    offset += copied;
  }
}

function channelControl(channel: WasixByteChannel): Int32Array {
  if (
    !(channel.control instanceof SharedArrayBuffer) ||
    channel.control.byteLength !== Int32Array.BYTES_PER_ELEMENT * CONTROL_WORDS ||
    !(channel.data instanceof SharedArrayBuffer) ||
    channel.data.byteLength !== WASIX_CHANNEL_BYTES
  ) {
    throw new TypeError('invalid Oliphaunt WASIX byte channel');
  }
  return new Int32Array(channel.control);
}

function consume(
  control: Int32Array,
  data: Uint8Array,
  read: number,
  write: number,
  maximumBytes: number,
): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('maximum byte count must be a positive integer');
  }
  const available = write >= read ? write - read : data.length - read;
  const count = Math.min(available, maximumBytes);
  const output = data.slice(read, read + count);
  Atomics.store(control, READ_OFFSET, (read + count) % data.length);
  Atomics.notify(control, READ_OFFSET);
  return output;
}

function writableBytes(read: number, write: number, capacity: number): number {
  if (write < read) return read - write - 1;
  if (read === 0) return capacity - write - 1;
  return capacity - write;
}

function produce(
  control: Int32Array,
  data: Uint8Array,
  write: number,
  input: Uint8Array,
  writable: number,
): number {
  const count = Math.min(writable, input.length, WASIX_BYTE_CHANNEL_CHUNK_BYTES);
  data.set(input.subarray(0, count), write);
  Atomics.store(control, WRITE_OFFSET, (write + count) % data.length);
  Atomics.notify(control, WRITE_OFFSET);
  return count;
}

function assertChannelHealthy(control: Int32Array): void {
  if (Atomics.load(control, FAILED) !== 0) {
    throw new Error('Oliphaunt WASIX byte channel failed');
  }
}

function assertChannelWritable(control: Int32Array): void {
  assertChannelHealthy(control);
  if (Atomics.load(control, CLOSED) !== 0) {
    throw new Error('Oliphaunt WASIX byte channel is closed');
  }
}

async function waitForChange(control: Int32Array, index: number, expected: number): Promise<void> {
  const waitAsync = (
    Atomics as typeof Atomics & {
      waitAsync?: (
        typedArray: Int32Array,
        index: number,
        value: number,
      ) => { async: false; value: string } | { async: true; value: Promise<string> };
    }
  ).waitAsync;
  if (waitAsync !== undefined) {
    const waiting = waitAsync(control, index, expected);
    if (waiting.async) await waiting.value;
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}
