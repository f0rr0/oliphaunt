import type { WasixDirectoryMount } from '../archive.js';
import { WasixStorageError } from '../errors.js';
import {
  canonicalStorageContract,
  type WasixStorageCompatibility,
  type WasixStorageLease,
} from '../storage-provider.js';
import {
  requireRecord,
  type StorageDelta,
  type StoredSnapshot,
  validateStoredSnapshot,
} from '../storage-snapshot.js';
import { acquireIncrementalStorage, type ExclusiveStorageLock } from './incremental-storage.js';
import { acquireExclusiveWebLock } from './web-lock.js';

const DATABASE_PREFIX = '@oliphaunt/wasix-ts:indexed-db:v3:';
const DATABASE_VERSION = 1;
const METADATA_STORE = 'metadata';
const ENTRY_STORE = 'entries';
const METADATA_KEY = 'database';

type StoredMetadata = {
  schema: 'oliphaunt-wasix-indexed-db-v3';
  name: string;
  compatibility: WasixStorageCompatibility;
};

type StoredEntry =
  | { path: string; type: 'dir' }
  | { path: string; type: 'file'; bytes: Uint8Array };

export type StoredDatabase = StoredMetadata & { entries: StoredEntry[] };
export type HeldLock = ExclusiveStorageLock;

export type StoredDatabaseStore = {
  read(): Promise<unknown | undefined>;
  apply(compatibility: WasixStorageCompatibility, delta: StorageDelta): Promise<void>;
  close(): void;
};

export type IndexedDbStorageBackend = {
  acquireLock(name: string): Promise<HeldLock>;
  openDatabase(name: string): Promise<StoredDatabaseStore>;
};

export async function acquireIndexedDbStorage(
  name: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  return acquireIndexedDbStorageWithBackend(name, template, compatibility, browserBackend());
}

/** @internal Narrow dependency seam for deterministic provider failure tests. */
export async function acquireIndexedDbStorageWithBackend(
  name: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  backend: IndexedDbStorageBackend,
): Promise<WasixStorageLease> {
  return acquireIncrementalStorage(`IndexedDB storage ${JSON.stringify(name)}`, template, {
    acquireLock: () => backend.acquireLock(name),
    async openStore() {
      const database = await backend.openDatabase(name);
      return {
        async read() {
          const stored = await database.read();
          return stored === undefined
            ? undefined
            : validateStoredDatabase(stored, name, compatibility);
        },
        apply: (delta) => database.apply(compatibility, delta),
        close: () => database.close(),
      };
    },
  });
}

function browserBackend(): IndexedDbStorageBackend {
  return {
    acquireLock: (name) =>
      acquireExclusiveWebLock(
        `@oliphaunt/wasix-ts:indexed-db:${name}`,
        `IndexedDB storage ${JSON.stringify(name)}`,
      ),
    async openDatabase(name) {
      const factory = globalThis.indexedDB;
      if (factory === undefined) {
        throw new WasixStorageError('IndexedDB is unavailable in this @oliphaunt/wasix-ts host', {
          code: 'unavailable',
          durability: 'unchanged',
        });
      }
      const database = await openStorageDatabase(factory, name);
      return {
        read: () => readStoredDatabase(database, name),
        apply: (compatibility, delta) =>
          applyStoredDatabaseDelta(database, name, compatibility, delta),
        close: () => database.close(),
      };
    },
  };
}

/** @internal Validate IndexedDB rows before any bytes reach Wasmer. */
export function validateStoredDatabase(
  value: unknown,
  name: string,
  compatibility: WasixStorageCompatibility,
): StoredSnapshot {
  let stored: Record<string, unknown>;
  try {
    stored = requireRecord(value, `IndexedDB storage ${JSON.stringify(name)}`);
  } catch (error) {
    throw corrupt(name, `has a malformed database record: ${describeError(error)}`, error);
  }
  if (stored.schema !== 'oliphaunt-wasix-indexed-db-v3' || stored.name !== name) {
    throw corrupt(name, 'has an unsupported or mismatched database record');
  }
  let storedCompatibility: Record<string, unknown>;
  try {
    storedCompatibility = requireRecord(
      stored.compatibility,
      `IndexedDB storage ${JSON.stringify(name)} compatibility`,
    );
  } catch (error) {
    throw corrupt(name, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  let storedContract: string;
  try {
    storedContract = canonicalStorageContract(storedCompatibility);
  } catch (error) {
    throw corrupt(name, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  if (storedContract !== canonicalStorageContract(compatibility)) {
    throw new WasixStorageError(
      `IndexedDB storage ${JSON.stringify(name)} is incompatible with the selected runtime or extensions`,
      { code: 'incompatible', durability: 'unchanged' },
    );
  }
  if (!Array.isArray(stored.entries)) throw corrupt(name, 'has malformed entry rows');
  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const candidate of stored.entries) {
    let entry: Record<string, unknown>;
    try {
      entry = requireRecord(candidate, `IndexedDB storage ${JSON.stringify(name)} entry`);
    } catch (error) {
      throw corrupt(name, `contains a malformed entry row: ${describeError(error)}`, error);
    }
    if (typeof entry.path !== 'string') throw corrupt(name, 'contains a mismatched entry row');
    if (entry.type === 'dir') {
      directories.push(entry.path);
    } else if (entry.type === 'file' && entry.bytes instanceof Uint8Array) {
      files.push({ path: entry.path, bytes: entry.bytes });
    } else {
      throw corrupt(name, `contains malformed entry ${JSON.stringify(entry.path)}`);
    }
  }
  return validateStoredSnapshot(
    { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
    {
      label: `IndexedDB storage ${JSON.stringify(name)}`,
      corrupt: (detail, cause) => corrupt(name, detail, cause),
    },
  );
}

/** @internal Stable physical IndexedDB name for one logical Oliphaunt database. */
export function indexedDbDatabaseName(name: string): string {
  return `${DATABASE_PREFIX}${name}`;
}

function openStorageDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(indexedDbDatabaseName(name), DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE);
      }
      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        database.createObjectStore(ENTRY_STORE, { keyPath: 'path' });
      }
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      settled = true;
      reject(
        new Error(
          `IndexedDB schema creation for ${JSON.stringify(name)} is blocked by another page`,
        ),
      );
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
  });
}

export async function readStoredDatabase(
  database: IDBDatabase,
  name: string,
): Promise<StoredDatabase | undefined> {
  const transaction = database.transaction([METADATA_STORE, ENTRY_STORE], 'readonly');
  const complete = transactionComplete(transaction);
  const metadataRequest = transaction.objectStore(METADATA_STORE).get(METADATA_KEY);
  const entriesRequest = transaction.objectStore(ENTRY_STORE).getAll();
  let metadata: unknown;
  let entries: unknown[];
  try {
    [metadata, entries] = await Promise.all([
      requestValue(metadataRequest),
      requestValue(entriesRequest),
    ]);
    await complete;
  } catch (error) {
    // Observe the transaction promise even when an individual request fails;
    // otherwise its later abort becomes an unhandled rejection in the host.
    await complete.catch(() => undefined);
    throw error;
  }
  if (metadata === undefined) {
    if (entries.length > 0) throw corrupt(name, 'contains entries without compatibility metadata');
    return undefined;
  }
  return { ...(metadata as StoredMetadata), entries: entries as StoredEntry[] };
}

export async function applyStoredDatabaseDelta(
  database: IDBDatabase,
  name: string,
  compatibility: WasixStorageCompatibility,
  delta: StorageDelta,
): Promise<void> {
  const transaction = database.transaction([METADATA_STORE, ENTRY_STORE], 'readwrite');
  transaction.objectStore(METADATA_STORE).put(
    {
      schema: 'oliphaunt-wasix-indexed-db-v3',
      name,
      compatibility,
    } satisfies StoredMetadata,
    METADATA_KEY,
  );
  const entries = transaction.objectStore(ENTRY_STORE);
  for (const path of delta.deleted) entries.delete(path);
  for (const path of delta.directories) {
    entries.put({ path, type: 'dir' } satisfies StoredEntry);
  }
  for (const { path, bytes } of delta.files) {
    entries.put({
      path,
      type: 'file',
      bytes,
    } satisfies StoredEntry);
  }
  await transactionComplete(transaction);
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function corrupt(name: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`IndexedDB storage ${JSON.stringify(name)} ${detail}`, {
    code: 'corrupt',
    durability: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
