import type { WasixDirectoryMount } from '../resources/archive.js';
import {
  applyPooledOpfsDelta,
  inspectPooledOpfsDatabase,
  OPFS_POOL_ROOT,
} from '../storage/opfs-pool.js';
import type { OpfsSyncAccess } from '../storage/opfs-journal.js';
import {
  WASIX_PHYSICAL_IDENTITY,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
} from '../storage/storage-provider.js';
import { stubGlobal } from './test-globals.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export async function seedPool(
  root: FakeDirectory,
  name: string,
  initializing = false,
): Promise<void> {
  const pool = await root.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
  const database = await pool.getDirectoryHandle(name, { create: true });
  const seed = await clusterSeed()();
  await applyPooledOpfsDelta(database.asHandle(), name, compatible(), {
    directories: seed.directories,
    files: Object.entries(seed.files).map(([path, bytes]) => ({ path, bytes })),
    deleted: [],
  });
  if (initializing) {
    const state = JSON.parse(await database.file('state.json').text()) as { phase: string };
    state.phase = 'initializing';
    await database.file('state.json').replaceText(JSON.stringify(state));
  }
}

export function clusterSeed(): WasixClusterSeedLoader {
  const mount: WasixDirectoryMount = {
    directories: ['base', 'global', 'pg_wal'],
    files: {
      PG_VERSION: encoder.encode('18\n'),
      'global/pg_control': Uint8Array.of(1, 2, 3),
    },
  };
  return async () => mount;
}

export function completeSnapshot() {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1' as const,
    directories: ['global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: encoder.encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
    ],
  };
}

export function compatible(): WasixPhysicalIdentity {
  return { ...WASIX_PHYSICAL_IDENTITY };
}

export type FakeIo = {
  failNextStateCommit?: boolean;
  failNextFlush?: boolean;
  failNextAccessClose?: boolean;
  failNextBackingCreate?: boolean;
  failNextJournalWrite?: boolean;
  journalWriteBudget?: number;
  flushes?: string[];
  synchronousWrites?: { path: string; bytes: number; at: number }[];
  failNextDataCommit?: boolean;
  lockReleaseFailure?: Error;
  syncAccessErrorName?: string;
  writes?: string[];
  readBacking?: () => Promise<void>;
};

export function installOpfs(io: FakeIo = {}): FakeDirectory {
  stubGlobal('document', {});
  const root = new FakeDirectory('', io);
  stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => {
        const result = await callback({});
        if (io.lockReleaseFailure !== undefined) throw io.lockReleaseFailure;
        return result;
      },
    },
    storage: { getDirectory: async () => root.asHandle() },
  });
  return root;
}

export async function databaseDirectory(root: FakeDirectory, name: string): Promise<FakeDirectory> {
  return await (await root.getDirectoryHandle(OPFS_POOL_ROOT)).getDirectoryHandle(name);
}

export async function readSnapshot(
  database: FakeDirectory,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
) {
  return (await inspectPooledOpfsDatabase(database.asHandle(), name, physicalIdentity)).snapshot;
}

export async function collectKeys(directory: FakeDirectory): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of directory.keys()) keys.push(key);
  return keys.sort();
}

export class FakeDirectory {
  readonly kind = 'directory';
  readonly #path: string;
  readonly #io: FakeIo;
  readonly #entries = new Map<string, FakeDirectory | FakeFile>();

  constructor(path: string, io: FakeIo) {
    this.#path = path;
    this.#io = io;
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const directory = new FakeDirectory(join(this.#path, name), this.#io);
    this.#entries.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    if (options?.create && this.#io.failNextBackingCreate && this.#path.endsWith('/data')) {
      this.#io.failNextBackingCreate = false;
      throw new Error('injected backing allocation failure');
    }
    const existing = this.#entries.get(name);
    if (existing instanceof FakeFile) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const file = new FakeFile(join(this.#path, name), this.#io);
    this.#entries.set(name, file);
    return file;
  }

  file(name: string): FakeFile {
    const entry = this.#entries.get(name);
    if (!(entry instanceof FakeFile)) throw notFound();
    return entry;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.#entries.delete(name)) throw notFound();
  }

  async *keys(): AsyncGenerator<string> {
    yield* this.#entries.keys();
  }
}

class FakeFile {
  readonly kind = 'file';
  readonly #path: string;
  readonly #io: FakeIo;
  #bytes = new Uint8Array();
  #open = false;

  constructor(path: string, io: FakeIo) {
    this.#path = path;
    this.#io = io;
  }

  asHandle(): FileSystemFileHandle {
    return this as unknown as FileSystemFileHandle;
  }

  async getFile(): Promise<File> {
    const bytes = this.#bytes.slice();
    return {
      size: bytes.byteLength,
      slice: (start: number, end: number) => new Blob([bytes.slice(start, end)]),
      arrayBuffer: async () => {
        if (this.#path.includes('/data/')) await this.#io.readBacking?.();
        return bytes.buffer;
      },
      text: async () => decoder.decode(bytes),
    } as File;
  }

  async text(): Promise<string> {
    return decoder.decode(this.#bytes);
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let next = this.#bytes.slice();
    return {
      write: async (value: FileSystemWriteChunkType) => {
        if (!(value instanceof Uint8Array)) throw new TypeError('test expects byte writes');
        next = Uint8Array.from(value as Uint8Array);
      },
      close: async () => {
        if (this.#path.endsWith('/state.json') && this.#io.failNextStateCommit === true) {
          this.#io.failNextStateCommit = false;
          throw new Error('injected state commit failure');
        }
        if (this.#path.includes('/data/') && this.#io.failNextDataCommit === true) {
          this.#io.failNextDataCommit = false;
          throw new Error('injected OPFS write failure');
        }
        this.#bytes = next;
        this.#io.writes?.push(this.#path);
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }

  async createSyncAccessHandle(): Promise<OpfsSyncAccess> {
    if (this.#io.syncAccessErrorName !== undefined) {
      throw new DOMException('injected synchronous access failure', this.#io.syncAccessErrorName);
    }
    if (this.#open) throw new DOMException('already open', 'NoModificationAllowedError');
    this.#open = true;
    return {
      close: () => {
        this.#open = false;
        if (this.#io.failNextAccessClose === true) {
          this.#io.failNextAccessClose = false;
          throw new Error('injected access-handle close failure');
        }
      },
      flush: () => {
        if (this.#io.failNextFlush === true) {
          this.#io.failNextFlush = false;
          throw new Error('injected OPFS flush failure');
        }
        this.#io.flushes?.push(this.#path);
      },
      getSize: () => this.#bytes.byteLength,
      read: (output, { at }) => {
        const length = Math.max(0, Math.min(output.byteLength, this.#bytes.byteLength - at));
        output.set(this.#bytes.subarray(at, at + length));
        return length;
      },
      truncate: (size) => {
        const next = new Uint8Array(size);
        next.set(this.#bytes.subarray(0, size));
        this.#bytes = next;
      },
      write: (input, { at }) => {
        const isJournal = this.#path.startsWith('j-') || this.#path.includes('/j-');
        if (isJournal && this.#io.failNextJournalWrite) {
          this.#io.failNextJournalWrite = false;
          throw new Error('injected journal write failure');
        }
        if (isJournal && this.#io.journalWriteBudget !== undefined) {
          if (this.#io.journalWriteBudget === 0) throw new Error('interrupted journal write');
          input = input.subarray(0, this.#io.journalWriteBudget);
          this.#io.journalWriteBudget -= input.byteLength;
        }
        this.#io.synchronousWrites?.push({ path: this.#path, bytes: input.byteLength, at });
        const required = at + input.byteLength;
        if (required > this.#bytes.byteLength) {
          const next = new Uint8Array(required);
          next.set(this.#bytes);
          this.#bytes = next;
        }
        this.#bytes.set(input, at);
        return input.byteLength;
      },
    };
  }

  async replaceText(value: string): Promise<void> {
    this.#bytes = encoder.encode(value);
  }
}

export function join(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
