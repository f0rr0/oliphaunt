import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WasixDirectoryMount } from '../archive.js';
import { WasixStorageError } from '../errors.js';
import { acquireNodeDirectoryLock } from '../node-directory-lock.js';
import { isNodeError, syncNodeDirectory } from '../node-fs-durability.js';
import {
  NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX,
  NODE_DIRECTORY_LOCK_SLOT,
} from '../node-lock-identity.js';
import {
  canonicalStorageContract,
  type WasixStorageCompatibility,
  type WasixStorageLease,
} from '../storage-provider.js';
import {
  type StorageDelta,
  type StoredSnapshot,
  splitStorageDeltaDeletes,
  validateStoredSnapshot,
  VOLATILE_DATABASE_FILES,
} from '../storage-snapshot.js';
import { acquireIncrementalStorage } from './incremental-storage.js';

const FORMAT = 'oliphaunt-wasix-directory-v2';
const METADATA_FILE = '.oliphaunt-wasix.json';
const WRITE_TEMP_MARKER = '.oliphaunt-write-';

type DirectoryMetadata = {
  schema: typeof FORMAT;
  compatibility: WasixStorageCompatibility;
};

export async function acquireNodeDirectoryStorage(
  path: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  ownerToken = randomBytes(16).toString('hex'),
): Promise<WasixStorageLease> {
  const root = await prepareRoot(path);
  const label = `directory PGDATA ${JSON.stringify(root)}`;
  return acquireIncrementalStorage(label, template, {
    writeFailureDurability: 'unknown',
    acquireLock: () => acquireNodeDirectoryLock(root, ownerToken),
    async openStore() {
      await removeInterruptedWrites(root);
      return {
        read: () => readHostPgData(root, compatibility),
        apply: (delta) => publishHostDelta(root, delta, compatibility),
        close() {},
      };
    },
  });
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
  compatibility: WasixStorageCompatibility,
): Promise<StoredSnapshot | undefined> {
  const top = await readdir(root, { withFileTypes: true });
  const dataEntries = top.filter((entry) => !isInternalRootEntry(entry.name));
  const hasMetadata = top.some((entry) => entry.name === METADATA_FILE);
  const hasPgVersion = dataEntries.some((entry) => entry.name === 'PG_VERSION' && entry.isFile());
  if (!hasPgVersion) {
    if (dataEntries.some((entry) => entry.name === '.oliphaunt-wasix-ts')) {
      throw corrupt(
        root,
        'contains retired snapshot storage; select a new empty PGDATA directory (v1 migration is intentionally unsupported)',
      );
    }
    if (hasMetadata) {
      throw corrupt(root, `contains ${METADATA_FILE} without a complete PGDATA`);
    }
    if (dataEntries.length === 0) return undefined;
    throw corrupt(root, 'contains a non-empty incomplete PGDATA');
  }

  const metadata = await readMetadata(root);
  if (
    canonicalStorageContract(metadata.compatibility) !== canonicalStorageContract(compatibility)
  ) {
    throw new WasixStorageError(
      `directory PGDATA ${JSON.stringify(root)} is incompatible with the selected runtime or extensions`,
      { code: 'incompatible', durability: 'unchanged' },
    );
  }

  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const hostParent = relative.length === 0 ? root : join(root, ...relative.split('/'));
    const entries = await readdir(hostParent, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relative.length === 0 && isInternalRootEntry(entry.name)) continue;
      if (relative.length === 0 && VOLATILE_DATABASE_FILES.has(entry.name)) continue;
      if (entry.name.includes(WRITE_TEMP_MARKER)) continue;
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const hostPath = join(root, ...path.split('/'));
      const info = await lstat(hostPath);
      if (info.isSymbolicLink())
        throw corrupt(root, `contains symbolic link ${JSON.stringify(path)}`);
      const resolved = await realpath(hostPath);
      assertContained(root, resolved);
      if (entry.isDirectory()) {
        directories.push(path);
        await walk(path);
      } else if (entry.isFile()) {
        files.push({ path, bytes: new Uint8Array(await readRealFile(hostPath, path)) });
      } else {
        throw corrupt(root, `contains unsupported entry ${JSON.stringify(path)}`);
      }
    }
  };
  await walk('');
  return validateStoredSnapshot(
    { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
    {
      label: `directory PGDATA ${JSON.stringify(root)}`,
      corrupt: (detail, cause) => corrupt(root, detail, cause),
    },
  );
}

async function readMetadata(root: string): Promise<DirectoryMetadata> {
  const path = join(root, METADATA_FILE);
  let value: unknown;
  try {
    value = JSON.parse((await readRealFile(path, METADATA_FILE)).toString('utf8'));
  } catch (error) {
    throw corrupt(root, `has missing or unreadable ${METADATA_FILE}`, error);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !== FORMAT ||
    (value as { compatibility?: unknown }).compatibility === null ||
    typeof (value as { compatibility?: unknown }).compatibility !== 'object' ||
    Array.isArray((value as { compatibility?: unknown }).compatibility)
  ) {
    throw corrupt(root, `has unsupported ${METADATA_FILE}`);
  }
  return value as DirectoryMetadata;
}

async function publishHostDelta(
  root: string,
  delta: StorageDelta,
  compatibility: WasixStorageCompatibility,
): Promise<void> {
  const deletes = splitStorageDeltaDeletes(delta);
  for (const relative of deletes.replacements) {
    const target = hostPath(root, relative);
    await requireContainedParent(root, target);
    await rm(target, { recursive: true, force: true });
    await syncNodeDirectory(dirname(target));
  }

  const syncedParents = new Set<string>([root]);
  for (const relative of delta.directories) {
    const target = await ensureContainedDirectory(root, relative);
    syncedParents.add(dirname(target));
  }

  // Make WAL durable before relation/control-file changes. This preserves the
  // same recovery ordering PostgreSQL relies on when host publication stops
  // partway through a boundary.
  const files = [...delta.files].sort(
    (left, right) =>
      durabilityOrder(left.path) - durabilityOrder(right.path) ||
      left.path.localeCompare(right.path),
  );
  for (const file of files) {
    const target = hostPath(root, file.path);
    await ensureContainedDirectory(root, file.path.split('/').slice(0, -1).join('/'));
    await replaceDurableFile(target, file.bytes);
    syncedParents.add(dirname(target));
  }

  for (const relative of deletes.removals) {
    const target = hostPath(root, relative);
    await requireContainedParent(root, target);
    await rm(target, { recursive: true, force: true });
    syncedParents.add(dirname(target));
  }

  await writeMetadata(root, { schema: FORMAT, compatibility });
  for (const parent of [...syncedParents].sort(comparePathDepthDescending)) {
    await syncNodeDirectory(parent);
  }
}

function durabilityOrder(path: string): number {
  if (path === 'pg_wal' || path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

async function writeMetadata(root: string, metadata: DirectoryMetadata): Promise<void> {
  const target = join(root, METADATA_FILE);
  await replaceDurableFile(target, `${JSON.stringify(metadata)}\n`);
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

async function removeInterruptedWrites(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw corrupt(root, `contains symbolic link ${JSON.stringify(path)}`);
      if (entry.name.includes(WRITE_TEMP_MARKER)) {
        await rm(path, { recursive: true, force: true });
      } else if (entry.isDirectory() && !isLockRootEntry(entry.name)) {
        await walk(path);
      }
    }
  };
  await walk(root);
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
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${path} is not a real directory`);
  assertContained(root, await realpath(path));
}

async function readRealFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`${label} is not a regular file`);
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

function isInternalRootEntry(name: string): boolean {
  return (
    name === METADATA_FILE ||
    name === NODE_DIRECTORY_LOCK_SLOT ||
    name.startsWith(NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX) ||
    name.includes(WRITE_TEMP_MARKER)
  );
}

function isLockRootEntry(name: string): boolean {
  return name === NODE_DIRECTORY_LOCK_SLOT || name.startsWith(NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX);
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

function corrupt(root: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`directory PGDATA ${JSON.stringify(root)} ${detail}`, {
    code: 'corrupt',
    durability: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function unavailable(root: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`directory PGDATA ${JSON.stringify(root)} ${detail}`, {
    code: 'unavailable',
    durability: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
