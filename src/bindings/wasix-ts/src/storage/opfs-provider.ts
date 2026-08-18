import type { WasixDirectoryMount } from '../archive.js';
import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import type { Directory } from '../host/index.mjs';
import type {
  StorageDirectory,
  WasixStorageCompatibility,
  WasixStorageLease,
  WasixStorageSyncBoundary,
} from '../storage-provider.js';
import { acquireIncrementalStorage, type ExclusiveStorageLock } from './incremental-storage.js';
import {
  applyPooledOpfsDelta,
  completePooledOpfsInitialization,
  DirectOpfsPool,
  inspectPooledOpfsDatabase,
  openPooledDatabaseDirectory,
} from './opfs-pool.js';
import { acquireExclusiveWebLock } from './web-lock.js';

const DIRECT_BRIDGE_CAPACITY = 1024 * 1024;

export async function acquireOpfsStorage(
  name: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  let lock: ExclusiveStorageLock | undefined;
  let lockHandedToFallback = false;
  let directPool: DirectOpfsPool | undefined;
  try {
    lock = await acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label);
    if (canUseDirectOpfsPool()) {
      try {
        directPool = await DirectOpfsPool.open(name, template, compatibility);
      } catch (error) {
        if (!isDirectPoolUnavailable(error)) throw normalizeOpfsOpenError(name, error);
      }
    }
    if (directPool !== undefined) {
      return new DirectOpfsLease(name, template, lock, directPool);
    }

    const database = await openPooledDatabaseDirectory(name);
    let initializationState: 'new' | 'existing' = 'new';
    lockHandedToFallback = true;
    return await acquireIncrementalStorage(label, template, {
      writeFailureDurability: 'unknown',
      acquireLock: async () => lock as ExclusiveStorageLock,
      async openStore() {
        return {
          async read() {
            const opened = await inspectPooledOpfsDatabase(database, name, compatibility);
            initializationState = opened.state;
            return opened.snapshot;
          },
          initializationState: () => initializationState,
          apply: (delta) => applyPooledOpfsDelta(database, name, compatibility, delta),
          completeInitialization: () =>
            completePooledOpfsInitialization(database, name, compatibility),
          close() {},
        };
      },
    });
  } catch (error) {
    await directPool?.close(false).catch(() => undefined);
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

class DirectOpfsLease implements WasixStorageLease {
  readonly state: 'new' | 'existing';
  readonly mount: WasixDirectoryMount;
  readonly #name: string;
  readonly #lock: ExclusiveStorageLock;
  readonly #pool: DirectOpfsPool;
  #directory: Directory | undefined;
  #closed = false;

  constructor(
    name: string,
    template: WasixDirectoryMount,
    lock: ExclusiveStorageLock,
    pool: DirectOpfsPool,
  ) {
    this.#name = name;
    this.state = pool.state;
    this.mount = template;
    this.#lock = lock;
    this.#pool = pool;
  }

  createDirectory = async (DirectoryConstructor: typeof Directory): Promise<Directory> => {
    if (this.#closed) throw this.#unavailable('is closed');
    if (this.#directory !== undefined) {
      throw this.#unavailable('already materialized its direct filesystem');
    }
    if (typeof DirectoryConstructor.createSync !== 'function') {
      throw this.#unavailable('requires a host with the direct filesystem bridge');
    }
    const directory = DirectoryConstructor.createSync(this.#pool, DIRECT_BRIDGE_CAPACITY);
    // Take ownership before validating the bridge so failed materialization is
    // released by the same close path as a successfully mounted directory.
    this.#directory = directory;
    const pgVersion = (await directory.readTextFile('PG_VERSION')).trim();
    if (pgVersion.length === 0) {
      throw this.#unavailable('direct filesystem returned an empty PG_VERSION');
    }
    return directory;
  };

  async completeInitialization(_directory: StorageDirectory): Promise<void> {
    if (this.#closed) throw this.#unavailable('is closed');
    try {
      await this.#pool.completeInitialization();
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(
        `could not complete first-open setup for direct OPFS storage ${JSON.stringify(this.#name)}: ${describeError(error)}`,
        { code: 'checkpoint-failed', durability: 'unknown', cause: error },
      );
    }
  }

  async sync(_directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void> {
    if (this.#closed) throw this.#unavailable('is closed');
    try {
      await this.#pool.sync(boundary);
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(
        `could not persist direct OPFS storage ${JSON.stringify(this.#name)}: ${describeError(error)}`,
        { code: 'checkpoint-failed', durability: 'unknown', cause: error },
      );
    }
  }

  async close(_directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let failure: Error | undefined;
    try {
      await this.#pool.close(outcome === 'clean');
    } catch (error) {
      failure = new WasixStorageError(
        `direct OPFS storage ${JSON.stringify(this.#name)} could not close its pool`,
        { code: 'checkpoint-failed', durability: 'unknown', cause: error },
      );
    }
    const directory = this.#directory;
    this.#directory = undefined;
    try {
      directory?.free();
    } catch (error) {
      const release = new WasixStorageError(
        `direct OPFS storage ${JSON.stringify(this.#name)} could not release its host filesystem`,
        { code: 'unavailable', durability: 'unknown', cause: error },
      );
      failure =
        failure === undefined
          ? release
          : composeWasixStorageFailure(failure, 'host filesystem release also failed', release);
    }
    try {
      await this.#lock.release();
    } catch (error) {
      const release = new WasixStorageError(
        `direct OPFS storage ${JSON.stringify(this.#name)} closed but its ownership lock could not be released`,
        { code: 'unavailable', durability: 'unknown', cause: error },
      );
      failure =
        failure === undefined
          ? release
          : composeWasixStorageFailure(failure, 'ownership release also failed', release);
    }
    if (failure !== undefined) throw failure;
  }

  #unavailable(detail: string): WasixStorageError {
    return new WasixStorageError(`direct OPFS storage ${JSON.stringify(this.#name)} ${detail}`, {
      code: 'unavailable',
      durability: 'unchanged',
    });
  }
}

function canUseDirectOpfsPool(): boolean {
  return (
    typeof document === 'undefined' &&
    globalThis.navigator?.storage?.getDirectory !== undefined
  );
}

function isDirectPoolUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return error.name === 'NotSupportedError' || error.name === 'NoModificationAllowedError';
}

function normalizeOpfsOpenError(name: string, error: unknown): WasixStorageError {
  if (error instanceof WasixStorageError) return error;
  return new WasixStorageError(
    `could not open OPFS storage ${JSON.stringify(name)}: ${describeError(error)}`,
    { code: 'unavailable', durability: 'unchanged', cause: error },
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
