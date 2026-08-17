import { describe, expect, it } from 'vitest';

import { applyOpfsDelta, readOpfsDatabase } from '../storage/opfs-provider.js';
import type { WasixStorageCompatibility } from '../storage-provider.js';

describe('WASIX OPFS storage', () => {
  it('writes WAL first and control last, then hydrates raw PGDATA', async () => {
    const writes: string[] = [];
    const root = new FakeDirectory('', writes);
    await applyOpfsDelta(root.asHandle(), 'todos', compatible(), {
      directories: ['base', 'global', 'pg_wal'],
      files: [
        { path: 'global/pg_control', bytes: Uint8Array.of(1, 2, 3) },
        { path: 'base/value', bytes: new TextEncoder().encode('persisted') },
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
        { path: 'pg_wal/0001', bytes: Uint8Array.of(9) },
      ],
      deleted: [],
    });

    expect(writes).toEqual([
      'pg_wal/0001',
      'base/value',
      'PG_VERSION',
      'global/pg_control',
      '.oliphaunt-wasix.json',
    ]);
    const snapshot = await readOpfsDatabase(root.asHandle(), 'todos', compatible());
    expect(snapshot?.files.map(({ path }) => path)).toEqual([
      'base/value',
      'global/pg_control',
      'PG_VERSION',
      'pg_wal/0001',
    ]);
  });

  it('fails closed for partial and incompatible OPFS roots', async () => {
    const partial = new FakeDirectory('', []);
    await partial.getFileHandle('PG_VERSION', { create: true });
    await expect(readOpfsDatabase(partial.asHandle(), 'todos', compatible())).rejects.toMatchObject(
      { code: 'corrupt', durability: 'unchanged' },
    );

    const root = new FakeDirectory('', []);
    await applyOpfsDelta(root.asHandle(), 'todos', compatible(), {
      directories: ['global'],
      files: [
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
        { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      ],
      deleted: [],
    });
    await expect(
      readOpfsDatabase(root.asHandle(), 'todos', {
        ...compatible(),
        runtime: { ...compatible().runtime, moduleSha256: '9'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'incompatible', durability: 'unchanged' });
  });

  it('classifies malformed compatibility metadata as corrupt', async () => {
    const root = new FakeDirectory('', []);
    const metadata = await root.getFileHandle('.oliphaunt-wasix.json', { create: true });
    const writable = await metadata.createWritable();
    await writable.write(
      new TextEncoder().encode(
        JSON.stringify({
          schema: 'oliphaunt-wasix-opfs-v2',
          name: 'todos',
          compatibility: 'not-an-object',
        }),
      ) as Uint8Array<ArrayBuffer>,
    );
    await writable.close();

    await expect(readOpfsDatabase(root.asHandle(), 'todos', compatible())).rejects.toMatchObject({
      code: 'corrupt',
      durability: 'unchanged',
    });
  });
});

class FakeDirectory {
  readonly kind = 'directory';
  readonly #path: string;
  readonly #writes: string[];
  readonly #entries = new Map<string, FakeDirectory | FakeFile>();

  constructor(path: string, writes: string[]) {
    this.#path = path;
    this.#writes = writes;
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const path = this.#path === '' ? name : `${this.#path}/${name}`;
    const directory = new FakeDirectory(path, this.#writes);
    this.#entries.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeFile) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const path = this.#path === '' ? name : `${this.#path}/${name}`;
    const file = new FakeFile(path, this.#writes);
    this.#entries.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.#entries.delete(name)) throw notFound();
  }

  async *entries(): AsyncGenerator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    for (const entry of this.#entries) {
      yield [
        entry[0],
        entry[1] instanceof FakeDirectory ? entry[1].asHandle() : entry[1].asHandle(),
      ];
    }
  }

  async *keys(): AsyncGenerator<string> {
    yield* this.#entries.keys();
  }
}

class FakeFile {
  readonly kind = 'file';
  readonly #path: string;
  readonly #writes: string[];
  #bytes = new Uint8Array();

  constructor(path: string, writes: string[]) {
    this.#path = path;
    this.#writes = writes;
  }

  asHandle(): FileSystemFileHandle {
    return this as unknown as FileSystemFileHandle;
  }

  async getFile(): Promise<File> {
    return new File([this.#bytes], this.#path);
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let next = this.#bytes;
    return {
      write: async (value: FileSystemWriteChunkType) => {
        if (!(value instanceof Uint8Array)) throw new TypeError('test expects byte writes');
        next = (value as Uint8Array).slice();
      },
      close: async () => {
        this.#bytes = next;
        this.#writes.push(this.#path);
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }
}

function compatible(): WasixStorageCompatibility {
  return {
    schema: 'oliphaunt-wasix-pgdata-compatibility-v1',
    runtime: {
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      manifestSha256: '1'.repeat(64),
      runtimeArchiveSha256: '2'.repeat(64),
      pgdataTemplateSha256: '3'.repeat(64),
      moduleSha256: '4'.repeat(64),
      sourceFingerprint: 'source-v1',
      postgresVersion: '18.4',
    },
    extensions: [],
  };
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
