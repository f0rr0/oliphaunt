import { composeWasixStorageFailure, WasixStorageError } from '../core/errors.js';
import type {
  WasixClusterSeedLoader,
  WasixPhysicalIdentity,
  WasixStorageLease,
} from './storage-provider.js';
import type { StoredSnapshot } from './storage-snapshot.js';
import { acquireIncrementalStorage, type ExclusiveStorageLock } from './incremental-storage.js';
import {
  applyPooledOpfsDelta,
  inspectPooledOpfsDatabase,
  openPooledDatabaseDirectory,
  openPooledOpfsRoot,
  preparePooledOpfsDatabase,
} from './opfs-pool.js';
import { releaseRestoreLock } from './restore-cleanup.js';
import { acquireExclusiveWebLock } from './web-lock.js';

export async function acquireOpfsStorage(
  name: string,
  loadClusterSeed: WasixClusterSeedLoader,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<WasixStorageLease> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  let lock: ExclusiveStorageLock | undefined;
  let lockHandedToFallback = false;
  try {
    lock = await acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label);
    const database = await openPooledDatabaseDirectory(name);
    let initializationState: 'new' | 'existing' = 'new';
    lockHandedToFallback = true;
    return await acquireIncrementalStorage(label, loadClusterSeed, {
      writeFailureCommitState: 'unknown',
      acquireLock: async () => lock as ExclusiveStorageLock,
      async openStore() {
        return {
          async read() {
            const opened = await preparePooledOpfsDatabase(
              database,
              name,
              loadClusterSeed,
              physicalIdentity,
            );
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
