import type { WasixDirectoryMount } from '../archive.js';
import { parseJsonWithUniqueObjectKeys } from '../database-root.js';
import { WasixStorageError } from '../errors.js';
import {
  storageCompatibilityKey,
  storageIsCompatible,
  type WasixStorageCompatibility,
  type WasixStorageCompatibilityKey,
  type WasixStorageLease,
} from '../storage-provider.js';
import {
  validateDirectoryEntryName,
  validateStoredSnapshot,
  splitStorageDeltaDeletes,
  type StorageDelta,
  type StoredSnapshot,
  VOLATILE_DATABASE_FILES,
} from '../storage-snapshot.js';
import { acquireIncrementalStorage } from './incremental-storage.js';
import { releaseRestoreLock } from './restore-cleanup.js';
import { acquireExclusiveWebLock } from './web-lock.js';

const ROOT_DIRECTORY = '.oliphaunt-wasix-v1';
const METADATA_FILE = '.oliphaunt-storage.json';

type OpfsMetadata = {
  schema: 'oliphaunt-wasix-opfs-v1';
  name: string;
  physicalCompatibility: WasixStorageCompatibilityKey;
};

export async function acquireOpfsStorage(
  name: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  return acquireIncrementalStorage(label, template, {
    writeFailureCommitState: 'unknown',
    acquireLock: () => acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label),
    async openStore() {
      const storage = globalThis.navigator?.storage;
      if (storage?.getDirectory === undefined) {
        throw new WasixStorageError('OPFS is unavailable in this @oliphaunt/wasix-ts host', {
          code: 'unavailable',
          commitState: 'unchanged',
        });
      }
      const origin = await storage.getDirectory();
      const root = await origin.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
      const pgdata = await root.getDirectoryHandle(name, { create: true });
      return {
        read: () => readOpfsDatabase(pgdata, name, compatibility),
        apply: (delta) => applyOpfsDelta(pgdata, name, compatibility, delta),
        close() {},
      };
    },
  });
}

export async function restoreOpfsStorage(
  name: string,
  snapshot: StoredSnapshot,
  compatibility: WasixStorageCompatibility,
): Promise<void> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  const lock = await acquireExclusiveWebLock(`@oliphaunt/wasix-ts:opfs:${name}`, label);
  let root: FileSystemDirectoryHandle | undefined;
  let cleanupDestination = false;
  let destinationExisted = false;
  let commitState: 'persisted' | 'unchanged' | 'unknown' = 'unchanged';
  let failure: unknown;
  try {
    const storage = globalThis.navigator?.storage;
    if (storage?.getDirectory === undefined) {
      throw new WasixStorageError('OPFS is unavailable in this @oliphaunt/wasix-ts host', {
        code: 'unavailable',
        commitState: 'unchanged',
      });
    }
    const origin = await storage.getDirectory();
    root = await origin.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
    let pgdata: FileSystemDirectoryHandle;
    try {
      pgdata = await root.getDirectoryHandle(name);
      destinationExisted = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      pgdata = await root.getDirectoryHandle(name, { create: true });
    }
    if ((await readOpfsDatabase(pgdata, name, compatibility)) !== undefined) {
      throw new WasixStorageError(`${label} already exists`, {
        code: 'incomplete',
        commitState: 'unchanged',
      });
    }
    cleanupDestination = true;
    commitState = 'unknown';
    await applyOpfsDelta(pgdata, name, compatibility, {
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

export async function readOpfsDatabase(
  pgdata: FileSystemDirectoryHandle,
  name: string,
  compatibility: WasixStorageCompatibility,
): Promise<StoredSnapshot | undefined> {
  const label = `OPFS storage ${JSON.stringify(name)}`;
  const metadata = await readMetadata(pgdata, name);
  if (metadata === undefined) {
    for await (const entryName of pgdata.keys()) {
      if (entryName !== METADATA_FILE) {
        throw corrupt(name, 'contains PGDATA without compatibility metadata');
      }
    }
    return undefined;
  }
  let compatible: boolean;
  try {
    compatible = storageIsCompatible(metadata.physicalCompatibility, compatibility);
  } catch (error) {
    throw corrupt(name, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  if (!compatible) {
    throw new WasixStorageError(`${label} is incompatible with the selected WASIX runtime`, {
      code: 'incompatible',
      commitState: 'unchanged',
    });
  }

  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  await readDirectory(pgdata, '', directories, files);
  return validateStoredSnapshot(
    { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
    {
      label,
      corrupt: (detail, cause) => corrupt(name, detail, cause),
    },
  );
}

export async function applyOpfsDelta(
  pgdata: FileSystemDirectoryHandle,
  name: string,
  compatibility: WasixStorageCompatibility,
  delta: StorageDelta,
): Promise<void> {
  const deletes = splitStorageDeltaDeletes(delta);
  for (const path of deletes.replacements) await removePath(pgdata, path);
  for (const path of delta.directories) await ensureDirectory(pgdata, path);

  const files = [...delta.files].sort(comparePostgresWriteOrder);
  for (const { path, bytes } of files) await writeFile(pgdata, path, bytes);
  for (const path of deletes.removals) await removePath(pgdata, path);
  await writeFile(
    pgdata,
    METADATA_FILE,
    new TextEncoder().encode(
      JSON.stringify({
        schema: 'oliphaunt-wasix-opfs-v1',
        name,
        physicalCompatibility: storageCompatibilityKey(compatibility),
      } satisfies OpfsMetadata),
    ),
  );
}

async function readMetadata(
  pgdata: FileSystemDirectoryHandle,
  name: string,
): Promise<OpfsMetadata | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await pgdata.getFileHandle(METADATA_FILE);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithUniqueObjectKeys(await (await handle.getFile()).text());
  } catch (error) {
    throw corrupt(name, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Partial<OpfsMetadata>).schema !== 'oliphaunt-wasix-opfs-v1' ||
    (parsed as Partial<OpfsMetadata>).name !== name ||
    (parsed as Partial<OpfsMetadata>).physicalCompatibility === undefined ||
    !hasExactKeys(parsed as Record<string, unknown>, ['name', 'physicalCompatibility', 'schema'])
  ) {
    throw corrupt(name, 'has unsupported or mismatched compatibility metadata');
  }
  return parsed as OpfsMetadata;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

async function readDirectory(
  directory: FileSystemDirectoryHandle,
  parent: string,
  directories: string[],
  files: { path: string; bytes: Uint8Array }[],
): Promise<void> {
  const entries = [...(await collectEntries(directory))].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [name, handle] of entries) {
    validateDirectoryEntryName(name);
    if (parent === '' && (name === METADATA_FILE || VOLATILE_DATABASE_FILES.has(name))) continue;
    const path = parent === '' ? name : `${parent}/${name}`;
    if (handle.kind === 'directory') {
      directories.push(path);
      await readDirectory(handle, path, directories, files);
    } else {
      files.push({ path, bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()) });
    }
  }
}

async function collectEntries(
  directory: FileSystemDirectoryHandle,
): Promise<[string, FileSystemDirectoryHandle | FileSystemFileHandle][]> {
  const entries: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
}

async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of splitStoredPath(path)) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function writeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const segments = splitStoredPath(path);
  const name = segments.pop();
  if (name === undefined) throw new Error('cannot write an empty OPFS path');
  const parent = await ensureDirectory(root, segments.join('/'));
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function removePath(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const segments = splitStoredPath(path);
  const name = segments.pop();
  if (name === undefined) return;
  let parent = root;
  try {
    for (const segment of segments) parent = await parent.getDirectoryHandle(segment);
    await parent.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function splitStoredPath(path: string): string[] {
  if (path === '') return [];
  const segments = path.split('/');
  for (const segment of segments) validateDirectoryEntryName(segment);
  return segments;
}

function comparePostgresWriteOrder(left: { path: string }, right: { path: string }): number {
  return (
    postgresWriteRank(left.path) - postgresWriteRank(right.path) ||
    left.path.localeCompare(right.path)
  );
}

function postgresWriteRank(path: string): number {
  if (path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof DOMException || (typeof error === 'object' && error !== null)) &&
    'name' in error &&
    error.name === 'NotFoundError'
  );
}

function corrupt(name: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`OPFS storage ${JSON.stringify(name)} ${detail}`, {
    code: 'corrupt',
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
