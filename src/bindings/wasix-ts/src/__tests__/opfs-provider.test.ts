import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyOpfsDelta, readOpfsDatabase, restoreOpfsStorage } from '../storage/opfs-provider.js';
import { WASIX_PHYSICAL_IDENTITY, type WasixPhysicalIdentity } from '../storage-provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('WASIX OPFS storage', () => {
  it('writes WAL first and control last, then hydrates managed PGDATA', async () => {
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
      '.oliphaunt-storage.json',
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
      { code: 'corrupt', commitState: 'unchanged' },
    );

    const root = new FakeDirectory('', []);
    await applyOpfsDelta(root.asHandle(), 'todos', compatible(), {
      directories: ['global', 'pg_wal'],
      files: [
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
        { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      ],
      deleted: [],
    });
    const metadataHandle = await root.getFileHandle('.oliphaunt-storage.json');
    const metadata = JSON.parse(await (await metadataHandle.getFile()).text()) as {
      physicalIdentity: { physicalFormat: string };
    };
    metadata.physicalIdentity.physicalFormat = 'wasix-pg18-v2';
    const writable = await metadataHandle.createWritable();
    await writable.write(
      new TextEncoder().encode(JSON.stringify(metadata)) as Uint8Array<ArrayBuffer>,
    );
    await writable.close();
    await expect(readOpfsDatabase(root.asHandle(), 'todos', compatible())).rejects.toMatchObject({
      code: 'incompatible',
      commitState: 'unchanged',
    });
  });

  it('classifies malformed physical identity metadata as corrupt', async () => {
    const root = new FakeDirectory('', []);
    const metadata = await root.getFileHandle('.oliphaunt-storage.json', {
      create: true,
    });
    const writable = await metadata.createWritable();
    await writable.write(
      new TextEncoder().encode(
        JSON.stringify({
          schema: 'oliphaunt-wasix-opfs-v1',
          name: 'todos',
          physicalIdentity: 'not-an-object',
        }),
      ) as Uint8Array<ArrayBuffer>,
    );
    await writable.close();

    await expect(readOpfsDatabase(root.asHandle(), 'todos', compatible())).rejects.toMatchObject({
      code: 'corrupt',
      commitState: 'unchanged',
    });

    for (const text of [
      '{"schema":"oliphaunt-wasix-opfs-v1","schema":"oliphaunt-wasix-opfs-v1","name":"todos","physicalIdentity":{}}',
      '{"schema":"oliphaunt-wasix-opfs-v1","name":"todos","physicalIdentity":{},"unexpected":true}',
      '{"schema":"oliphaunt-wasix-opfs-v1","name":"todos","physicalIdentity":{"schema":"oliphaunt-physical-format-v1","engineFamily":"wasix","postgresMajor":18,"physicalFormat":"wasix-pg18-v1","physicalFormat":"wasix-pg18-v1"}}',
    ]) {
      const replacement = await metadata.createWritable();
      await replacement.write(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
      await replacement.close();
      await expect(readOpfsDatabase(root.asHandle(), 'todos', compatible())).rejects.toMatchObject({
        code: 'corrupt',
        commitState: 'unchanged',
      });
    }
  });

  it('preserves a caller-owned empty restore destination after publication fails', async () => {
    const origin = new FakeDirectory('', [], 'global/pg_control');
    const providerRoot = await origin.getDirectoryHandle('.oliphaunt-wasix-v1', { create: true });
    await providerRoot.getDirectoryHandle('todos', { create: true });
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => origin.asHandle() },
      locks: webLocks(new Error('injected ownership release failure')),
    });

    await expect(restoreOpfsStorage('todos', completeSnapshot(), compatible())).rejects.toThrow(
      /injected OPFS write failure.*ownership release also failed/u,
    );

    const restoredEmpty = await providerRoot.getDirectoryHandle('todos');
    expect([...(await collectFakeKeys(restoredEmpty))]).toEqual([]);
  });

  it('reports persisted when ownership release fails after restore publication', async () => {
    const origin = new FakeDirectory('', []);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => origin.asHandle() },
      locks: webLocks(new Error('injected ownership release failure')),
    });

    await expect(
      restoreOpfsStorage('todos', completeSnapshot(), compatible()),
    ).rejects.toMatchObject({ code: 'unavailable', commitState: 'persisted' });
    const providerRoot = await origin.getDirectoryHandle('.oliphaunt-wasix-v1');
    const pgdata = await providerRoot.getDirectoryHandle('todos');
    await expect(readOpfsDatabase(pgdata.asHandle(), 'todos', compatible())).resolves.toBeDefined();
  });

  it('removes an SDK-created restore destination after publication fails', async () => {
    const origin = new FakeDirectory('', [], 'global/pg_control');
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => origin.asHandle() },
      locks: webLocks(),
    });

    await expect(restoreOpfsStorage('todos', completeSnapshot(), compatible())).rejects.toThrow(
      'injected OPFS write failure',
    );

    const providerRoot = await origin.getDirectoryHandle('.oliphaunt-wasix-v1');
    await expect(providerRoot.getDirectoryHandle('todos')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

class FakeDirectory {
  readonly kind = 'directory';
  readonly #path: string;
  readonly #writes: string[];
  readonly #failWritePath: string | undefined;
  readonly #entries = new Map<string, FakeDirectory | FakeFile>();

  constructor(path: string, writes: string[], failWritePath?: string) {
    this.#path = path;
    this.#writes = writes;
    this.#failWritePath = failWritePath;
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const path = this.#path === '' ? name : `${this.#path}/${name}`;
    const directory = new FakeDirectory(path, this.#writes, this.#failWritePath);
    this.#entries.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeFile) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const path = this.#path === '' ? name : `${this.#path}/${name}`;
    const file = new FakeFile(path, this.#writes, this.#failWritePath);
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
  readonly #failWritePath: string | undefined;
  #bytes = new Uint8Array();

  constructor(path: string, writes: string[], failWritePath?: string) {
    this.#path = path;
    this.#writes = writes;
    this.#failWritePath = failWritePath;
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
        if (this.#path.endsWith(this.#failWritePath ?? '\0')) {
          throw new Error('injected OPFS write failure');
        }
        this.#bytes = next;
        this.#writes.push(this.#path);
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }
}

function completeSnapshot() {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1' as const,
    directories: ['global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
    ],
  };
}

async function collectFakeKeys(directory: FakeDirectory): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of directory.keys()) keys.push(key);
  return keys;
}

function webLocks(releaseFailure?: Error): LockManager {
  return {
    async request(_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) {
      const result = await callback({
        name: 'test',
        mode: 'exclusive',
      } as Lock);
      if (releaseFailure !== undefined) throw releaseFailure;
      return result;
    },
  } as LockManager;
}

function compatible(): WasixPhysicalIdentity {
  return { ...WASIX_PHYSICAL_IDENTITY };
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
