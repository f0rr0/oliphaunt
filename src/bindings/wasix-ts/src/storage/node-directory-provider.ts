import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_ROOT_DESCRIPTOR,
  DATABASE_ROOT_PGDATA,
  parseDatabaseRootDescriptorText,
  type DatabaseRootDescriptor,
  wasixDatabaseRootDescriptor,
} from '../database-root.js';
import { WasixStorageError } from '../errors.js';
import { acquireNodeDirectoryLock } from '../node-directory-lock.js';
import { isNodeError, syncNodeDirectory } from '../node-fs-commit-state.js';
import {
  assertWasixPhysicalIdentity,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
  type WasixStorageLease,
} from '../storage-provider.js';
import {
  type StorageDelta,
  type StoredSnapshot,
  splitStorageDeltaDeletes,
  VOLATILE_DATABASE_FILES,
  validateStoredSnapshot,
} from '../storage-snapshot.js';
import { acquireIncrementalStorage } from './incremental-storage.js';
import { releaseRestoreLock } from './restore-cleanup.js';

const DESCRIPTOR_FILE = DATABASE_ROOT_DESCRIPTOR;
const PGDATA_DIRECTORY = DATABASE_ROOT_PGDATA;
const WRITE_TEMP_MARKER = '.oliphaunt-write-';

export async function acquireNodeDirectoryStorage(
  path: string,
  loadClusterSeed: WasixClusterSeedLoader,
  identity: WasixPhysicalIdentity,
  ownerToken = randomBytes(16).toString('hex'),
): Promise<WasixStorageLease> {
  const root = await prepareRoot(path);
  const pgdata = join(root, PGDATA_DIRECTORY);
  const label = `directory storage ${JSON.stringify(root)}`;
  return acquireIncrementalStorage(label, loadClusterSeed, {
    writeFailureCommitState: 'unknown',
    acquireLock: () => acquireNodeDirectoryLock(root, ownerToken),
    async openStore() {
      let descriptorExists = false;
      let ownsUnpublishedPgdata = false;
      return {
        async read() {
          const snapshot = await readHostPgData(root, pgdata, identity);
          descriptorExists = snapshot !== undefined;
          return snapshot;
        },
        async apply(delta) {
          const initializing = !descriptorExists;
          if (initializing) ownsUnpublishedPgdata = true;
          await publishHostDelta(root, pgdata, delta, identity, initializing);
          descriptorExists = true;
          ownsUnpublishedPgdata = false;
        },
        async close() {
          if (!ownsUnpublishedPgdata) return;
          if (await hasPublishedDescriptor(root)) {
            ownsUnpublishedPgdata = false;
            return;
          }
          await rm(pgdata, { recursive: true, force: true });
          await syncNodeDirectory(root);
          ownsUnpublishedPgdata = false;
        },
      };
    },
  });
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

export async function restoreNodeDirectoryStorage(
  path: string,
  snapshot: StoredSnapshot,
  identity: WasixPhysicalIdentity,
): Promise<void> {
  const requested = path.startsWith('file:') ? fileURLToPath(path) : path;
  const lock = await acquireNodeDirectoryLock(requested, randomBytes(16).toString('hex'));
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
    await publishHostDelta(
      staging,
      join(staging, PGDATA_DIRECTORY),
      { directories: snapshot.directories, files: snapshot.files, deleted: [] },
      identity,
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
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('path is not a real directory');
    }
    return await realpath(absolute);
  } catch (error) {
    throw unavailable(absolute, `could not prepare the directory: ${describeError(error)}`, error);
  }
}

async function readHostPgData(
  root: string,
  pgdata: string,
  identity: WasixPhysicalIdentity,
): Promise<StoredSnapshot | undefined> {
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
    return undefined;
  }
  if (!pgdataEntry.isDirectory() || pgdataEntry.isSymbolicLink()) {
    throw corrupt(root, 'pgdata is not a real directory');
  }

  const pgdataEntries = await readdir(pgdata, { withFileTypes: true });
  const hasPgVersion = pgdataEntries.some(
    (entry) => entry.name === 'PG_VERSION' && entry.isFile() && !entry.isSymbolicLink(),
  );
  if (!hasPgVersion) {
    if (hasDescriptor)
      throw incomplete(root, `contains ${DESCRIPTOR_FILE} without a complete PGDATA`);
    throw incomplete(
      root,
      pgdataEntries.length === 0
        ? 'contains an unpublished empty pgdata directory'
        : 'contains a non-empty incomplete PGDATA',
    );
  }
  if (!hasDescriptor) throw incomplete(root, `contains PGDATA without ${DESCRIPTOR_FILE}`);

  const descriptor = await readDescriptor(root);
  const selectedIdentity = assertWasixPhysicalIdentity(identity);
  if (
    descriptor.engineFamily === 'wasix' &&
    (descriptor.pgdata !== PGDATA_DIRECTORY ||
      descriptor.postgresMajor !== selectedIdentity.postgresMajor ||
      descriptor.physicalFormat !== selectedIdentity.physicalFormat)
  ) {
    throw new WasixStorageError(
      `directory storage ${JSON.stringify(root)} is incompatible with the selected WASIX runtime`,
      { code: 'incompatible', commitState: 'unchanged' },
    );
  }

  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const hostParent = relative.length === 0 ? pgdata : join(pgdata, ...relative.split('/'));
    const entries = await readdir(hostParent, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relative.length === 0 && VOLATILE_DATABASE_FILES.has(entry.name)) continue;
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const hostPath = join(pgdata, ...path.split('/'));
      const info = await lstat(hostPath);
      if (info.isSymbolicLink()) {
        throw corrupt(root, `contains symbolic link ${JSON.stringify(path)} in PGDATA`);
      }
      assertContained(pgdata, await realpath(hostPath));
      if (entry.isDirectory()) {
        directories.push(path);
        await walk(path);
      } else if (entry.isFile()) {
        files.push({
          path,
          bytes: new Uint8Array(await readRealFile(hostPath, path)),
        });
      } else {
        throw corrupt(root, `contains unsupported PGDATA entry ${JSON.stringify(path)}`);
      }
    }
  };
  await walk('');
  return validateStoredSnapshot(
    { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
    String(identity.postgresMajor),
    {
      label: `directory storage ${JSON.stringify(root)}`,
      corrupt: (detail, cause) => corrupt(root, detail, cause),
    },
  );
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

async function publishHostDelta(
  root: string,
  pgdata: string,
  delta: StorageDelta,
  identity: WasixPhysicalIdentity,
  writeDescriptorFile: boolean,
): Promise<void> {
  await ensureContainedDirectory(root, PGDATA_DIRECTORY);
  const deletes = splitStorageDeltaDeletes(delta);
  for (const relative of deletes.replacements) {
    const target = hostPath(pgdata, relative);
    await requireContainedParent(pgdata, target);
    await rm(target, { recursive: true, force: true });
    await syncNodeDirectory(dirname(target));
  }

  const syncedParents = new Set<string>([root, pgdata]);
  for (const relative of delta.directories) {
    const target = await ensureContainedDirectory(pgdata, relative);
    syncedParents.add(dirname(target));
  }

  // Make WAL durable before relation/control-file changes. This preserves the
  // same recovery ordering PostgreSQL relies on when host publication stops
  // partway through a boundary.
  const files = [...delta.files].sort(
    (left, right) =>
      publicationOrder(left.path) - publicationOrder(right.path) ||
      left.path.localeCompare(right.path),
  );
  for (const file of files) {
    const target = hostPath(pgdata, file.path);
    await ensureContainedDirectory(pgdata, file.path.split('/').slice(0, -1).join('/'));
    await replaceDurableFile(target, file.bytes);
    syncedParents.add(dirname(target));
  }

  for (const relative of deletes.removals) {
    const target = hostPath(pgdata, relative);
    await requireContainedParent(pgdata, target);
    await rm(target, { recursive: true, force: true });
    syncedParents.add(dirname(target));
  }

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

async function requireContainedParent(root: string, path: string): Promise<void> {
  await requireContainedRealDirectory(root, dirname(path));
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
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(normalizedRoot)) {
    throw new Error(`resolved path escapes ${root}`);
  }
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
