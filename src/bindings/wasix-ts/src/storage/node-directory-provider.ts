import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_ROOT_DESCRIPTOR,
  DATABASE_ROOT_PGDATA,
  type DatabaseRootDescriptor,
  parseDatabaseRootDescriptorText,
  wasixDatabaseRootDescriptor,
} from '../database-root.js';
import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import type { Directory } from '../host/index.mjs';
import { acquireNodeDirectoryLock } from '../node-directory-lock.js';
import { isNodeError, syncNodeDirectory } from '../node-fs-commit-state.js';
import {
  assertWasixPhysicalIdentity,
  type StorageDirectory,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
  type WasixStorageLease,
  type WasixStorageSyncBoundary,
} from '../storage-provider.js';
import {
  type StoredSnapshot,
  VOLATILE_DATABASE_FILES,
  validateStoredSnapshot,
} from '../storage-snapshot.js';
import {
  NodeSyncDirectoryPool,
  nodeSyncContainedRelativePath,
  validateNodeSyncDirectoryTree,
} from './node-sync-directory-pool.js';
import { releaseRestoreLock } from './restore-cleanup.js';

const DESCRIPTOR_FILE = DATABASE_ROOT_DESCRIPTOR;
const PGDATA_DIRECTORY = DATABASE_ROOT_PGDATA;
const WRITE_TEMP_MARKER = '.oliphaunt-write-';
const DURABLE_FILE_WRITE_CONCURRENCY = 16;
const DIRECT_BRIDGE_CAPACITY = 1024 * 1024;

export async function acquireNodeDirectoryStorage(
  path: string,
  loadClusterSeed: WasixClusterSeedLoader,
  identity: WasixPhysicalIdentity,
  ownerToken = randomBytes(16).toString('hex'),
): Promise<WasixStorageLease> {
  const selectedIdentity = assertWasixPhysicalIdentity(identity);
  const root = await prepareRoot(path);
  const label = `Node directory storage ${JSON.stringify(root)}`;
  const lock = await acquireNodeDirectoryLock(root, ownerToken);
  const pgdata = join(root, PGDATA_DIRECTORY);
  let ownsUnpublishedPgdata = false;
  try {
    const existing = await inspectDirectHostPgData(root, pgdata, selectedIdentity);
    if (!existing) {
      const seed = await loadClusterSeed();
      const snapshot = validateStoredSnapshot(
        {
          schema: 'oliphaunt-wasix-directory-snapshot-v1',
          directories: seed.directories,
          files: Object.entries(seed.files).map(([seedPath, bytes]) => ({
            path: seedPath,
            bytes,
          })),
        },
        String(selectedIdentity.postgresMajor),
        {
          label,
          corrupt: (detail, cause) => corrupt(root, detail, cause),
        },
      );
      ownsUnpublishedPgdata = true;
      await publishHostSnapshot(root, pgdata, snapshot, selectedIdentity, false);
    }
    let pool: NodeSyncDirectoryPool;
    try {
      pool = new NodeSyncDirectoryPool(pgdata);
    } catch (error) {
      throw corrupt(root, `contains unsafe PGDATA: ${describeError(error)}`, error);
    }
    return new NodeDirectoryLease(
      root,
      pgdata,
      selectedIdentity,
      lock,
      pool,
      existing ? 'existing' : 'new',
      ownsUnpublishedPgdata,
    );
  } catch (error) {
    let failure: Error =
      error instanceof WasixStorageError
        ? error
        : unavailable(root, `could not open its direct filesystem: ${describeError(error)}`, error);
    if (ownsUnpublishedPgdata && !(await hasPublishedDescriptor(root).catch(() => false))) {
      try {
        await rm(pgdata, { recursive: true, force: true });
        await syncNodeDirectory(root);
      } catch (cleanupError) {
        failure = composeWasixStorageFailure(
          failure,
          'unpublished PGDATA cleanup also failed',
          cleanupError,
        );
      }
    }
    try {
      await lock.release();
    } catch (releaseError) {
      failure = composeWasixStorageFailure(failure, 'ownership release also failed', releaseError);
    }
    throw failure;
  }
}

async function hasPublishedDescriptor(root: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(root, DESCRIPTOR_FILE));
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

class NodeDirectoryLease implements WasixStorageLease {
  readonly state: 'new' | 'existing';
  readonly #root: string;
  readonly #pgdata: string;
  readonly #identity: WasixPhysicalIdentity;
  readonly #lock: Awaited<ReturnType<typeof acquireNodeDirectoryLock>>;
  readonly #pool: NodeSyncDirectoryPool;
  #directory: Directory | undefined;
  #initializationPending: boolean;
  #ownsUnpublishedPgdata: boolean;
  #closed = false;

  constructor(
    root: string,
    pgdata: string,
    identity: WasixPhysicalIdentity,
    lock: Awaited<ReturnType<typeof acquireNodeDirectoryLock>>,
    pool: NodeSyncDirectoryPool,
    state: 'new' | 'existing',
    ownsUnpublishedPgdata: boolean,
  ) {
    this.#root = root;
    this.#pgdata = pgdata;
    this.#identity = identity;
    this.#lock = lock;
    this.#pool = pool;
    this.state = state;
    this.#initializationPending = state === 'new';
    this.#ownsUnpublishedPgdata = ownsUnpublishedPgdata;
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
    this.#directory = directory;
    const actual = (await directory.readTextFile('PG_VERSION')).trim();
    const expected = String(this.#identity.postgresMajor);
    if (actual !== expected) {
      throw corrupt(
        this.#root,
        `contains PG_VERSION ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
    return directory;
  };

  async sync(_directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void> {
    if (this.#closed) throw this.#unavailable('is closed', 'unchanged');
    let commitState: 'unknown' | 'persisted' = 'unknown';
    try {
      await this.#pool.sync();
      if (this.#initializationPending && (boundary === 'full' || boundary === 'close')) {
        await writeDescriptor(this.#root, wasixDatabaseRootDescriptor());
        this.#initializationPending = false;
        this.#ownsUnpublishedPgdata = false;
      }
      commitState = 'persisted';
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(
        `could not persist Node directory storage ${JSON.stringify(this.#root)}: ${describeError(error)}`,
        { code: 'publication-failed', commitState, cause: error },
      );
    }
  }

  async close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let failure: Error | undefined;
    let commitState: 'persisted' | 'unknown' = 'unknown';
    if (outcome === 'clean') {
      if (directory === undefined) {
        failure = new WasixStorageError(
          `cannot persist Node directory storage ${JSON.stringify(this.#root)} without PGDATA`,
          { code: 'publication-failed', commitState: 'unknown' },
        );
      } else {
        try {
          await this.#pool.sync();
          if (this.#initializationPending) {
            await writeDescriptor(this.#root, wasixDatabaseRootDescriptor());
            this.#initializationPending = false;
            this.#ownsUnpublishedPgdata = false;
          }
          commitState = 'persisted';
        } catch (error) {
          failure = new WasixStorageError(
            `Node directory storage ${JSON.stringify(this.#root)} could not persist on close`,
            { code: 'publication-failed', commitState: 'unknown', cause: error },
          );
        }
      }
    }

    try {
      this.#pool.close();
    } catch (error) {
      failure = combineDirectCleanupFailure(
        failure,
        this.#unavailable(
          `could not close its filesystem: ${describeError(error)}`,
          commitState,
          error,
        ),
        'filesystem cleanup also failed',
      );
    }
    const directDirectory = this.#directory;
    this.#directory = undefined;
    try {
      directDirectory?.free();
    } catch (error) {
      failure = combineDirectCleanupFailure(
        failure,
        this.#unavailable(
          `could not release its host directory: ${describeError(error)}`,
          commitState,
          error,
        ),
        'host directory release also failed',
      );
    }

    if (this.#ownsUnpublishedPgdata) {
      try {
        if (!(await hasPublishedDescriptor(this.#root))) {
          await rm(this.#pgdata, { recursive: true, force: true });
          await syncNodeDirectory(this.#root);
        }
        this.#ownsUnpublishedPgdata = false;
      } catch (error) {
        failure = combineDirectCleanupFailure(
          failure,
          this.#unavailable(
            `could not remove unpublished PGDATA: ${describeError(error)}`,
            'unknown',
            error,
          ),
          'unpublished PGDATA cleanup also failed',
        );
      }
    }

    try {
      await this.#lock.release();
    } catch (error) {
      failure = combineDirectCleanupFailure(
        failure,
        this.#unavailable(
          `closed but its ownership lock could not be released: ${describeError(error)}`,
          commitState,
          error,
        ),
        'ownership release also failed',
      );
    }
    if (failure !== undefined) throw failure;
  }

  #unavailable(
    detail: string,
    commitState: 'persisted' | 'unchanged' | 'unknown',
    cause?: unknown,
  ): WasixStorageError {
    return new WasixStorageError(`Node directory storage ${JSON.stringify(this.#root)} ${detail}`, {
      code: 'unavailable',
      commitState,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function combineDirectCleanupFailure(
  primary: Error | undefined,
  cleanup: Error,
  label: string,
): Error {
  return primary === undefined ? cleanup : composeWasixStorageFailure(primary, label, cleanup);
}

async function inspectDirectHostPgData(
  root: string,
  pgdata: string,
  identity: WasixPhysicalIdentity,
): Promise<boolean> {
  const top = await readdir(root, { withFileTypes: true });
  const hasDescriptor = top.some((entry) => entry.name === DESCRIPTOR_FILE);
  const dataEntries = top.filter((entry) => entry.name !== DESCRIPTOR_FILE);
  const pgdataEntry = dataEntries.find((entry) => entry.name === PGDATA_DIRECTORY);
  const unexpected = dataEntries.filter((entry) => entry.name !== PGDATA_DIRECTORY);
  if (unexpected.length > 0) {
    throw corrupt(root, `contains unexpected root entry ${JSON.stringify(unexpected[0]?.name)}`);
  }
  if (pgdataEntry === undefined) {
    if (hasDescriptor) throw incomplete(root, `contains ${DESCRIPTOR_FILE} without pgdata`);
    return false;
  }
  if (!pgdataEntry.isDirectory() || pgdataEntry.isSymbolicLink()) {
    throw corrupt(root, 'pgdata is not a real directory');
  }
  if (!hasDescriptor) throw incomplete(root, `contains PGDATA without ${DESCRIPTOR_FILE}`);

  const descriptor = await readDescriptor(root);
  const selectedIdentity = assertWasixPhysicalIdentity(identity);
  if (
    descriptor.engineFamily !== 'wasix' ||
    descriptor.pgdata !== PGDATA_DIRECTORY ||
    descriptor.postgresMajor !== selectedIdentity.postgresMajor ||
    descriptor.physicalFormat !== selectedIdentity.physicalFormat
  ) {
    throw new WasixStorageError(
      `directory storage ${JSON.stringify(root)} is incompatible with the selected WASIX runtime`,
      { code: 'incompatible', commitState: 'unchanged' },
    );
  }

  let removedVolatile = false;
  for (const name of VOLATILE_DATABASE_FILES) {
    const target = join(pgdata, name);
    try {
      const info = await lstat(target);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        throw corrupt(
          root,
          `contains directory ${JSON.stringify(name)} where a volatile file belongs`,
        );
      }
      await rm(target, { force: true });
      removedVolatile = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  if (removedVolatile) await syncNodeDirectory(pgdata);

  try {
    validateNodeSyncDirectoryTree(pgdata);
  } catch (error) {
    throw corrupt(root, `contains unsafe PGDATA: ${describeError(error)}`, error);
  }
  const version = (await readRealFile(join(pgdata, 'PG_VERSION'), 'PG_VERSION'))
    .toString('utf8')
    .trim();
  if (version !== String(selectedIdentity.postgresMajor)) {
    throw corrupt(
      root,
      `contains PG_VERSION ${JSON.stringify(version)}, expected ${JSON.stringify(selectedIdentity.postgresMajor)}`,
    );
  }
  const control = await readRealFile(join(pgdata, 'global', 'pg_control'), 'global/pg_control');
  if (control.byteLength === 0) throw corrupt(root, 'contains an empty global/pg_control');
  return true;
}

export async function restoreNodeDirectoryStorage(
  path: string,
  snapshot: StoredSnapshot,
  identity: WasixPhysicalIdentity,
  ownerToken = randomBytes(16).toString('hex'),
): Promise<void> {
  const selectedIdentity = assertWasixPhysicalIdentity(identity);
  const requested = path.startsWith('file:') ? fileURLToPath(path) : path;
  const lock = await acquireNodeDirectoryLock(requested, ownerToken);
  const target = lock.root;
  const parent = dirname(target);
  const staging = `${target}.oliphaunt-restore-${randomBytes(8).toString('hex')}`;
  let targetWasEmpty = false;
  let commitState: 'persisted' | 'unchanged' | 'unknown' = 'unchanged';
  let failure: unknown;
  try {
    try {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw incomplete(target, 'already exists and is not an empty real directory');
      }
      if ((await readdir(target)).length !== 0) {
        throw incomplete(target, 'already exists and is not empty');
      }
      targetWasEmpty = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await mkdir(staging, { mode: 0o700 });
    await publishHostSnapshot(
      staging,
      join(staging, PGDATA_DIRECTORY),
      snapshot,
      selectedIdentity,
      true,
    );
    if (targetWasEmpty) {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length !== 0) {
        throw incomplete(target, 'changed while its restore was being prepared');
      }
      await rmdir(target);
      commitState = 'unknown';
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (targetWasEmpty) {
        try {
          await mkdir(target, { mode: 0o700 });
          commitState = 'unchanged';
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            `directory storage ${JSON.stringify(target)} restore publication and recovery failed`,
          );
        }
      }
      throw error;
    }
    commitState = 'unknown';
    await syncNodeDirectory(parent);
    commitState = 'persisted';
  } catch (error) {
    failure = error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    failure = await releaseRestoreLock(
      lock,
      `directory storage ${JSON.stringify(target)}`,
      commitState,
      failure,
    );
    await syncNodeDirectory(parent).catch(() => undefined);
  }
  if (failure !== undefined) throw failure;
}

async function prepareRoot(input: string): Promise<string> {
  const requested = input.startsWith('file:') ? fileURLToPath(input) : input;
  const absolute = isAbsolute(requested) ? requested : resolve(requested);
  try {
    const missing: string[] = [];
    let existing = absolute;
    while (true) {
      try {
        const info = await stat(existing);
        if (!info.isDirectory()) throw new Error(`${existing} is not a directory`);
        break;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        missing.push(existing);
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    for (const directory of missing.reverse()) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${directory} is not a real directory`);
      }
      await syncNodeDirectory(await realpath(dirname(directory)));
    }
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('path is not a real directory');
    }
    return await realpath(absolute);
  } catch (error) {
    throw unavailable(absolute, `could not prepare the directory: ${describeError(error)}`, error);
  }
}

async function readDescriptor(root: string): Promise<DatabaseRootDescriptor> {
  const path = join(root, DESCRIPTOR_FILE);
  let text: string;
  try {
    text = (await readRealFile(path, DESCRIPTOR_FILE)).toString('utf8');
  } catch (error) {
    throw corrupt(root, `has missing or unreadable ${DESCRIPTOR_FILE}`, error);
  }
  const descriptor = parseDatabaseRootDescriptorText(text);
  if (descriptor === undefined) {
    throw corrupt(root, `has unsupported ${DESCRIPTOR_FILE}`);
  }
  return descriptor;
}

async function publishHostSnapshot(
  root: string,
  pgdata: string,
  snapshot: Pick<StoredSnapshot, 'directories' | 'files'>,
  identity: WasixPhysicalIdentity,
  writeDescriptorFile: boolean,
): Promise<void> {
  await ensureContainedDirectory(root, PGDATA_DIRECTORY);
  const syncedParents = new Set<string>([root, pgdata]);
  for (const relative of snapshot.directories) {
    const target = await ensureContainedDirectory(pgdata, relative);
    syncedParents.add(dirname(target));
  }

  // Make WAL durable before relation/control-file changes. This preserves the
  // same recovery ordering PostgreSQL relies on when host publication stops
  // partway through a boundary.
  const files = [...snapshot.files].sort(
    (left, right) =>
      publicationOrder(left.path) - publicationOrder(right.path) ||
      left.path.localeCompare(right.path),
  );
  await publishDurableFiles(pgdata, files);

  for (const parent of [...syncedParents].sort(comparePathDepthDescending)) {
    await syncNodeDirectory(parent);
  }
  if (writeDescriptorFile) {
    assertWasixPhysicalIdentity(identity);
    await writeDescriptor(root, wasixDatabaseRootDescriptor());
  }
}

function publicationOrder(path: string): number {
  if (path === 'pg_wal' || path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

async function writeDescriptor(root: string, descriptor: DatabaseRootDescriptor): Promise<void> {
  await replaceDurableFile(join(root, DESCRIPTOR_FILE), `${JSON.stringify(descriptor)}\n`);
}

async function replaceDurableFile(path: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${path}${WRITE_TEMP_MARKER}${randomBytes(8).toString('hex')}`;
  try {
    await writeDurableFile(temporary, contents);
    await rename(temporary, path);
    await syncNodeDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Publish one complete seed or restore snapshot with explicit WAL,
 * ordinary-file, and pg_control durability barriers.
 *
 * Each replacement is first written and fsynced under a private sibling name.
 * Independent temporary files may be prepared concurrently, but their final
 * names are not exposed until the complete phase is ready. Parent directories
 * are then fsynced once per phase before the next class can become visible.
 * This preserves PostgreSQL's WAL-before-data-before-control ordering without
 * paying one directory fsync for every changed file.
 */
async function publishDurableFiles(
  pgdata: string,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): Promise<void> {
  for (const phase of [0, 1, 2]) {
    const selected = files.filter((file) => publicationOrder(file.path) === phase);
    if (selected.length === 0) continue;
    const replacements = selected.map((file) => {
      const target = hostPath(pgdata, file.path);
      return {
        target,
        temporary: `${target}${WRITE_TEMP_MARKER}${randomBytes(8).toString('hex')}`,
        parentRelative: file.path.split('/').slice(0, -1).join('/'),
        bytes: file.bytes,
      };
    });

    try {
      for (let offset = 0; offset < replacements.length; offset += DURABLE_FILE_WRITE_CONCURRENCY) {
        const batch = replacements.slice(offset, offset + DURABLE_FILE_WRITE_CONCURRENCY);
        const outcomes = await Promise.allSettled(
          batch.map(async ({ parentRelative, temporary, bytes }) => {
            await ensureContainedDirectory(pgdata, parentRelative);
            await writeDurableFile(temporary, bytes);
          }),
        );
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        if (failure !== undefined) throw failure.reason;
      }

      const parents = new Set<string>();
      for (const replacement of replacements) {
        await rename(replacement.temporary, replacement.target);
        parents.add(dirname(replacement.target));
      }
      for (const parent of [...parents].sort(comparePathDepthDescending)) {
        await syncNodeDirectory(parent);
      }
    } finally {
      await Promise.all(
        replacements.map(({ temporary }) => rm(temporary, { force: true }).catch(() => undefined)),
      );
    }
  }
}

async function writeDurableFile(path: string, contents: string | Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hostPath(root: string, relative: string): string {
  if (
    relative.length === 0 ||
    relative.startsWith('/') ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe PGDATA path ${JSON.stringify(relative)}`);
  }
  return join(root, ...relative.split('/'));
}

async function ensureContainedDirectory(root: string, relative: string): Promise<string> {
  let current = root;
  if (relative === '') return current;
  for (const segment of relative.split('/')) {
    const next = join(current, segment);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    await requireContainedRealDirectory(root, next);
    current = next;
  }
  return current;
}

async function requireContainedRealDirectory(root: string, path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${path} is not a real directory`);
  }
  assertContained(root, await realpath(path));
}

async function readRealFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function assertContained(root: string, path: string): void {
  nodeSyncContainedRelativePath(root, path);
}

function comparePathDepthDescending(left: string, right: string): number {
  return right.split(sep).length - left.split(sep).length || right.localeCompare(left);
}

function storageError(
  root: string,
  code: 'corrupt' | 'incomplete' | 'unavailable',
  detail: string,
  cause?: unknown,
): WasixStorageError {
  return new WasixStorageError(`directory storage ${JSON.stringify(root)} ${detail}`, {
    code,
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function corrupt(root: string, detail: string, cause?: unknown): WasixStorageError {
  return storageError(root, 'corrupt', detail, cause);
}

function incomplete(root: string, detail: string): WasixStorageError {
  return storageError(root, 'incomplete', detail);
}

function unavailable(root: string, detail: string, cause?: unknown): WasixStorageError {
  return storageError(root, 'unavailable', detail, cause);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
