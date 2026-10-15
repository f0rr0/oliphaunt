import { parseJsonWithUniqueObjectKeys } from './database-root.js';

export type OpfsSyncAccess = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
};

// Two independently checked commit slots protect the last acknowledged end
// while its replacement is written. These sizes define the on-disk format.
const MAGIC = 0x4f504a32;
const SLOT_BYTES = 24;
const DATA_OFFSET = SLOT_BYTES * 2;
const FRAME_HEADER_BYTES = 24;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type OpfsJournalFrame = Readonly<{ metadata: unknown; data: Uint8Array }>;

export function emptyOpfsJournal(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(DATA_OFFSET);
  bytes.set(commitSlot(0, DATA_OFFSET));
  return bytes;
}

/** Append-only until the owning pool atomically publishes a replacement log. */
export class OpfsJournal {
  readonly #access: OpfsSyncAccess;
  #sequence: number;
  #end: number;

  constructor(access: OpfsSyncAccess) {
    this.#access = access;
    const bytes = new Uint8Array(DATA_OFFSET);
    readOpfsBytes(access, bytes, 0);
    const committed = readCommit(bytes, access.getSize());
    this.#sequence = committed.sequence;
    this.#end = committed.end;
  }

  get changed(): boolean {
    return this.#sequence !== 0;
  }

  append(metadata: unknown, parts: readonly Uint8Array[]): void {
    const encoded = encoder.encode(JSON.stringify(metadata));
    const sequence = this.#sequence + 1;
    const dataLength = parts.reduce((size, part) => size + part.byteLength, 0);
    const end = this.#end + FRAME_HEADER_BYTES + encoded.byteLength + dataLength;
    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(sequence)) {
      throw new Error('OPFS journal exceeds safe integer offsets');
    }
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setBigUint64(0, BigInt(sequence), true);
    view.setUint32(8, encoded.byteLength, true);
    view.setBigUint64(12, BigInt(dataLength), true);
    let checksum = crc32(header.subarray(0, 20));
    checksum = crc32(encoded, checksum);
    for (const part of parts) checksum = crc32(part, checksum);
    view.setUint32(20, checksum, true);
    writeOpfsBytes(this.#access, header, this.#end);
    let offset = this.#end + FRAME_HEADER_BYTES;
    for (const part of [encoded, ...parts]) {
      writeOpfsBytes(this.#access, part, offset);
      offset += part.byteLength;
    }
    // No published backing may change until both the record and its committed
    // position are flushed. A failed append leaves the previous slot usable.
    this.#access.flush();
    writeOpfsBytes(this.#access, commitSlot(sequence, end), (sequence % 2) * SLOT_BYTES);
    this.#access.flush();
    this.#sequence = sequence;
    this.#end = end;
  }

  /** Only valid when the owning snapshot already describes the current tree. */
  resetRedundant(): void {
    if (!this.changed) return;
    const empty = commitSlot(0, DATA_OFFSET);
    // First replace the older slot. An interruption then selects either the
    // complete redundant log or the already-equivalent owning snapshot.
    writeOpfsBytes(this.#access, empty, (1 - (this.#sequence % 2)) * SLOT_BYTES);
    this.#access.flush();
    writeOpfsBytes(this.#access, empty, (this.#sequence % 2) * SLOT_BYTES);
    this.#access.flush();
    this.#access.truncate(DATA_OFFSET);
    this.#access.flush();
    this.#sequence = 0;
    this.#end = DATA_OFFSET;
  }

  close(): void {
    this.#access.close();
  }
}

/** Read only committed ranges; an interrupted, uncommitted tail is disposable. */
export async function* readOpfsJournal(
  handle: FileSystemFileHandle,
): AsyncGenerator<OpfsJournalFrame> {
  const file = await handle.getFile();
  const read = async (start: number, end: number): Promise<Uint8Array> =>
    new Uint8Array(await file.slice(start, end).arrayBuffer());
  const committed = readCommit(await read(0, DATA_OFFSET), file.size);
  let offset = DATA_OFFSET;
  let sequence = 0;
  while (offset < committed.end) {
    const header = await read(offset, offset + FRAME_HEADER_BYTES);
    if (header.byteLength !== FRAME_HEADER_BYTES) throw invalidJournal();
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const nextSequence = Number(view.getBigUint64(0, true));
    const metadataLength = view.getUint32(8, true);
    const dataLength = Number(view.getBigUint64(12, true));
    const end = offset + FRAME_HEADER_BYTES + metadataLength + dataLength;
    if (nextSequence !== sequence + 1 || !Number.isSafeInteger(end) || end > committed.end) {
      throw invalidJournal();
    }
    const metadata = await read(offset + FRAME_HEADER_BYTES, end - dataLength);
    const data = await read(end - dataLength, end);
    if (
      metadata.byteLength !== metadataLength ||
      data.byteLength !== dataLength ||
      crc32(data, crc32(metadata, crc32(header.subarray(0, 20)))) !== view.getUint32(20, true)
    ) {
      throw invalidJournal();
    }
    yield { metadata: parseJsonWithUniqueObjectKeys(decoder.decode(metadata)), data };
    offset = end;
    sequence = nextSequence;
  }
  if (sequence !== committed.sequence) throw invalidJournal();
}

export async function openOpfsAccess(handle: FileSystemFileHandle): Promise<OpfsSyncAccess> {
  const file = handle as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<OpfsSyncAccess>;
  };
  if (file.createSyncAccessHandle === undefined) {
    throw new DOMException('OPFS synchronous access is unavailable', 'NotSupportedError');
  }
  return file.createSyncAccessHandle();
}

export function readOpfsBytes(access: OpfsSyncAccess, bytes: Uint8Array, offset: number): void {
  transfer(bytes, offset, (chunk, at) => access.read(chunk, { at }));
}

export function writeOpfsBytes(access: OpfsSyncAccess, bytes: Uint8Array, offset: number): void {
  transfer(bytes, offset, (chunk, at) => access.write(chunk, { at }));
}

function transfer(
  bytes: Uint8Array,
  offset: number,
  operation: (chunk: Uint8Array, at: number) => number,
): void {
  let done = 0;
  while (done < bytes.byteLength) {
    const count = operation(bytes.subarray(done), offset + done);
    validateOpfsProgress(count, bytes.byteLength - done, 'I/O');
    done += count;
  }
}

export function validateOpfsProgress(
  transferred: number,
  available: number,
  operation: string,
): void {
  if (
    !Number.isSafeInteger(transferred) ||
    transferred < 0 ||
    transferred > available ||
    (available > 0 && transferred === 0)
  ) {
    throw new Error(`OPFS synchronous ${operation} made invalid progress`);
  }
}

function commitSlot(sequence: number, end: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(SLOT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setBigUint64(4, BigInt(sequence), true);
  view.setBigUint64(12, BigInt(end), true);
  view.setUint32(20, crc32(bytes.subarray(0, 20)), true);
  return bytes;
}

function readCommit(bytes: Uint8Array, size: number): { sequence: number; end: number } {
  const slots: { sequence: number; end: number }[] = [];
  for (let offset = 0; offset + SLOT_BYTES <= bytes.byteLength; offset += SLOT_BYTES) {
    const slot = bytes.subarray(offset, offset + SLOT_BYTES);
    const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength);
    if (
      view.getUint32(0, true) !== MAGIC ||
      view.getUint32(20, true) !== crc32(slot.subarray(0, 20))
    )
      continue;
    const sequence = Number(view.getBigUint64(4, true));
    const end = Number(view.getBigUint64(12, true));
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(end) || end < DATA_OFFSET)
      throw invalidJournal();
    slots.push({ sequence, end });
  }
  const committed = slots.sort((left, right) => right.sequence - left.sequence)[0];
  if (committed === undefined || committed.end > size) throw invalidJournal();
  return committed;
}

// IEEE CRC-32, shared by frame bodies and commit slots. A table keeps large
// overflow images linear without doing eight polynomial steps for every byte.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Uint8Array, previous = 0): number {
  let value = previous ^ 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 0xff] as number);
  return (value ^ 0xffffffff) >>> 0;
}

function invalidJournal(): Error {
  return new Error('OPFS journal has invalid committed metadata');
}
