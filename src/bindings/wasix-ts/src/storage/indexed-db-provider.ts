import type { BrowserDirectoryMount } from '../archive.js';
import { WasixStorageError } from '../errors.js';
import {
  type BrowserStorageLease,
  canonicalStorageContract,
  type StorageDirectory,
  type WasixStorageCompatibility,
} from '../storage-provider.js';

const DATABASE_NAME = '@oliphaunt/wasix:indexed-db:v1';
const DATABASE_VERSION = 1;
const DATABASE_STORE = 'databases';
const VOLATILE_DATABASE_FILES = new Set(['postmaster.opts', 'postmaster.pid']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

type StoredSnapshot = {
  schema: 'oliphaunt-wasix-directory-snapshot-v1';
  directories: string[];
  files: { path: string; bytes: Uint8Array }[];
};

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
export async function snapshotStorageDirectory(
  directory: StorageDirectory,
): Promise<StoredSnapshot> {
  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];

  const walk = async (parent: string): Promise<void> => {
    const entries = [...(await directory.readDir(parent))].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      validateEntryName(entry.name);
      const path = parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
      if (parent.length === 0 && VOLATILE_DATABASE_FILES.has(entry.name)) {
        continue;
      }
      if (entry.type === 'dir') {
        directories.push(path);
        await walk(path);
      } else if (entry.type === 'file') {
        files.push({ path, bytes: (await directory.readFile(path)).slice() });
      } else {
        throw new Error(
          `Wasmer cannot snapshot PGDATA entry ${JSON.stringify(path)} of unknown type`,
        );
      }
    }
  };

  await walk('');
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories,
    files,
  };
}

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
  return validateSnapshot(
    storedDatabase.snapshot,
    name,
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
  );
}

function validateSnapshot(
  value: unknown,
  name: string,
  expectedPostgresMajor: string,
): StoredSnapshot {
  let snapshot: Record<string, unknown>;
  try {
    snapshot = requireRecord(value, `IndexedDB storage ${JSON.stringify(name)} snapshot`);
  } catch (error) {
    throw corrupt(name, `has a malformed directory snapshot: ${describeError(error)}`, error);
  }
  if (snapshot.schema !== 'oliphaunt-wasix-directory-snapshot-v1') {
    throw corrupt(name, 'has an unsupported directory snapshot');
  }
  if (!Array.isArray(snapshot.directories) || !Array.isArray(snapshot.files)) {
    throw corrupt(name, 'has malformed directory or file rows');
  }
  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const paths = new Set<string>();
  for (const path of snapshot.directories) {
    validateStoredPath(path, name);
    if (paths.has(path)) {
      throw corrupt(name, `repeats snapshot path ${JSON.stringify(path)}`);
    }
    paths.add(path);
    directories.push(path);
  }
  for (const value of snapshot.files) {
    let file: Record<string, unknown>;
    try {
      file = requireRecord(value, `IndexedDB storage ${JSON.stringify(name)} file row`);
    } catch (error) {
      throw corrupt(name, `has a malformed file row: ${describeError(error)}`, error);
    }
    validateStoredPath(file.path, name);
    if (!(file.bytes instanceof Uint8Array)) {
      throw corrupt(name, `has non-binary contents for ${JSON.stringify(file.path)}`);
    }
    if (paths.has(file.path)) {
      throw corrupt(name, `repeats snapshot path ${JSON.stringify(file.path)}`);
    }
    paths.add(file.path);
    files.push({ path: file.path, bytes: file.bytes.slice() });
  }
  validateSnapshotSemantics(directories, files, paths, name, expectedPostgresMajor);
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories: directories.sort(compareDirectoryDepth),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function validateSnapshotSemantics(
  directories: readonly string[],
  files: readonly { path: string; bytes: Uint8Array }[],
  paths: ReadonlySet<string>,
  name: string,
  expectedPostgresMajor: string,
): void {
  for (const volatile of VOLATILE_DATABASE_FILES) {
    if (paths.has(volatile)) {
      throw corrupt(
        name,
        `contains transient PostgreSQL process state ${JSON.stringify(volatile)}`,
      );
    }
  }

  const directoryPaths = new Set(directories);
  const fileByPath = new Map(files.map((file) => [file.path, file.bytes]));
  for (const path of paths) {
    for (const parent of parentPaths(path)) {
      if (fileByPath.has(parent)) {
        throw corrupt(
          name,
          `contains path ${JSON.stringify(path)} below file ${JSON.stringify(parent)}`,
        );
      }
      if (!directoryPaths.has(parent)) {
        throw corrupt(
          name,
          `contains path ${JSON.stringify(path)} without parent directory ${JSON.stringify(parent)}`,
        );
      }
    }
  }

  const pgVersion = fileByPath.get('PG_VERSION');
  const pgControl = fileByPath.get('global/pg_control');
  if (pgVersion === undefined || pgControl === undefined) {
    throw corrupt(name, 'is missing PG_VERSION or global/pg_control');
  }
  if (pgControl.length === 0) {
    throw corrupt(name, 'contains an empty global/pg_control');
  }

  let actualPostgresMajor: string;
  try {
    actualPostgresMajor = utf8.decode(pgVersion).trim();
  } catch (error) {
    throw corrupt(name, `contains a non-UTF-8 PG_VERSION: ${describeError(error)}`, error);
  }
  if (actualPostgresMajor !== expectedPostgresMajor) {
    throw corrupt(
      name,
      `contains PG_VERSION ${JSON.stringify(actualPostgresMajor)}, expected ${JSON.stringify(expectedPostgresMajor)}`,
    );
  }
}

function parentPaths(path: string): string[] {
  const segments = path.split('/');
  const parents: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    parents.push(segments.slice(0, length).join('/'));
  }
  return parents;
}

function snapshotToMount(snapshot: StoredSnapshot): BrowserDirectoryMount {
  // Wasmer's wasm-bindgen `DirectoryInit` currently recognizes ordinary JS
  // objects, not null-prototype dictionaries. `Object.fromEntries` creates
  // own data properties even for names such as `__proto__`.
  const files = Object.fromEntries(snapshot.files.map((file) => [file.path, file.bytes]));
  return { files, directories: [...snapshot.directories] };
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
      `@oliphaunt/wasix:indexed-db:${name}`,
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

function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`Wasmer returned an unsafe PGDATA entry name ${JSON.stringify(name)}`);
  }
}

function validateStoredPath(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')) {
    throw corrupt(name, `contains invalid snapshot path ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw corrupt(name, `contains unsafe snapshot path ${JSON.stringify(value)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function compareDirectoryDepth(left: string, right: string): number {
  return left.split('/').length - right.split('/').length || left.localeCompare(right);
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
