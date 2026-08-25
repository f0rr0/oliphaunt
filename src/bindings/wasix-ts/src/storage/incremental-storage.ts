import type { WasixDirectoryMount } from '../archive.js';
import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import type { WasixStorageCommitState } from '../errors.js';
import type {
  WasixClusterSeedLoader,
  StorageDirectory,
  WasixStorageLease,
  WasixStorageSyncBoundary,
} from '../storage-provider.js';
import {
  applyStorageDeltaToEntries,
  snapshotStorageDelta,
  snapshotToMount,
  type StorageDelta,
  type StoredSnapshot,
} from '../storage-snapshot.js';

export type ExclusiveStorageLock = { release(): Promise<void> };

export type IncrementalStorageStore = {
  read(): Promise<StoredSnapshot | undefined>;
  /** Override snapshot presence when a direct provider has incomplete setup state. */
  initializationState?(snapshot: StoredSnapshot | undefined): 'new' | 'existing';
  apply(delta: StorageDelta): Promise<void>;
  close(): void | Promise<void>;
};

export type IncrementalStorageBackend = {
  acquireLock(): Promise<ExclusiveStorageLock>;
  openStore(): Promise<IncrementalStorageStore>;
  /** Atomic stores retain `not-persisted`; filesystem stores report `unknown`. */
  writeFailureCommitState?: WasixStorageCommitState;
};

/**
 * Shared lifecycle for browser stores backed by the Wasmer mutation journal.
 * Providers own their atomicity and validation; this layer owns delta capture,
 * cleanup ordering, and consistent failure semantics.
 */
export async function acquireIncrementalStorage(
  label: string,
  loadClusterSeed: WasixClusterSeedLoader,
  backend: IncrementalStorageBackend,
): Promise<WasixStorageLease> {
  const lock = await backend.acquireLock();
  let store: IncrementalStorageStore | undefined;
  try {
    store = await backend.openStore();
    const snapshot = await store.read();
    const state =
      store.initializationState?.(snapshot) ?? (snapshot === undefined ? 'new' : 'existing');
    const mount = snapshot === undefined ? await loadClusterSeed() : snapshotToMount(snapshot);
    return new IncrementalStorageLease(
      label,
      store,
      lock,
      mount,
      snapshot !== undefined,
      state,
      backend.writeFailureCommitState ?? 'not-persisted',
    );
  } catch (error) {
    let primary: Error =
      error instanceof WasixStorageError
        ? error
        : new WasixStorageError(`could not open ${label}: ${describeError(error)}`, {
            code: 'unavailable',
            commitState: 'unchanged',
            cause: error,
          });
    try {
      await store?.close();
    } catch (closeError) {
      primary = composeWasixStorageFailure(
        primary,
        'storage connection cleanup also failed',
        closeError,
      );
    }
    try {
      await lock.release();
    } catch (releaseError) {
      throw composeWasixStorageFailure(primary, 'ownership release also failed', releaseError);
    }
    throw primary;
  }
}

class IncrementalStorageLease implements WasixStorageLease {
  readonly state: 'new' | 'existing';
  readonly mount: WasixDirectoryMount;
  readonly #label: string;
  readonly #store: IncrementalStorageStore;
  readonly #lock: ExclusiveStorageLock;
  readonly #persistedEntries = new Map<string, 'dir' | 'file'>();
  readonly #writeFailureCommitState: WasixStorageCommitState;
  #closed = false;
  #hasStoredGeneration: boolean;
  #initializationPending: boolean;

  constructor(
    label: string,
    store: IncrementalStorageStore,
    lock: ExclusiveStorageLock,
    mount: WasixDirectoryMount,
    hasStoredGeneration: boolean,
    state: 'new' | 'existing',
    writeFailureCommitState: WasixStorageCommitState,
  ) {
    this.#label = label;
    this.#store = store;
    this.#lock = lock;
    this.state = state;
    this.mount = mount;
    this.#hasStoredGeneration = hasStoredGeneration;
    this.#initializationPending = state === 'new';
    this.#writeFailureCommitState = writeFailureCommitState;
    if (hasStoredGeneration) {
      for (const path of mount.directories) this.#persistedEntries.set(path, 'dir');
      for (const path of Object.keys(mount.files)) this.#persistedEntries.set(path, 'file');
    }
  }

  async sync(directory: StorageDirectory, _boundary: WasixStorageSyncBoundary): Promise<void> {
    if (this.#closed) {
      throw new WasixStorageError(`${this.#label} is closed`, {
        code: 'unavailable',
        commitState: 'unchanged',
      });
    }
    let failureCommitState = this.#writeFailureCommitState;
    try {
      const delta = await snapshotStorageDelta(
        directory,
        this.#persistedEntries,
        !this.#hasStoredGeneration,
      );
      if (
        !this.#initializationPending &&
        this.#hasStoredGeneration &&
        delta.directories.length === 0 &&
        delta.files.length === 0 &&
        delta.deleted.length === 0
      ) {
        failureCommitState = 'unchanged';
        await directory.clearChanges?.();
        return;
      }
      await this.#store.apply(delta);
      applyStorageDeltaToEntries(this.#persistedEntries, delta);
      this.#hasStoredGeneration = true;
      this.#initializationPending = false;
      failureCommitState = 'persisted';
      // The backend commit is the acknowledgement point. Keeping the journal
      // intact until now makes a failed publication retryable on close and
      // prevents successful paths from being republished on every operation.
      await directory.clearChanges?.();
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(`could not persist ${this.#label}: ${describeError(error)}`, {
        code: 'publication-failed',
        commitState: failureCommitState,
        cause: error,
      });
    }
  }

  async close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try {
      if (outcome === 'clean') {
        if (directory === undefined) {
          throw new WasixStorageError(`cannot persist ${this.#label} without PGDATA`, {
            code: 'publication-failed',
            commitState: 'not-persisted',
          });
        }
        await this.sync(directory, 'close');
      }
    } catch (error) {
      failure = error;
    } finally {
      this.#closed = true;
      try {
        await this.#store.close();
      } catch (error) {
        failure = combineCleanupFailure(
          failure,
          `${this.#label} could not close its storage connection`,
          'storage connection cleanup also failed',
          error,
          this.#hasStoredGeneration,
        );
      }
      try {
        await this.#lock.release();
      } catch (error) {
        failure = combineCleanupFailure(
          failure,
          `${this.#label} closed but its ownership lock could not be released`,
          'ownership release also failed',
          error,
          this.#hasStoredGeneration,
        );
      }
    }
    if (failure !== undefined) throw failure;
  }
}

function combineCleanupFailure(
  prior: unknown,
  message: string,
  detail: string,
  cause: unknown,
  persisted: boolean,
): Error {
  const cleanup = new WasixStorageError(message, {
    code: 'unavailable',
    commitState: persisted ? 'persisted' : 'unchanged',
    cause,
  });
  return prior instanceof Error ? composeWasixStorageFailure(prior, detail, cleanup) : cleanup;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
