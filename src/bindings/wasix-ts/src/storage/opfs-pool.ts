import type { WasixDirectoryMount } from '../archive.js';
import { parseJsonWithUniqueObjectKeys } from '../database-root.js';
import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import {
  assertWasixPhysicalIdentity,
  physicalIdentityMatches,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
  type WasixStorageSyncBoundary,
} from '../storage-provider.js';
import {
  type StorageDelta,
  type StoredSnapshot,
  splitStorageDeltaDeletes,
  VOLATILE_DATABASE_FILES,
  validateDirectoryEntryName,
  validateStoredSnapshot,
} from '../storage-snapshot.js';

export const OPFS_POOL_ROOT = '.oliphaunt-wasix-pool-v1';

const STATE_FILE = 'state.json';
const DATA_DIRECTORY = 'data';
const STATE_SCHEMA = 'oliphaunt-wasix-opfs-pool-v1';
const PREOPENED_FILE_RESERVE = 32;
const MAX_PARALLEL_IO = 16;
const TYPE_FILE = 1;
const TYPE_DIRECTORY = 2;

const OP = {
  metadata: 1,
  readDirectory: 2,
  createDirectory: 3,
  removeDirectory: 4,
  rename: 5,
  removeFile: 6,
  open: 7,
  close: 8,
  read: 9,
  write: 10,
  flush: 11,
  truncate: 12,
  unlink: 13,
  fileSize: 14,
} as const;

const RESULT = {
  ok: 0,
  notFound: 1,
  exists: 2,
  notDirectory: 3,
  notFile: 4,
  directoryNotEmpty: 5,
  permission: 6,
  invalid: 7,
  storageFull: 8,
  unsupported: 9,
  timeout: 10,
  io: 11,
} as const;

const FLAG_WRITE = 1 << 1;
const FLAG_CREATE_NEW = 1 << 2;
const FLAG_CREATE = 1 << 3;
const FLAG_APPEND = 1 << 4;
const FLAG_TRUNCATE = 1 << 5;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_ENCODER = new TextEncoder();

type SyncAccessHandle = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
};

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
};

type StoredDirectory = Readonly<{ path: string; type: 'directory' }>;
type StoredFile = Readonly<{ path: string; type: 'file'; backing: string }>;
type StoredEntry = StoredDirectory | StoredFile;

type PoolState = Readonly<{
  schema: typeof STATE_SCHEMA;
  name: string;
  phase: 'initializing' | 'ready';
  physicalIdentity: WasixPhysicalIdentity;
  entries: readonly StoredEntry[];
}>;

export type PooledOpfsDatabase = Readonly<{
  snapshot: StoredSnapshot | undefined;
  state: 'new' | 'existing';
}>;

type FileRecord = {
  path?: string;
  backing?: string;
  access?: SyncAccessHandle;
  staged?: Uint8Array;
  stagedSize?: number;
  references: number;
  dirty: boolean;
};

type DirectoryEntry = Readonly<{ type: 'directory' }>;
type FileEntry = Readonly<{ type: 'file'; record: FileRecord }>;
type LiveEntry = DirectoryEntry | FileEntry;
type Descriptor = Readonly<{ record: FileRecord; append: boolean }>;
type BridgeResult = [result: number, responseLength: number, value0: number, value1: number];

/**
 * A same-realm synchronous OPFS filesystem for the WASIX host.
 *
 * Logical PostgreSQL paths live in one atomic state file while relation bytes
 * live in flat, pre-opened backing files. That deliberate opacity removes all
 * asynchronous OPFS namespace calls from PostgreSQL's hot syscall path.
 */
export class DirectOpfsPool {
  readonly state: 'new' | 'existing';
  readonly request: (
    opcode: number,
    path: string,
    buffer: Uint8Array,
    arg0: number,
    arg1: number,
    flags: number,
  ) => BridgeResult;

  readonly #name: string;
  readonly #database: FileSystemDirectoryHandle;
  readonly #data: FileSystemDirectoryHandle;
  readonly #physicalIdentity: WasixPhysicalIdentity;
  readonly #entries = new Map<string, LiveEntry>();
  readonly #children = new Map<string, Map<string, LiveEntry>>();
  readonly #descriptors = new Map<number, Descriptor>();
  readonly #records = new Set<FileRecord>();
  readonly #dirty = new Set<FileRecord>();
  readonly #spares: FileRecord[] = [];
  readonly #pendingReclaims = new Set<FileRecord>();
  #initializationComplete: boolean;
  #nextDescriptor = 1;
  #namespaceDirty = false;
  #closed = false;

  private constructor(
    name: string,
    database: FileSystemDirectoryHandle,
    data: FileSystemDirectoryHandle,
    physicalIdentity: WasixPhysicalIdentity,
    state: 'new' | 'existing',
  ) {
    this.#name = name;
    this.#database = database;
    this.#data = data;
    this.#physicalIdentity = physicalIdentity;
    this.state = state;
    this.#initializationComplete = state === 'existing';
    this.#entries.set('', { type: 'directory' });
    this.request = (opcode, path, buffer, arg0, arg1, flags) => {
      if (this.#closed) return [RESULT.io, 0, 0, 0];
      try {
        return this.#dispatch(opcode, path, buffer, arg0, arg1, flags);
      } catch (error) {
        return [classifyError(error), 0, 0, 0];
      }
    };
  }

  static async open(
    name: string,
    loadClusterSeed: WasixClusterSeedLoader,
    physicalIdentity: WasixPhysicalIdentity,
  ): Promise<DirectOpfsPool> {
    const selectedIdentity = assertWasixPhysicalIdentity(physicalIdentity);
    const database = await openPooledDatabaseDirectory(name);
    let data = await database.getDirectoryHandle(DATA_DIRECTORY, { create: true });
    let stored = await readPoolState(database, name, selectedIdentity);
    if (stored?.phase === 'initializing') {
      ({ data, state: stored } = await resetPoolClusterSeed(
        database,
        name,
        await loadClusterSeed(),
        selectedIdentity,
      ));
    } else if (stored === undefined) {
      stored = await initializePoolState(
        database,
        data,
        name,
        await loadClusterSeed(),
        selectedIdentity,
      );
    }
    const state = stored.phase === 'ready' ? 'existing' : 'new';
    const pool = new DirectOpfsPool(name, database, data, selectedIdentity, state);
    try {
      await pool.#hydrate(stored);
      await pool.#restoreSpares();
      await pool.#removeVolatileEntries();
      await pool.#maintainSpares();
      return pool;
    } catch (error) {
      try {
        pool.#closeHandles(false);
      } catch (closeError) {
        const primary = error instanceof Error ? error : new Error(describeError(error));
        throw composeWasixStorageFailure(
          primary,
          'direct OPFS handle cleanup also failed',
          closeError,
        );
      }
      throw error;
    }
  }

  async sync(boundary: WasixStorageSyncBoundary): Promise<void> {
    this.#assertOpen();
    if (boundary === 'checkpoint' || boundary === 'close') this.#flushAll();
    else this.#flushWal();

    await this.#materializeStagedFiles();
    const completesInitialization = !this.#initializationComplete && boundary === 'checkpoint';
    if (this.#namespaceDirty || completesInitialization) {
      // A namespace publication makes newly mapped bytes reachable. Reuse the
      // complete PostgreSQL order instead of depending on map insertion order.
      this.#flushAll();
      await writePoolState(
        this.#database,
        serializePoolState(
          this.#name,
          this.#physicalIdentity,
          this.#entries,
          this.#initializationComplete || completesInitialization ? 'ready' : 'initializing',
        ),
      );
      this.#namespaceDirty = false;
      if (completesInitialization) this.#initializationComplete = true;
    }
    this.#publishReclaims();
    if (boundary !== 'close') {
      // The boundary is already durable. Spare replenishment is only an
      // optimization for the next synchronous file-creation burst and must
      // never turn a successful publication into an ambiguous failure.
      await this.#maintainSpares().catch(() => undefined);
    }
  }

  async close(clean: boolean): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    if (clean) {
      try {
        await this.sync('close');
      } catch (error) {
        failure = error;
      }
    }
    this.#closed = true;
    try {
      this.#closeHandles(clean);
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error]);
    }
    if (failure !== undefined) throw failure;
  }

  #dispatch(
    opcode: number,
    path: string,
    buffer: Uint8Array,
    arg0: number,
    arg1: number,
    flags: number,
  ): BridgeResult {
    switch (opcode) {
      case OP.metadata:
        return this.#metadata(path);
      case OP.readDirectory:
        return this.#readDirectory(path, arg0, buffer);
      case OP.createDirectory:
        this.#createDirectory(path);
        break;
      case OP.removeDirectory:
        this.#removeDirectory(path);
        break;
      case OP.rename:
        // wasm-bindgen views the threaded host memory through SharedArrayBuffer;
        // TextDecoder deliberately rejects shared views, so copy only the rare
        // rename payload. Data I/O still uses the exact requested ranges and
        // avoids the retired copied mailbox.
        this.#rename(path, UTF8_DECODER.decode(Uint8Array.from(buffer)));
        break;
      case OP.removeFile:
        this.#removeFile(path);
        break;
      case OP.open:
        return this.#open(path, flags);
      case OP.close:
        this.#closeDescriptor(arg0);
        break;
      case OP.read:
        return this.#read(arg0, arg1, buffer);
      case OP.write:
        return this.#write(arg0, arg1, buffer);
      case OP.flush:
        this.#flushRecord(this.#descriptor(arg0).record);
        break;
      case OP.truncate:
        this.#truncate(arg0, arg1);
        break;
      case OP.unlink:
        this.#unlinkDescriptor(arg0);
        break;
      case OP.fileSize:
        return [RESULT.ok, 0, this.#recordSize(this.#descriptor(arg0).record), 0];
      default:
        throw new DOMException('unsupported OPFS bridge operation', 'NotSupportedError');
    }
    return [RESULT.ok, 0, 0, 0];
  }

  #metadata(path: string): BridgeResult {
    validatePath(path, true);
    const entry = this.#entries.get(path);
    if (entry === undefined) throw notFound();
    return entry.type === 'directory'
      ? [RESULT.ok, 0, TYPE_DIRECTORY, 0]
      : [RESULT.ok, 0, TYPE_FILE, this.#recordSize(entry.record)];
  }

  #readDirectory(path: string, start: number, output: Uint8Array): BridgeResult {
    this.#requireDirectory(path, true);
    if (!Number.isSafeInteger(start) || start < 0) throw invalid();
    const entries = [...(this.#children.get(path)?.entries() ?? [])]
      .map(([name, entry]) => ({
        name,
        type: entry.type === 'directory' ? TYPE_DIRECTORY : TYPE_FILE,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (start > entries.length) throw invalid();
    const page = encodeDirectoryPage(entries, start, output.byteLength);
    output.set(page.bytes);
    return [RESULT.ok, page.bytes.byteLength, page.next, Number(page.next === entries.length)];
  }

  #createDirectory(path: string): void {
    validatePath(path);
    if (this.#entries.has(path)) throw new ExistsError();
    this.#requireDirectory(parentPath(path), true);
    this.#entries.set(path, { type: 'directory' });
    this.#rebuildChildren();
    this.#namespaceDirty = true;
  }

  #removeDirectory(path: string): void {
    this.#requireDirectory(path);
    if ((this.#children.get(path)?.size ?? 0) > 0) throw new DirectoryNotEmptyError();
    this.#entries.delete(path);
    this.#rebuildChildren();
    this.#namespaceDirty = true;
  }

  #rename(from: string, to: string): void {
    validatePath(from);
    validatePath(to);
    if (from === to) return;
    const source = this.#entries.get(from);
    if (source === undefined) throw notFound();
    this.#requireDirectory(parentPath(to), true);
    if (source.type === 'directory' && (to.startsWith(`${from}/`) || from === to)) throw invalid();
    const destination = this.#entries.get(to);
    if (destination !== undefined) {
      if (source.type !== destination.type) {
        throw source.type === 'directory' ? notDirectory() : notFile();
      }
      if (destination.type === 'directory') {
        if ((this.#children.get(to)?.size ?? 0) > 0) throw new DirectoryNotEmptyError();
      } else {
        this.#detach(destination.record);
      }
      this.#entries.delete(to);
    }
    const moved = [...this.#entries.entries()]
      .filter(([path]) => path === from || path.startsWith(`${from}/`))
      .sort(([left], [right]) => left.length - right.length);
    for (const [path] of moved) this.#entries.delete(path);
    for (const [path, entry] of moved) {
      const next = path === from ? to : `${to}${path.slice(from.length)}`;
      this.#entries.set(next, entry);
      if (entry.type === 'file') entry.record.path = next;
    }
    this.#rebuildChildren();
    this.#namespaceDirty = true;
  }

  #removeFile(path: string): void {
    const entry = this.#requireFile(path);
    this.#entries.delete(path);
    this.#detach(entry.record);
    this.#rebuildChildren();
    this.#namespaceDirty = true;
  }

  #open(path: string, flags: number): BridgeResult {
    validatePath(path);
    const existing = this.#entries.get(path);
    if ((flags & FLAG_CREATE_NEW) !== 0 && existing !== undefined) throw new ExistsError();
    let entry: FileEntry;
    if (existing === undefined) {
      if ((flags & (FLAG_CREATE | FLAG_CREATE_NEW)) === 0) throw notFound();
      this.#requireDirectory(parentPath(path), true);
      const record = this.#takeSpare(path);
      entry = { type: 'file', record };
      this.#entries.set(path, entry);
      this.#rebuildChildren();
      this.#namespaceDirty = true;
    } else {
      if (existing.type !== 'file') throw notFile();
      entry = existing;
    }
    if ((flags & FLAG_TRUNCATE) !== 0) {
      if ((flags & (FLAG_WRITE | FLAG_APPEND)) === 0) throw invalid();
      this.#setRecordSize(entry.record, 0);
    }
    const descriptor = this.#nextDescriptor++;
    entry.record.references += 1;
    this.#descriptors.set(descriptor, {
      record: entry.record,
      append: (flags & FLAG_APPEND) !== 0,
    });
    return [RESULT.ok, 0, descriptor, this.#recordSize(entry.record)];
  }

  #closeDescriptor(descriptor: number): void {
    const record = this.#descriptor(descriptor).record;
    this.#descriptors.delete(descriptor);
    record.references -= 1;
    if (record.references === 0 && record.path === undefined) this.#queueReclaim(record);
  }

  #read(descriptor: number, offset: number, output: Uint8Array): BridgeResult {
    validateOffset(offset);
    const record = this.#descriptor(descriptor).record;
    const available = Math.max(0, Math.min(output.byteLength, this.#recordSize(record) - offset));
    if (available === 0) return [RESULT.ok, 0, 0, 0];
    if (record.staged !== undefined) {
      output.set(record.staged.subarray(offset, offset + available));
    } else {
      const read = requireAccess(record).read(output.subarray(0, available), { at: offset });
      validateProgress(read, available, 'read');
      if (read !== available) return [RESULT.ok, read, 0, 0];
    }
    return [RESULT.ok, available, 0, 0];
  }

  #write(descriptor: number, offset: number, bytes: Uint8Array): BridgeResult {
    validateOffset(offset);
    const state = this.#descriptor(descriptor);
    const record = state.record;
    const writeOffset = state.append ? this.#recordSize(record) : offset;
    this.#markDirty(record);
    if (record.staged !== undefined) {
      const previousSize = this.#recordSize(record);
      const needed = writeOffset + bytes.byteLength;
      if (!Number.isSafeInteger(needed)) throw invalid();
      this.#ensureStagedCapacity(record, needed, previousSize);
      if (writeOffset > previousSize) record.staged.fill(0, previousSize, writeOffset);
      record.staged.set(bytes, writeOffset);
      record.stagedSize = Math.max(previousSize, needed);
    } else {
      const written = requireAccess(record).write(bytes, { at: writeOffset });
      validateProgress(written, bytes.byteLength, 'write');
      if (written !== bytes.byteLength) return [RESULT.ok, 0, written, writeOffset + written];
    }
    return [RESULT.ok, 0, bytes.byteLength, writeOffset + bytes.byteLength];
  }

  #truncate(descriptor: number, size: number): void {
    this.#setRecordSize(this.#descriptor(descriptor).record, size);
  }

  #unlinkDescriptor(descriptor: number): void {
    const record = this.#descriptor(descriptor).record;
    if (record.path === undefined) return;
    this.#entries.delete(record.path);
    this.#detach(record);
    this.#rebuildChildren();
    this.#namespaceDirty = true;
  }

  #recordSize(record: FileRecord): number {
    return record.staged === undefined
      ? requireAccess(record).getSize()
      : (record.stagedSize ?? record.staged.byteLength);
  }

  #setRecordSize(record: FileRecord, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw invalid();
    this.#markDirty(record);
    if (record.staged !== undefined) {
      const previousSize = this.#recordSize(record);
      this.#ensureStagedCapacity(record, size, previousSize);
      if (size !== previousSize) {
        record.staged.fill(0, Math.min(size, previousSize), Math.max(size, previousSize));
      }
      record.stagedSize = size;
    } else {
      requireAccess(record).truncate(size);
    }
  }

  #ensureStagedCapacity(record: FileRecord, size: number, previousSize: number): void {
    const staged = record.staged;
    if (staged === undefined || size <= staged.byteLength) return;
    try {
      const grown = new Uint8Array(Math.max(size, staged.byteLength * 2, 8 * 1024));
      grown.set(staged.subarray(0, previousSize));
      record.staged = grown;
    } catch (error) {
      throw new DOMException(
        `could not stage ${size} bytes: ${describeError(error)}`,
        'QuotaExceededError',
      );
    }
  }

  #markDirty(record: FileRecord): void {
    record.dirty = true;
    this.#dirty.add(record);
  }

  #flushRecord(record: FileRecord): void {
    // A staged file cannot be flushed synchronously because allocating its
    // OPFS backing is asynchronous. It remains dirty until the mandatory host
    // boundary materializes and flushes it before publishing the namespace.
    if (!record.dirty || record.staged !== undefined) return;
    requireAccess(record).flush();
    record.dirty = false;
    this.#dirty.delete(record);
  }

  #flushWal(): void {
    for (const record of [...this.#dirty]) {
      if (isWalRecord(record)) this.#flushRecord(record);
    }
  }

  #flushAll(): void {
    for (const record of [...this.#dirty].sort(compareFlushOrder)) this.#flushRecord(record);
  }

  #descriptor(value: number): Descriptor {
    if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
    const descriptor = this.#descriptors.get(value);
    if (descriptor === undefined) throw new DOMException('invalid descriptor', 'InvalidStateError');
    return descriptor;
  }

  #requireDirectory(path: string, allowRoot = false): DirectoryEntry {
    validatePath(path, allowRoot);
    const entry = this.#entries.get(path);
    if (entry === undefined) throw notFound();
    if (entry.type !== 'directory') throw notDirectory();
    return entry;
  }

  #requireFile(path: string): FileEntry {
    validatePath(path);
    const entry = this.#entries.get(path);
    if (entry === undefined) throw notFound();
    if (entry.type !== 'file') throw notFile();
    return entry;
  }

  #takeSpare(path: string): FileRecord {
    const record = this.#spares.pop();
    if (record !== undefined) {
      requireAccess(record).truncate(0);
      record.path = path;
      record.references = 0;
      this.#markDirty(record);
      return record;
    }
    const staged: FileRecord = {
      path,
      staged: new Uint8Array(),
      stagedSize: 0,
      references: 0,
      dirty: false,
    };
    this.#records.add(staged);
    return staged;
  }

  #detach(record: FileRecord): void {
    record.path = undefined;
    if (record.references === 0) this.#queueReclaim(record);
  }

  #queueReclaim(record: FileRecord): void {
    if (record.staged !== undefined) {
      this.#dirty.delete(record);
      this.#records.delete(record);
      return;
    }
    this.#pendingReclaims.add(record);
  }

  #publishReclaims(): void {
    for (const record of [...this.#pendingReclaims]) {
      record.dirty = false;
      this.#dirty.delete(record);
      this.#spares.push(record);
      this.#pendingReclaims.delete(record);
    }
  }

  async #hydrate(state: PoolState): Promise<void> {
    for (const entry of state.entries) {
      if (entry.type === 'directory') this.#entries.set(entry.path, { type: 'directory' });
    }
    const files = state.entries.filter((entry): entry is StoredFile => entry.type === 'file');
    await parallelMap(files, async (entry) => {
      let file: SyncFileHandle;
      try {
        file = (await this.#data.getFileHandle(entry.backing)) as SyncFileHandle;
      } catch (error) {
        if (errorName(error) === 'NotFoundError') {
          throw corrupt(
            this.#name,
            `is missing backing ${JSON.stringify(entry.backing)} for ${JSON.stringify(entry.path)}`,
            error,
          );
        }
        throw error;
      }
      const access = await createAccess(file);
      const record: FileRecord = {
        path: entry.path,
        backing: entry.backing,
        access,
        references: 0,
        dirty: false,
      };
      this.#records.add(record);
      this.#entries.set(entry.path, { type: 'file', record });
    });
    this.#rebuildChildren();
    this.#validateEssentials();
  }

  async #restoreSpares(): Promise<void> {
    const referenced = new Set(
      [...this.#records].flatMap((record) =>
        record.backing === undefined ? [] : [record.backing],
      ),
    );
    const unused: string[] = [];
    for await (const name of this.#data.keys()) {
      try {
        validateBackingName(name);
      } catch (error) {
        throw corrupt(this.#name, `contains invalid pool entry ${JSON.stringify(name)}`, error);
      }
      if (!referenced.has(name)) unused.push(name);
    }
    const keep = unused.sort().slice(0, PREOPENED_FILE_RESERVE);
    await parallelMap(keep, async (backing) => {
      const file = (await this.#data.getFileHandle(backing)) as SyncFileHandle;
      const access = await createAccess(file);
      const record: FileRecord = { backing, access, references: 0, dirty: false };
      this.#records.add(record);
      this.#spares.push(record);
    });
    await parallelMap(unused.slice(PREOPENED_FILE_RESERVE), (backing) =>
      this.#data.removeEntry(backing),
    );
  }

  async #maintainSpares(): Promise<void> {
    const missing = PREOPENED_FILE_RESERVE - this.#spares.length;
    if (missing <= 0) return;
    await parallelCreate(missing, async () => {
      const { backing, access } = await this.#createBacking();
      const record = { backing, access, references: 0, dirty: false } satisfies FileRecord;
      this.#records.add(record);
      this.#spares.push(record);
    });
  }

  async #materializeStagedFiles(): Promise<void> {
    const staged = [...this.#records]
      .filter((record) => record.staged !== undefined && record.path !== undefined)
      .sort(compareFlushOrder);
    await parallelMap(staged, async (record) => {
      const bytes = record.staged;
      if (bytes === undefined) throw new Error('staged OPFS record lost its bytes');
      const allocation = await this.#createBacking();
      try {
        writeComplete(allocation.access, bytes.subarray(0, this.#recordSize(record)), 0);
        allocation.access.flush();
      } catch (error) {
        throw await this.#discardBacking(allocation.backing, allocation.access, error);
      }
      record.backing = allocation.backing;
      record.access = allocation.access;
      record.staged = undefined;
      record.stagedSize = undefined;
      record.dirty = false;
      this.#dirty.delete(record);
    });
  }

  async #createBacking(): Promise<{ backing: string; access: SyncAccessHandle }> {
    const backing = newBackingName();
    let access: SyncAccessHandle | undefined;
    try {
      const file = (await this.#data.getFileHandle(backing, { create: true })) as SyncFileHandle;
      access = await createAccess(file);
      return { backing, access };
    } catch (error) {
      throw await this.#discardBacking(backing, access, error);
    }
  }

  async #discardBacking(
    backing: string,
    access: SyncAccessHandle | undefined,
    error: unknown,
  ): Promise<Error> {
    let failure = error instanceof Error ? error : new Error(describeError(error));
    try {
      access?.close();
    } catch (cleanupError) {
      const primaryName = failure.name;
      failure = composeWasixStorageFailure(
        failure,
        'backing handle cleanup also failed',
        cleanupError,
      );
      failure.name = primaryName;
    }
    try {
      await this.#data.removeEntry(backing);
    } catch (cleanupError) {
      if (errorName(cleanupError) !== 'NotFoundError') {
        const primaryName = failure.name;
        failure = composeWasixStorageFailure(
          failure,
          'backing file cleanup also failed',
          cleanupError,
        );
        failure.name = primaryName;
      }
    }
    return failure;
  }

  async #removeVolatileEntries(): Promise<void> {
    for (const path of VOLATILE_DATABASE_FILES) {
      const entry = this.#entries.get(path);
      if (entry?.type === 'file') {
        this.#entries.delete(path);
        this.#detach(entry.record);
        this.#namespaceDirty = true;
      }
    }
    if (this.#namespaceDirty) {
      this.#rebuildChildren();
      await this.sync('operation');
    }
  }

  #rebuildChildren(): void {
    this.#children.clear();
    for (const [path, entry] of this.#entries) {
      if (path === '') continue;
      const parent = parentPath(path);
      let children = this.#children.get(parent);
      if (children === undefined) {
        children = new Map();
        this.#children.set(parent, children);
      }
      children.set(baseName(path), entry);
    }
  }

  #validateEssentials(): void {
    const versionEntry = this.#entries.get('PG_VERSION');
    if (versionEntry?.type !== 'file') {
      throw corrupt(this.#name, 'is missing PG_VERSION');
    }
    const version = versionEntry.record;
    const size = this.#recordSize(version);
    if (size === 0 || size > 32) throw corrupt(this.#name, 'contains an invalid PG_VERSION');
    const bytes = new Uint8Array(size);
    readComplete(version, bytes, 0);
    let actual: string;
    try {
      actual = UTF8_DECODER.decode(bytes).trim();
    } catch (error) {
      throw corrupt(this.#name, 'contains a malformed PG_VERSION', error);
    }
    const expected = String(this.#physicalIdentity.postgresMajor);
    if (actual !== expected) {
      throw corrupt(
        this.#name,
        `contains PG_VERSION ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
    const control = this.#entries.get('global/pg_control');
    if (control?.type !== 'file') {
      throw corrupt(this.#name, 'is missing global/pg_control');
    }
    if (this.#recordSize(control.record) === 0) {
      throw corrupt(this.#name, 'contains an empty global/pg_control');
    }
  }

  #closeHandles(flush: boolean): void {
    let failure: unknown;
    for (const record of [...this.#records].sort(compareFlushOrder)) {
      const access = record.access;
      if (access === undefined) continue;
      try {
        if (flush && record.dirty) access.flush();
        access.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error]);
      }
      record.access = undefined;
    }
    if (failure !== undefined) throw failure;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`OPFS pool ${JSON.stringify(this.#name)} is closed`);
  }
}

export async function inspectPooledOpfsDatabase(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<PooledOpfsDatabase> {
  const state = await readPoolState(database, name, physicalIdentity);
  return inspectPoolState(database, name, physicalIdentity, state);
}

/** Reset only an unpublished first-open generation before portable hydration. */
export async function preparePooledOpfsDatabase(
  database: FileSystemDirectoryHandle,
  name: string,
  loadClusterSeed: WasixClusterSeedLoader,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<PooledOpfsDatabase> {
  let state = await readPoolState(database, name, physicalIdentity);
  if (state?.phase === 'initializing') {
    ({ state } = await resetPoolClusterSeed(
      database,
      name,
      await loadClusterSeed(),
      assertWasixPhysicalIdentity(physicalIdentity),
    ));
  }
  return inspectPoolState(database, name, physicalIdentity, state);
}

async function inspectPoolState(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  state: PoolState | undefined,
): Promise<PooledOpfsDatabase> {
  if (state === undefined) return { snapshot: undefined, state: 'new' };
  let data: FileSystemDirectoryHandle;
  try {
    data = await database.getDirectoryHandle(DATA_DIRECTORY);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') {
      throw corrupt(name, 'is missing its backing-file directory', error);
    }
    throw error;
  }
  const entries = state.entries.filter((entry) => !VOLATILE_DATABASE_FILES.has(entry.path));
  if (entries.length !== state.entries.length) {
    await writePoolState(database, { ...state, entries });
    await pruneUnreferencedData(data, entries).catch(() => undefined);
  }
  const directories = entries
    .filter((entry): entry is StoredDirectory => entry.type === 'directory')
    .map(({ path }) => path);
  const storedFiles = entries.filter((entry): entry is StoredFile => entry.type === 'file');
  const files = await parallelMap(storedFiles, async ({ path, backing }) => {
    try {
      return {
        path,
        bytes: new Uint8Array(
          await (await (await data.getFileHandle(backing)).getFile()).arrayBuffer(),
        ),
      };
    } catch (error) {
      if (errorName(error) === 'NotFoundError') {
        throw corrupt(
          name,
          `is missing backing ${JSON.stringify(backing)} for ${JSON.stringify(path)}`,
          error,
        );
      }
      throw error;
    }
  });
  return {
    snapshot: validateStoredSnapshot(
      { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
      String(physicalIdentity.postgresMajor),
      {
        label: poolLabel(name),
        corrupt: (detail, cause) => corrupt(name, detail, cause),
      },
    ),
    state: state.phase === 'ready' ? 'existing' : 'new',
  };
}

export async function applyPooledOpfsDelta(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  delta: StorageDelta,
): Promise<void> {
  validateDeltaPaths(delta, name);
  const data = await database.getDirectoryHandle(DATA_DIRECTORY, { create: true });
  const existing = await readPoolState(database, name, physicalIdentity);
  const entries = new Map<string, StoredEntry>(
    existing?.entries.map((entry) => [entry.path, entry]),
  );
  await pruneUnreferencedData(data, entries.values()).catch(() => undefined);
  const deletes = splitStorageDeltaDeletes(delta);
  for (const path of deletes.replacements) removeStoredPath(entries, path);
  for (const path of delta.directories) entries.set(path, { path, type: 'directory' });
  const files = [...delta.files].sort(comparePostgresPaths);
  for (const { path, bytes } of files) {
    const backing = newBackingName();
    await writeAtomicDataFile(data, backing, bytes);
    entries.set(path, { path, type: 'file', backing });
  }
  for (const path of deletes.removals) removeStoredPath(entries, path);
  validateEntryRelationships([...entries.values()], name);
  await writePoolState(database, {
    schema: STATE_SCHEMA,
    name,
    phase: 'ready',
    physicalIdentity: assertWasixPhysicalIdentity(physicalIdentity),
    entries: [...entries.values()].sort(compareStoredEntries),
  });
  await pruneUnreferencedData(data, entries.values()).catch(() => undefined);
}

export async function openPooledDatabaseDirectory(
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const root = await openPooledOpfsRoot();
  return root.getDirectoryHandle(name, { create: true });
}

export async function openPooledOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const origin = await requireOpfsRoot();
  return origin.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
}

async function initializePoolState(
  database: FileSystemDirectoryHandle,
  data: FileSystemDirectoryHandle,
  name: string,
  clusterSeed: WasixDirectoryMount,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<PoolState> {
  const entries: StoredEntry[] = [...new Set(clusterSeed.directories)].map((path) => ({
    path,
    type: 'directory',
  }));
  const files = await parallelMap(Object.entries(clusterSeed.files), async ([path, bytes]) => {
    const backing = newBackingName();
    await writeAtomicDataFile(data, backing, bytes);
    return { path, type: 'file', backing } satisfies StoredFile;
  });
  entries.push(...files);
  const state: PoolState = {
    schema: STATE_SCHEMA,
    name,
    phase: 'initializing',
    physicalIdentity,
    entries: entries.sort(compareStoredEntries),
  };
  await writePoolState(database, state);
  return state;
}

async function resetPoolClusterSeed(
  database: FileSystemDirectoryHandle,
  name: string,
  clusterSeed: WasixDirectoryMount,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<{ data: FileSystemDirectoryHandle; state: PoolState }> {
  try {
    await database.removeEntry(DATA_DIRECTORY, { recursive: true });
  } catch (error) {
    if (errorName(error) !== 'NotFoundError') throw error;
  }
  const data = await database.getDirectoryHandle(DATA_DIRECTORY, { create: true });
  const state = await initializePoolState(database, data, name, clusterSeed, physicalIdentity);
  return { data, state };
}

async function readPoolState(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<PoolState | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await database.getFileHandle(STATE_FILE);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') {
      for await (const entry of database.keys()) {
        if (entry !== DATA_DIRECTORY)
          throw corrupt(name, 'contains storage without state metadata');
      }
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithUniqueObjectKeys(await (await handle.getFile()).text());
  } catch (error) {
    throw corrupt(name, `has malformed state metadata: ${describeError(error)}`, error);
  }
  if (
    !isObject(parsed) ||
    parsed.schema !== STATE_SCHEMA ||
    parsed.name !== name ||
    (parsed.phase !== 'initializing' && parsed.phase !== 'ready') ||
    !Array.isArray(parsed.entries) ||
    !hasExactKeys(parsed, ['entries', 'name', 'phase', 'physicalIdentity', 'schema'])
  ) {
    throw corrupt(name, 'has unsupported or mismatched state metadata');
  }
  let compatible: boolean;
  try {
    compatible = physicalIdentityMatches(parsed.physicalIdentity, physicalIdentity);
  } catch (error) {
    throw corrupt(name, `has malformed physical identity: ${describeError(error)}`, error);
  }
  if (!compatible) {
    throw new WasixStorageError(
      `${poolLabel(name)} is incompatible with the selected WASIX runtime`,
      { code: 'incompatible', commitState: 'unchanged' },
    );
  }
  const paths = new Set<string>();
  const backings = new Set<string>();
  const entries: StoredEntry[] = parsed.entries.map((entry: unknown) => {
    if (!isObject(entry) || typeof entry.path !== 'string') {
      throw corrupt(name, 'contains a malformed state entry');
    }
    try {
      validateStoredPath(entry.path);
    } catch (error) {
      throw corrupt(name, `contains invalid path ${JSON.stringify(entry.path)}`, error);
    }
    if (paths.has(entry.path)) throw corrupt(name, `repeats path ${JSON.stringify(entry.path)}`);
    paths.add(entry.path);
    if (entry.type === 'directory') {
      if (!hasExactKeys(entry, ['path', 'type'])) {
        throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
      }
      return { path: entry.path, type: 'directory' };
    }
    if (entry.type !== 'file' || typeof entry.backing !== 'string') {
      throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
    }
    if (!hasExactKeys(entry, ['backing', 'path', 'type'])) {
      throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
    }
    try {
      validateBackingName(entry.backing);
    } catch (error) {
      throw corrupt(name, `contains invalid backing for ${JSON.stringify(entry.path)}`, error);
    }
    if (backings.has(entry.backing)) {
      throw corrupt(name, `aliases backing file ${JSON.stringify(entry.backing)}`);
    }
    backings.add(entry.backing);
    return { path: entry.path, type: 'file', backing: entry.backing };
  });
  validateEntryRelationships(entries, name);
  return {
    schema: STATE_SCHEMA,
    name,
    phase: parsed.phase,
    physicalIdentity: parsed.physicalIdentity as WasixPhysicalIdentity,
    entries,
  };
}

async function writePoolState(
  database: FileSystemDirectoryHandle,
  state: PoolState,
): Promise<void> {
  const handle = await database.getFileHandle(STATE_FILE, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(UTF8_ENCODER.encode(JSON.stringify(state)) as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function writeAtomicDataFile(
  data: FileSystemDirectoryHandle,
  backing: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await data.getFileHandle(backing, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

function serializePoolState(
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  live: ReadonlyMap<string, LiveEntry>,
  phase: PoolState['phase'],
): PoolState {
  const entries: StoredEntry[] = [];
  for (const [path, entry] of live) {
    if (path === '') continue;
    if (entry.type === 'directory') entries.push({ path, type: 'directory' });
    else {
      if (entry.record.backing === undefined) throw new Error(`file ${path} is not materialized`);
      entries.push({ path, type: 'file', backing: entry.record.backing });
    }
  }
  return {
    schema: STATE_SCHEMA,
    name,
    phase,
    physicalIdentity,
    entries: entries.sort(compareStoredEntries),
  };
}

function removeStoredPath(entries: Map<string, StoredEntry>, path: string): void {
  for (const candidate of [...entries.keys()]) {
    if (candidate === path || candidate.startsWith(`${path}/`)) entries.delete(candidate);
  }
}

async function pruneUnreferencedData(
  data: FileSystemDirectoryHandle,
  entries: Iterable<StoredEntry>,
): Promise<void> {
  const referenced = new Set(
    [...entries].flatMap((entry) => (entry.type === 'file' ? [entry.backing] : [])),
  );
  const removals: string[] = [];
  for await (const backing of data.keys()) {
    if (!referenced.has(backing)) removals.push(backing);
  }
  await parallelMap(removals, (backing) => data.removeEntry(backing));
}

function validateDeltaPaths(delta: StorageDelta, name: string): void {
  for (const path of [
    ...delta.directories,
    ...delta.files.map((file) => file.path),
    ...delta.deleted,
  ]) {
    try {
      validateStoredPath(path);
    } catch (error) {
      throw corrupt(name, `received invalid path ${JSON.stringify(path)}`, error);
    }
  }
}

function validateEntryRelationships(entries: readonly StoredEntry[], name: string): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    if (parent !== '' && byPath.get(parent)?.type !== 'directory') {
      throw corrupt(name, `is missing parent directory ${JSON.stringify(parent)}`);
    }
  }
}

function validatePath(path: string, allowRoot = false): void {
  const parts = segments(path);
  if (!allowRoot && parts.length === 0) throw invalid();
  for (const part of parts) validateDirectoryEntryName(part);
}

function validateStoredPath(path: string): void {
  const parts = segments(path);
  if (parts.length === 0) throw new Error('empty stored path');
  for (const part of parts) validateDirectoryEntryName(part);
}

function segments(path: string): string[] {
  if (path === '') return [];
  const parts = path.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw invalid();
  }
  return parts;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function newBackingName(): string {
  return `f-${crypto.randomUUID()}`;
}

function validateBackingName(name: string): void {
  if (!/^f-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) {
    throw new Error(`invalid OPFS pool backing name ${JSON.stringify(name)}`);
  }
}

async function createAccess(file: SyncFileHandle): Promise<SyncAccessHandle> {
  if (file.createSyncAccessHandle === undefined) {
    throw new DOMException('OPFS synchronous access is unavailable', 'NotSupportedError');
  }
  return file.createSyncAccessHandle();
}

function requireAccess(record: FileRecord): SyncAccessHandle {
  if (record.access === undefined) throw new Error('OPFS pool record has no access handle');
  return record.access;
}

function readComplete(record: FileRecord, bytes: Uint8Array, offset: number): void {
  if (record.staged !== undefined) {
    bytes.set(record.staged.subarray(offset, offset + bytes.byteLength));
    return;
  }
  const access = requireAccess(record);
  let read = 0;
  while (read < bytes.byteLength) {
    const count = access.read(bytes.subarray(read), { at: offset + read });
    validateProgress(count, bytes.byteLength - read, 'read');
    read += count;
  }
}

function writeComplete(access: SyncAccessHandle, bytes: Uint8Array, offset: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = access.write(bytes.subarray(written), { at: offset + written });
    validateProgress(count, bytes.byteLength - written, 'write');
    written += count;
  }
  access.truncate(offset + bytes.byteLength);
}

function isWalRecord(record: FileRecord): boolean {
  return record.path?.startsWith('pg_wal/') === true;
}

function compareFlushOrder(left: FileRecord, right: FileRecord): number {
  return (
    postgresRank(left.path ?? '') - postgresRank(right.path ?? '') ||
    (left.path ?? '').localeCompare(right.path ?? '')
  );
}

function comparePostgresPaths(left: { path: string }, right: { path: string }): number {
  return postgresRank(left.path) - postgresRank(right.path) || left.path.localeCompare(right.path);
}

function postgresRank(path: string): number {
  if (path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

function compareStoredEntries(left: StoredEntry, right: StoredEntry): number {
  return left.path.localeCompare(right.path);
}

function encodeDirectoryPage(
  entries: readonly { name: string; type: number }[],
  start: number,
  capacity: number,
): { bytes: Uint8Array; next: number } {
  const selected: { entry: { name: string; type: number }; name: Uint8Array }[] = [];
  let length = 4;
  let next = start;
  while (next < entries.length) {
    const entry = entries[next] as { name: string; type: number };
    const name = UTF8_ENCODER.encode(entry.name);
    if (length + 5 + name.byteLength > capacity) break;
    selected.push({ entry, name });
    length += 5 + name.byteLength;
    next += 1;
  }
  if (next < entries.length && selected.length === 0) {
    throw new DOMException('directory entry exceeds the bridge capacity', 'QuotaExceededError');
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, selected.length, true);
  let offset = 4;
  for (const selectedEntry of selected) {
    bytes[offset] = selectedEntry.entry.type;
    view.setUint32(offset + 1, selectedEntry.name.byteLength, true);
    bytes.set(selectedEntry.name, offset + 5);
    offset += 5 + selectedEntry.name.byteLength;
  }
  return { bytes, next };
}

function classifyError(error: unknown): number {
  switch (errorName(error)) {
    case 'NotFoundError':
      return RESULT.notFound;
    case 'TypeMismatchError':
      return RESULT.notFile;
    case 'NoModificationAllowedError':
    case 'NotAllowedError':
    case 'SecurityError':
      return RESULT.permission;
    case 'InvalidStateError':
    case 'DataError':
    case 'InvalidModificationError':
      return RESULT.invalid;
    case 'QuotaExceededError':
      return RESULT.storageFull;
    case 'NotSupportedError':
      return RESULT.unsupported;
    case 'TimeoutError':
      return RESULT.timeout;
    default:
      if (error instanceof ExistsError) return RESULT.exists;
      if (error instanceof DirectoryNotEmptyError) return RESULT.directoryNotEmpty;
      if (error instanceof NotDirectoryError) return RESULT.notDirectory;
      if (error instanceof NotFileError) return RESULT.notFile;
      return RESULT.io;
  }
}

class NotDirectoryError extends Error {}
class NotFileError extends Error {}
class DirectoryNotEmptyError extends Error {}
class ExistsError extends Error {}

function notDirectory(): NotDirectoryError {
  return new NotDirectoryError();
}
function notFile(): NotFileError {
  return new NotFileError();
}
function notFound(): DOMException {
  return new DOMException('entry not found', 'NotFoundError');
}
function invalid(): DOMException {
  return new DOMException('invalid OPFS bridge input', 'DataError');
}

function validateProgress(transferred: number, available: number, operation: string): void {
  if (
    !Number.isSafeInteger(transferred) ||
    transferred < 0 ||
    transferred > available ||
    (available > 0 && transferred === 0)
  ) {
    throw new Error(`OPFS synchronous ${operation} made invalid progress`);
  }
}

function validateOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
}

async function requireOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage;
  if (storage?.getDirectory === undefined) {
    throw new WasixStorageError('OPFS is unavailable in this @oliphaunt/wasix-ts host', {
      code: 'unavailable',
      commitState: 'unchanged',
    });
  }
  return storage.getDirectory();
}

async function parallelMap<Input, Output>(
  values: readonly Input[],
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && cursor < values.length) {
      const index = cursor++;
      try {
        output[index] = await operation(values[index] as Input);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_IO, values.length) }, worker));
  if (failed) throw failure;
  return output;
}

async function parallelCreate<Output>(
  count: number,
  operation: () => Promise<Output>,
): Promise<Output[]> {
  return parallelMap(
    Array.from({ length: count }, (_, index) => index),
    operation,
  );
}

function poolLabel(name: string): string {
  return `OPFS storage ${JSON.stringify(name)}`;
}
function corrupt(name: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`${poolLabel(name)} ${detail}`, {
    code: 'corrupt',
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
