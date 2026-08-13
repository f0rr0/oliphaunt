import type { BrowserDirectoryMount } from '../archive.js';
import { WasixStorageError } from '../errors.js';
import {
  type BrowserStorageLease,
  canonicalStorageContract,
  type StorageDirectory,
  type WasixStorageCompatibility,
} from '../storage-provider.js';
import {
  requireRecord,
  type StoredSnapshot,
  snapshotStorageDirectory,
  snapshotToMount,
  validateStoredSnapshot,
} from '../storage-snapshot.js';

const DATABASE_NAME = '@oliphaunt/wasix-ts:indexed-db:v1';
const DATABASE_VERSION = 1;
const DATABASE_STORE = 'databases';
export type StoredDatabase = {
  schema: 'oliphaunt-wasix-indexed-db-database-v1';
  name: string;
  compatibility: WasixStorageCompatibility;
  snapshot: StoredSnapshot;
};

export type HeldLock = { release(): Promise<void> };

export type StoredDatabaseStore = {
  read(name: string): Promise<unknown | undefined>;
  write(database: StoredDatabase): Promise<void>;
  close(): void;
};

export type IndexedDbStorageBackend = {
  acquireLock(name: string): Promise<HeldLock>;
  openDatabase(): Promise<StoredDatabaseStore>;
};

export async function acquireIndexedDbStorage(
  name: string,
  template: BrowserDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<BrowserStorageLease> {
  return acquireIndexedDbStorageWithBackend(name, template, compatibility, browserBackend());
}

/** @internal Narrow dependency seam for deterministic provider failure tests. */
export async function acquireIndexedDbStorageWithBackend(
  name: string,
  template: BrowserDirectoryMount,
  compatibility: WasixStorageCompatibility,
  backend: IndexedDbStorageBackend,
): Promise<BrowserStorageLease> {
  const lock = await backend.acquireLock(name);
  let database: StoredDatabaseStore | undefined;
  try {
    database = await backend.openDatabase();
    const stored = await database.read(name);
    if (stored === undefined) {
      return new IndexedDbStorageLease(name, database, lock, compatibility, 'new', template);
    }
    const snapshot = validateStoredDatabase(stored, name, compatibility);
    return new IndexedDbStorageLease(
      name,
      database,
      lock,
      compatibility,
      'existing',
      snapshotToMount(snapshot),
    );
  } catch (error) {
    database?.close();
    await lock.release().catch(() => undefined);
    if (error instanceof WasixStorageError) {
      throw error;
    }
    throw new WasixStorageError(
      `could not open IndexedDB storage ${JSON.stringify(name)}: ${describeError(error)}`,
      { code: 'unavailable', durability: 'unchanged', cause: error },
    );
  }
}

class IndexedDbStorageLease implements BrowserStorageLease {
  readonly state: 'new' | 'existing';
  readonly mount: BrowserDirectoryMount;
  readonly #name: string;
  readonly #database: StoredDatabaseStore;
  readonly #lock: HeldLock;
  readonly #compatibility: WasixStorageCompatibility;
  #closed = false;
  #hasStoredGeneration: boolean;

  constructor(
    name: string,
    database: StoredDatabaseStore,
    lock: HeldLock,
    compatibility: WasixStorageCompatibility,
    state: 'new' | 'existing',
    mount: BrowserDirectoryMount,
  ) {
    this.#name = name;
    this.#database = database;
    this.#lock = lock;
    this.#compatibility = compatibility;
    this.state = state;
    this.mount = mount;
    this.#hasStoredGeneration = state === 'existing';
  }

  async checkpoint(directory: StorageDirectory): Promise<void> {
    if (this.#closed) {
      throw new WasixStorageError(`IndexedDB storage ${JSON.stringify(this.#name)} is closed`, {
        code: 'unavailable',
        durability: 'unchanged',
      });
    }
    try {
      const snapshot = await snapshotStorageDirectory(directory);
      await this.#database.write({
        schema: 'oliphaunt-wasix-indexed-db-database-v1',
        name: this.#name,
        compatibility: this.#compatibility,
        snapshot,
      });
      this.#hasStoredGeneration = true;
    } catch (error) {
      if (error instanceof WasixStorageError) {
        throw error;
      }
      throw new WasixStorageError(
        `could not checkpoint IndexedDB storage ${JSON.stringify(this.#name)}: ${describeError(error)}`,
        { code: 'checkpoint-failed', durability: 'not-persisted', cause: error },
      );
    }
  }

  async close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void> {
    if (this.#closed) {
      return;
    }
    let failure: unknown;
    try {
      if (outcome === 'clean') {
        if (directory === undefined) {
          throw new WasixStorageError(
            `cannot checkpoint IndexedDB storage ${JSON.stringify(this.#name)} without PGDATA`,
            { code: 'checkpoint-failed', durability: 'not-persisted' },
          );
        }
        await this.checkpoint(directory);
      }
    } catch (error) {
      failure = error;
    } finally {
      this.#closed = true;
      this.#database.close();
      try {
        await this.#lock.release();
      } catch (error) {
        failure ??= new WasixStorageError(
          `IndexedDB storage ${JSON.stringify(this.#name)} closed but its ownership lock could not be released`,
          {
            code: 'unavailable',
            durability: this.#hasStoredGeneration ? 'persisted' : 'unchanged',
            cause: error,
          },
        );
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  }
}

function browserBackend(): IndexedDbStorageBackend {
  return {
    acquireLock: acquireExclusiveLock,
    async openDatabase() {
      const factory = globalThis.indexedDB;
      if (factory === undefined) {
        throw new WasixStorageError('IndexedDB is unavailable in this browser worker', {
          code: 'unavailable',
          durability: 'unchanged',
        });
      }
      const database = await openStorageDatabase(factory);
      return {
        read: (name) => readStoredDatabase(database, name),
        write: (storedDatabase) => writeStoredDatabase(database, storedDatabase),
        close: () => database.close(),
      };
    },
  };
}

/** @internal Exported for deterministic unit coverage of the Wasmer directory boundary. */
export { snapshotStorageDirectory } from '../storage-snapshot.js';

/** @internal Validate an IndexedDB value before any bytes reach Wasmer. */
export function validateStoredDatabase(
  value: unknown,
  name: string,
  compatibility: WasixStorageCompatibility,
): StoredSnapshot {
  let storedDatabase: Record<string, unknown>;
  try {
    storedDatabase = requireRecord(value, `IndexedDB storage ${JSON.stringify(name)}`);
  } catch (error) {
    throw corrupt(name, `has a malformed database record: ${describeError(error)}`, error);
  }
  if (
    storedDatabase.schema !== 'oliphaunt-wasix-indexed-db-database-v1' ||
    storedDatabase.name !== name
  ) {
    throw corrupt(name, 'has an unsupported or mismatched database record');
  }
  let storedCompatibility: Record<string, unknown>;
  try {
    storedCompatibility = requireRecord(
      storedDatabase.compatibility,
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
    let storedRuntime: Record<string, unknown>;
    try {
      storedRuntime = requireRecord(
        storedCompatibility.runtime,
        `IndexedDB storage ${JSON.stringify(name)} runtime compatibility`,
      );
    } catch (error) {
      throw corrupt(name, `has malformed runtime compatibility: ${describeError(error)}`, error);
    }
    const requested = `${compatibility.runtime.product}@${compatibility.runtime.version}`;
    const previous = `${String(storedRuntime.product)}@${String(storedRuntime.version)}`;
    throw new WasixStorageError(
      `IndexedDB storage ${JSON.stringify(name)} is incompatible: it was checkpointed with ${previous} and extensions ${extensionNames(storedCompatibility.extensions)}, but this open selected ${requested} and extensions ${extensionNames(compatibility.extensions)}`,
      { code: 'incompatible', durability: 'unchanged' },
    );
  }
  return validateStoredSnapshot(
    storedDatabase.snapshot,
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
    {
      label: `IndexedDB storage ${JSON.stringify(name)}`,
      corrupt: (detail, cause) => corrupt(name, detail, cause),
    },
  );
}

async function acquireExclusiveLock(name: string): Promise<HeldLock> {
  const locks = (
    globalThis.navigator as typeof globalThis.navigator & {
      locks?: {
        request<T>(
          name: string,
          options: { mode: 'exclusive'; ifAvailable: true },
          callback: (lock: unknown | null) => Promise<T> | T,
        ): Promise<T>;
      };
    }
  ).locks;
  if (locks === undefined) {
    throw new WasixStorageError('IndexedDB storage requires the browser Web Locks API', {
      code: 'unavailable',
      durability: 'unchanged',
    });
  }

  let releaseHold: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let acquisitionSettled = false;
  let resolveAcquisition: ((acquired: boolean) => void) | undefined;
  let rejectAcquisition: ((error: unknown) => void) | undefined;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquisition = resolve;
    rejectAcquisition = reject;
  });
  const request = locks
    .request(
      `@oliphaunt/wasix-ts:indexed-db:${name}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        acquisitionSettled = true;
        if (lock === null) {
          resolveAcquisition?.(false);
          return;
        }
        resolveAcquisition?.(true);
        await hold;
      },
    )
    .catch((error) => {
      if (!acquisitionSettled) {
        rejectAcquisition?.(error);
      }
      throw error;
    });

  let available: boolean;
  try {
    available = await acquired;
  } catch (error) {
    void request.catch(() => undefined);
    throw new WasixStorageError(
      `could not acquire ownership of IndexedDB storage ${JSON.stringify(name)}: ${describeError(error)}`,
      { code: 'unavailable', durability: 'unchanged', cause: error },
    );
  }
  if (!available) {
    await request;
    throw new WasixStorageError(
      `IndexedDB storage ${JSON.stringify(name)} is already open in this origin`,
      { code: 'busy', durability: 'unchanged' },
    );
  }

  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      releaseHold?.();
      await request;
    },
  };
}

function openStorageDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATABASE_STORE)) {
        database.createObjectStore(DATABASE_STORE, { keyPath: 'name' });
      }
    };
    request.onerror = () => {
      settled = true;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('IndexedDB schema upgrade is blocked by another page'));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
      } else {
        settled = true;
        resolve(request.result);
      }
    };
  });
}

export async function readStoredDatabase(
  database: IDBDatabase,
  name: string,
): Promise<unknown | undefined> {
  const transaction = database.transaction(DATABASE_STORE, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(DATABASE_STORE).get(name);
  const result = await requestValue(request);
  await complete;
  return result;
}

export async function writeStoredDatabase(
  database: IDBDatabase,
  storedDatabase: StoredDatabase,
): Promise<void> {
  const transaction = database.transaction(DATABASE_STORE, 'readwrite');
  transaction.objectStore(DATABASE_STORE).put(storedDatabase);
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

function extensionNames(value: unknown): string {
  if (!Array.isArray(value)) {
    return '[invalid metadata]';
  }
  const names = value.map((entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const sqlName = (entry as Record<string, unknown>).sqlName;
      if (typeof sqlName === 'string') {
        return sqlName;
      }
    }
    return '[invalid]';
  });
  return `[${names.join(', ')}]`;
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
