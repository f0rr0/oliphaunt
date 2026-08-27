import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import type { Directory } from '../host/index.mjs';
import type {
  StorageDirectory,
  WasixClusterSeedLoader,
  WasixPhysicalIdentity,
  WasixStorageLease,
  WasixStorageSyncBoundary,
} from '../storage-provider.js';
import type { StoredSnapshot } from '../storage-snapshot.js';
import { acquireIncrementalStorage, type ExclusiveStorageLock } from './incremental-storage.js';
import {
  applyPooledOpfsDelta,
  DirectOpfsPool,
  inspectPooledOpfsDatabase,
  openPooledDatabaseDirectory,
  openPooledOpfsRoot,
  preparePooledOpfsDatabase,
} from './opfs-pool.js';
import { releaseRestoreLock } from './restore-cleanup.js';
import { acquireExclusiveWebLock } from './web-lock.js';

const DIRECT_BRIDGE_CAPACITY = 1024 * 1024;

export async function acquireOpfsStorage(
  name: string,
  loadClusterSeed: WasixClusterSeedLoader,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<WasixStorageLease> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  let lock: ExclusiveStorageLock | undefined;
  let lockHandedToFallback = false;
  let directPool: DirectOpfsPool | undefined;
  let directAttempted = false;
  try {
    lock = await acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label);
    if (canUseDirectOpfsPool()) {
      directAttempted = true;
      try {
        directPool = await DirectOpfsPool.open(name, loadClusterSeed, physicalIdentity);
      } catch (error) {
        if (!isDirectPoolUnavailable(error)) throw normalizeOpfsOpenError(name, error);
      }
    }
    if (directPool !== undefined) {
      return new DirectOpfsLease(name, lock, directPool);
    }

    const database = await openPooledDatabaseDirectory(name);
    let initializationState: 'new' | 'existing' = 'new';
    lockHandedToFallback = true;
    return await acquireIncrementalStorage(label, loadClusterSeed, {
      writeFailureCommitState: 'unknown',
      acquireLock: async () => lock as ExclusiveStorageLock,
      async openStore() {
        return {
          async read() {
            // A failed direct acquisition has already reset an unpublished
            // generation. Placements that never attempted it reset here.
            const opened = await (directAttempted
              ? inspectPooledOpfsDatabase(database, name, physicalIdentity)
              : preparePooledOpfsDatabase(database, name, loadClusterSeed, physicalIdentity));
            initializationState = opened.state;
            return opened.snapshot;
          },
          initializationState: () => initializationState,
          apply: (delta) => applyPooledOpfsDelta(database, name, physicalIdentity, delta),
          close() {},
        };
      },
    });
  } catch (error) {
    if (lock !== undefined && !lockHandedToFallback) {
      try {
        await lock.release();
      } catch (releaseError) {
        const primary = normalizeOpfsOpenError(name, error);
        throw composeWasixStorageFailure(primary, 'ownership release also failed', releaseError);
      }
    }
    throw normalizeOpfsOpenError(name, error);
  }
}

export async function restoreOpfsStorage(
  name: string,
  snapshot: StoredSnapshot,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<void> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  const lock = await acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label);
  let root: FileSystemDirectoryHandle | undefined;
  let cleanupDestination = false;
  let destinationExisted = false;
  let commitState: 'persisted' | 'unchanged' | 'unknown' = 'unchanged';
  let failure: unknown;
  try {
    root = await openPooledOpfsRoot();
    let database: FileSystemDirectoryHandle;
    try {
      database = await root.getDirectoryHandle(name);
      destinationExisted = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      database = await root.getDirectoryHandle(name, { create: true });
    }
    const destination = await inspectPooledOpfsDatabase(database, name, physicalIdentity);
    if (destination.state === 'existing') {
      throw new WasixStorageError(`${label} already exists`, {
        code: 'incomplete',
        commitState: 'unchanged',
      });
    }
    cleanupDestination = true;
    if (destination.snapshot !== undefined) {
      // An initializing generation was never published and is disposable.
      // Replace it instead of merging a restore over its unpublished seed contents.
      await root.removeEntry(name, { recursive: true });
      database = await root.getDirectoryHandle(name, { create: true });
    }
    commitState = 'unknown';
    await applyPooledOpfsDelta(database, name, physicalIdentity, {
      directories: snapshot.directories,
      files: snapshot.files,
      deleted: [],
    });
    cleanupDestination = false;
    commitState = 'persisted';
  } catch (error) {
    failure = error;
    if (cleanupDestination && root !== undefined) {
      try {
        await root.removeEntry(name, { recursive: true });
        if (destinationExisted) {
          await root.getDirectoryHandle(name, { create: true });
        }
        commitState = 'unchanged';
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], `${label} restore cleanup failed`);
        commitState = 'unknown';
      }
    }
  } finally {
    failure = await releaseRestoreLock(lock, label, commitState, failure);
  }
  if (failure !== undefined) throw failure;
}

class DirectOpfsLease implements WasixStorageLease {
  readonly state: 'new' | 'existing';
  readonly #name: string;
  readonly #lock: ExclusiveStorageLock;
  readonly #pool: DirectOpfsPool;
  #directory: Directory | undefined;
  #closed = false;

  constructor(name: string, lock: ExclusiveStorageLock, pool: DirectOpfsPool) {
    this.#name = name;
    this.state = pool.state;
    this.#lock = lock;
    this.#pool = pool;
  }

  createPgdataDirectory = async (DirectoryConstructor: typeof Directory): Promise<Directory> => {
    if (this.#closed) throw this.#unavailable('is closed', 'unchanged');
    if (this.#directory !== undefined) {
      throw this.#unavailable('already materialized its direct filesystem', 'unchanged');
    }
    if (typeof DirectoryConstructor.createSync !== 'function') {
      throw this.#unavailable('requires a host with the direct filesystem bridge', 'unchanged');
    }
    const directory = DirectoryConstructor.createSync(this.#pool, DIRECT_BRIDGE_CAPACITY);
    // Take ownership before validating the bridge so the normal close path
    // releases a failed materialization exactly once.
    this.#directory = directory;
    const pgVersion = (await directory.readTextFile('PG_VERSION')).trim();
    if (pgVersion.length === 0) {
      throw this.#unavailable('direct filesystem returned an empty PG_VERSION', 'unchanged');
    }
    return directory;
  };

  async sync(_directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void> {
    if (this.#closed) throw this.#unavailable('is closed', 'unchanged');
    try {
      await this.#pool.sync(boundary);
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(
        `could not persist OPFS storage ${JSON.stringify(this.#name)}: ${describeError(error)}`,
        { code: 'publication-failed', commitState: 'unknown', cause: error },
      );
    }
  }

  async close(
    _directory: StorageDirectory | undefined,
    outcome: 'clean' | 'failed',
  ): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let failure: Error | undefined;
    let commitState: 'persisted' | 'unknown' = 'unknown';
    if (outcome === 'clean') {
      try {
        await this.#pool.sync('close');
        commitState = 'persisted';
      } catch (error) {
        failure =
          error instanceof WasixStorageError
            ? error
            : new WasixStorageError(
                `OPFS storage ${JSON.stringify(this.#name)} could not persist on close`,
                { code: 'publication-failed', commitState: 'unknown', cause: error },
              );
      }
    }
    try {
      await this.#pool.close(false);
    } catch (error) {
      const cleanup = this.#unavailable(
        `could not close its pool: ${describeError(error)}`,
        commitState,
        error,
      );
      failure =
        failure === undefined
          ? cleanup
          : composeWasixStorageFailure(failure, 'pool cleanup also failed', cleanup);
    }
    const directory = this.#directory;
    this.#directory = undefined;
    try {
      directory?.free();
    } catch (error) {
      const release = this.#unavailable(
        `could not release its host filesystem: ${describeError(error)}`,
        commitState,
        error,
      );
      failure =
        failure === undefined
          ? release
          : composeWasixStorageFailure(failure, 'host filesystem release also failed', release);
    }
    try {
      await this.#lock.release();
    } catch (error) {
      const release = this.#unavailable(
        `closed but its ownership lock could not be released: ${describeError(error)}`,
        commitState,
        error,
      );
      failure =
        failure === undefined
          ? release
          : composeWasixStorageFailure(failure, 'ownership release also failed', release);
    }
    if (failure !== undefined) throw failure;
  }

  #unavailable(
    detail: string,
    commitState: 'persisted' | 'unchanged' | 'unknown',
    cause?: unknown,
  ): WasixStorageError {
    return new WasixStorageError(`OPFS storage ${JSON.stringify(this.#name)} ${detail}`, {
      code: 'unavailable',
      commitState,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function canUseDirectOpfsPool(): boolean {
  return (
    typeof document === 'undefined' && globalThis.navigator?.storage?.getDirectory !== undefined
  );
}

function isDirectPoolUnavailable(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === 'NotSupportedError' ||
    name === 'NoModificationAllowedError' ||
    name === 'QuotaExceededError'
  );
}

function normalizeOpfsOpenError(name: string, error: unknown): WasixStorageError {
  if (error instanceof WasixStorageError) return error;
  return new WasixStorageError(
    `could not open OPFS storage ${JSON.stringify(name)}: ${describeError(error)}`,
    { code: 'unavailable', commitState: 'unchanged', cause: error },
  );
}

function isNotFound(error: unknown): boolean {
  return errorName(error) === 'NotFoundError';
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
