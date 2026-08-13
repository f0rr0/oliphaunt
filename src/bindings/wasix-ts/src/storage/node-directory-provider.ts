import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WasixDirectoryMount } from '../archive.js';
import { composeWasixStorageFailure, WasixStorageError } from '../errors.js';
import { acquireNodeDirectoryLock, type HeldNodeDirectoryLock } from '../node-directory-lock.js';
import {
  NODE_DIRECTORY_LOCK_SLOT,
  nodeDirectoryLockCandidateToken,
} from '../node-lock-identity.js';
import {
  canonicalStorageContract,
  type StorageDirectory,
  type WasixStorageCompatibility,
  type WasixStorageLease,
} from '../storage-provider.js';
import {
  requireRecord,
  type StoredDatabase,
  type StoredSnapshot,
  snapshotStorageDirectory,
  snapshotToMount,
  validateStoredSnapshot,
} from '../storage-snapshot.js';

const FORMAT = 'oliphaunt-wasix-node-directory-v1';
const STATE_DIRECTORY = '.oliphaunt-wasix-ts';
const STATE_FILE = `.${FORMAT}`;
const CURRENT_DIRECTORY = 'current';
const PREVIOUS_DIRECTORY = '.previous';
const FORMAT_FILE = 'oliphaunt.json';
const SNAPSHOT_DIRECTORY = 'pgdata';

type NodeDirectoryMetadata = {
  schema: typeof FORMAT;
  compatibility: WasixStorageCompatibility;
  snapshotSha256: string;
};

export async function acquireNodeDirectoryStorage(
  path: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  ownerToken = randomBytes(16).toString('hex'),
): Promise<WasixStorageLease> {
  const root = await prepareRoot(path);
  const lock = await acquireNodeDirectoryLock(root, ownerToken);
  try {
    const stored = await readStoredDatabase(root, compatibility);
    return new NodeDirectoryStorageLease(
      root,
      lock,
      compatibility,
      stored === undefined ? 'new' : 'existing',
      stored === undefined ? template : snapshotToMount(stored.snapshot),
      stored !== undefined,
    );
  } catch (error) {
    const primary =
      error instanceof WasixStorageError
        ? error
        : unavailable(root, `could not open: ${describeError(error)}`, error);
    try {
      await lock.release();
    } catch (releaseError) {
      throw composeWasixStorageFailure(primary, 'ownership release also failed', releaseError);
    }
    throw primary;
  }
}

class NodeDirectoryStorageLease implements WasixStorageLease {
  readonly state: 'new' | 'existing';
  readonly mount: WasixDirectoryMount;
  readonly #root: string;
  readonly #lock: HeldNodeDirectoryLock;
  readonly #compatibility: WasixStorageCompatibility;
  #closed = false;
  #hasStoredGeneration: boolean;

  constructor(
    root: string,
    lock: HeldNodeDirectoryLock,
    compatibility: WasixStorageCompatibility,
    state: 'new' | 'existing',
    mount: WasixDirectoryMount,
    hasStoredGeneration: boolean,
  ) {
    this.#root = root;
    this.#lock = lock;
    this.#compatibility = compatibility;
    this.state = state;
    this.mount = mount;
    this.#hasStoredGeneration = hasStoredGeneration;
  }

  async checkpoint(directory: StorageDirectory): Promise<void> {
    if (this.#closed) throw unavailable(this.#root, 'is closed');
    try {
      const snapshot = validateStoredSnapshot(
        await snapshotStorageDirectory(directory),
        this.#compatibility.runtime.postgresVersion.split('.')[0] ?? '',
        {
          label: `Node directory storage ${JSON.stringify(this.#root)}`,
          corrupt: (detail, cause) =>
            new WasixStorageError(
              `could not checkpoint Node directory storage ${JSON.stringify(this.#root)}: ${detail}`,
              { code: 'checkpoint-failed', durability: 'not-persisted', cause },
            ),
        },
      );
      await publishGeneration(this.#root, snapshot, this.#compatibility);
      this.#hasStoredGeneration = true;
    } catch (error) {
      if (error instanceof WasixStorageError) throw error;
      throw new WasixStorageError(
        `could not checkpoint Node directory storage ${JSON.stringify(this.#root)}: ${describeError(error)}`,
        { code: 'checkpoint-failed', durability: 'not-persisted', cause: error },
      );
    }
  }

  async close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try {
      if (outcome === 'clean') {
        if (directory === undefined) {
          throw new WasixStorageError(
            `cannot checkpoint Node directory storage ${JSON.stringify(this.#root)} without PGDATA`,
            { code: 'checkpoint-failed', durability: 'not-persisted' },
          );
        }
        await this.checkpoint(directory);
      }
    } catch (error) {
      failure = error;
    } finally {
      this.#closed = true;
      try {
        await this.#lock.release();
      } catch (error) {
        const releaseFailure = new WasixStorageError(
          `Node directory storage ${JSON.stringify(this.#root)} closed but its ownership lock could not be released`,
          {
            code: 'unavailable',
            durability: this.#hasStoredGeneration ? 'persisted' : 'unchanged',
            cause: error,
          },
        );
        failure =
          failure instanceof Error
            ? composeWasixStorageFailure(failure, 'ownership release also failed', releaseFailure)
            : releaseFailure;
      }
    }
    if (failure !== undefined) throw failure;
  }
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
    const applicationRoot = await realpath(absolute);
    const stateRoot = join(applicationRoot, STATE_DIRECTORY);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stateInfo = await lstat(stateRoot);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
      throw new Error(`${STATE_DIRECTORY} is not a real directory`);
    }
    const canonicalStateRoot = await realpath(stateRoot);
    assertContained(applicationRoot, canonicalStateRoot);
    await establishStateIdentity(canonicalStateRoot);
    await syncDirectory(applicationRoot);
    return canonicalStateRoot;
  } catch (error) {
    throw unavailable(absolute, `could not prepare the directory: ${describeError(error)}`, error);
  }
}

async function establishStateIdentity(root: string): Promise<void> {
  const marker = join(root, STATE_FILE);
  if (await validateStateMarker(marker)) return;
  const entries = await readdir(root);
  if (entries.includes(STATE_FILE)) {
    await validateStateMarker(marker, true);
    return;
  }
  if (entries.length > 0) {
    throw new Error(`${STATE_DIRECTORY} exists without a recognized storage identity`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(marker, 'wx', 0o600);
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  } finally {
    await handle?.close();
  }
  await validateStateMarker(marker, true);
  await syncDirectory(root);
}

async function readStoredDatabase(
  root: string,
  compatibility: WasixStorageCompatibility,
): Promise<StoredDatabase | undefined> {
  await recoverInterruptedPublish(root);
  const current = join(root, CURRENT_DIRECTORY);
  const previous = join(root, PREVIOUS_DIRECTORY);
  const [hasCurrent, hasPrevious] = await Promise.all([exists(current), exists(previous)]);
  if (!hasCurrent && !hasPrevious) return undefined;
  if (!hasCurrent) {
    await rename(previous, current);
    await syncDirectory(root);
  }

  try {
    const stored = await readGeneration(root, current, compatibility);
    if (hasPrevious) {
      // The new generation is proven complete. Old-generation cleanup is
      // deliberately post-commit and best-effort.
      await rm(previous, { recursive: true, force: true }).catch(() => undefined);
      await syncDirectory(root).catch(() => undefined);
    }
    return stored;
  } catch (error) {
    if (
      !(error instanceof WasixStorageError) ||
      error.code !== 'corrupt' ||
      !(await exists(previous))
    ) {
      throw error;
    }
    let stored: StoredDatabase;
    try {
      stored = await readGeneration(root, previous, compatibility);
    } catch (previousError) {
      throw corrupt(root, 'has no complete recoverable generation', {
        current: error,
        previous: previousError,
      });
    }
    await rm(current, { recursive: true, force: true });
    await rename(previous, current);
    await syncDirectory(root);
    return stored;
  }
}

async function readGeneration(
  root: string,
  generation: string,
  compatibility: WasixStorageCompatibility,
): Promise<StoredDatabase> {
  await requireRealDirectory(root, generation, 'published generation');
  const metadataPath = join(generation, FORMAT_FILE);
  const pgdataPath = join(generation, SNAPSHOT_DIRECTORY);
  const [metadataExists, pgdataExists] = await Promise.all([
    exists(metadataPath),
    exists(pgdataPath),
  ]);
  if (!metadataExists || !pgdataExists) {
    throw corrupt(root, 'contains an incomplete published generation');
  }
  await requireRealFile(root, metadataPath, FORMAT_FILE);
  await requireRealDirectory(root, pgdataPath, SNAPSHOT_DIRECTORY);

  let metadata: NodeDirectoryMetadata;
  try {
    metadata = JSON.parse(
      (await readRealFile(metadataPath, FORMAT_FILE)).toString('utf8'),
    ) as NodeDirectoryMetadata;
  } catch (error) {
    throw corrupt(root, `contains unreadable metadata: ${describeError(error)}`, error);
  }
  if (metadata.schema !== FORMAT) throw corrupt(root, 'uses an unsupported storage format');
  if (!/^[0-9a-f]{64}$/u.test(metadata.snapshotSha256)) {
    throw corrupt(root, 'has a missing or malformed snapshot digest');
  }
  let storedCompatibility: Record<string, unknown>;
  try {
    storedCompatibility = requireRecord(
      metadata.compatibility,
      `Node directory storage ${JSON.stringify(root)} compatibility`,
    );
  } catch (error) {
    throw corrupt(root, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  let storedContract: string;
  try {
    storedContract = canonicalStorageContract(storedCompatibility);
  } catch (error) {
    throw corrupt(root, `has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  if (storedContract !== canonicalStorageContract(compatibility)) {
    throw new WasixStorageError(
      `Node directory storage ${JSON.stringify(root)} is incompatible with the selected runtime or extensions`,
      { code: 'incompatible', durability: 'unchanged' },
    );
  }

  const snapshot = await readHostSnapshot(root, pgdataPath, compatibility);
  if (snapshotSha256(snapshot) !== metadata.snapshotSha256) {
    throw corrupt(root, 'does not match its published snapshot digest');
  }
  return {
    schema: 'oliphaunt-wasix-stored-database-v1',
    compatibility,
    snapshot,
  };
}

async function readHostSnapshot(
  root: string,
  pgdataPath: string,
  compatibility: WasixStorageCompatibility,
): Promise<StoredSnapshot> {
  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = async (parent: string): Promise<void> => {
    const hostParent = parent.length === 0 ? pgdataPath : join(pgdataPath, ...parent.split('/'));
    const entries = await readdir(hostParent, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
      const hostPath = join(pgdataPath, ...relative.split('/'));
      const resolved = await realpath(hostPath);
      assertContained(pgdataPath, resolved);
      if (entry.isSymbolicLink())
        throw corrupt(root, `contains symbolic link ${JSON.stringify(relative)}`);
      if (entry.isDirectory()) {
        directories.push(relative);
        await walk(relative);
      } else if (entry.isFile()) {
        files.push({
          path: relative,
          bytes: new Uint8Array(await readRealFile(hostPath, relative)),
        });
      } else {
        throw corrupt(root, `contains unsupported entry ${JSON.stringify(relative)}`);
      }
    }
  };
  try {
    await walk('');
  } catch (error) {
    if (error instanceof WasixStorageError) throw error;
    throw corrupt(root, `could not read PGDATA: ${describeError(error)}`, error);
  }
  return validateStoredSnapshot(
    { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
    compatibility.runtime.postgresVersion.split('.')[0] ?? '',
    {
      label: `Node directory storage ${JSON.stringify(root)}`,
      corrupt: (detail, cause) => corrupt(root, detail, cause),
    },
  );
}

async function publishGeneration(
  root: string,
  snapshot: StoredSnapshot,
  compatibility: WasixStorageCompatibility,
): Promise<void> {
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const staging = join(root, `.oliphaunt-stage-${token}`);
  const previous = join(root, PREVIOUS_DIRECTORY);
  const current = join(root, CURRENT_DIRECTORY);
  const pgdata = join(staging, SNAPSHOT_DIRECTORY);
  let movedCurrent = false;
  let committed = false;
  try {
    await mkdir(pgdata, { recursive: true, mode: 0o700 });
    for (const relative of snapshot.directories) {
      await mkdir(join(pgdata, ...relative.split('/')), { recursive: true, mode: 0o700 });
    }
    for (const file of snapshot.files) {
      const target = join(pgdata, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeDurableFile(target, file.bytes);
    }
    await writeDurableFile(
      join(staging, FORMAT_FILE),
      `${JSON.stringify({ schema: FORMAT, compatibility, snapshotSha256: snapshotSha256(snapshot) })}\n`,
    );
    for (const relative of [...snapshot.directories].sort(compareDirectoryDepthDescending)) {
      await syncDirectory(join(pgdata, ...relative.split('/')));
    }
    await syncDirectory(pgdata);
    await syncDirectory(staging);
    await syncDirectory(root);
    await rm(previous, { recursive: true, force: true });
    await syncDirectory(root);
    if (await exists(current)) {
      await rename(current, previous);
      movedCurrent = true;
      await syncDirectory(root);
    }
    await rename(staging, current);
    committed = true;
    // `current` is the commit point. Retain the rollback generation until a
    // later open has validated the new one.
    await syncDirectory(root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (committed) {
      throw new WasixStorageError(
        `Node directory storage ${JSON.stringify(root)} published a visible generation but could not confirm its host durability: ${describeError(error)}`,
        { code: 'checkpoint-failed', durability: 'unknown', cause: error },
      );
    }
    if (movedCurrent && !(await exists(current)) && (await exists(previous))) {
      await rename(previous, current).catch(() => undefined);
    }
    throw error;
  }
}

async function recoverInterruptedPublish(root: string): Promise<void> {
  const current = join(root, CURRENT_DIRECTORY);
  const previous = join(root, PREVIOUS_DIRECTORY);
  const entries = await readdir(root, { withFileTypes: true });
  const unexpected = entries.filter(
    (entry) =>
      !(
        (entry.name === STATE_FILE && entry.isFile()) ||
        (entry.name === CURRENT_DIRECTORY && entry.isDirectory()) ||
        (entry.name === PREVIOUS_DIRECTORY && entry.isDirectory()) ||
        (entry.name === NODE_DIRECTORY_LOCK_SLOT && entry.isDirectory()) ||
        (nodeDirectoryLockCandidateToken(entry.name) !== undefined && entry.isDirectory()) ||
        (entry.name.startsWith('.oliphaunt-stage-') && entry.isDirectory())
      ),
  );
  if (unexpected.length > 0) {
    throw corrupt(root, `contains unexpected state entry ${JSON.stringify(unexpected[0]?.name)}`);
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.oliphaunt-stage-'))
      .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })),
  );
  const [hasCurrent, hasPrevious] = await Promise.all([exists(current), exists(previous)]);
  if (!hasCurrent && hasPrevious) {
    await rename(previous, current);
    await syncDirectory(root);
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

async function validateStateMarker(path: string, required = false): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!required && isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) {
    throw new Error(`${STATE_FILE} is not the empty ${FORMAT} identity marker`);
  }
  return true;
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

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    // Some supported filesystems do not allow directory handles. File data is
    // still synced; directory fsync remains mandatory wherever the host offers it.
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].some((code) => isNodeError(error, code))) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function compareDirectoryDepthDescending(left: string, right: string): number {
  return right.split('/').length - left.split('/').length || right.localeCompare(left);
}

function snapshotSha256(snapshot: StoredSnapshot): string {
  const hash = createHash('sha256');
  hash.update(`${snapshot.schema}\0`);
  for (const path of snapshot.directories) hash.update(`d\0${path}\0`);
  for (const file of snapshot.files) {
    hash.update(`f\0${file.path}\0${file.bytes.byteLength}\0`);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
}

async function requireRealDirectory(root: string, path: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    throw corrupt(root, `could not inspect ${label}: ${describeError(error)}`, error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw corrupt(root, `contains non-directory ${label}`);
  }
}

async function requireRealFile(root: string, path: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    throw corrupt(root, `could not inspect ${label}: ${describeError(error)}`, error);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw corrupt(root, `contains non-file ${label}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function assertContained(root: string, path: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(normalizedRoot)) {
    throw new Error(`resolved path escapes ${root}`);
  }
}

function corrupt(root: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`Node directory storage ${JSON.stringify(root)} ${detail}`, {
    code: 'corrupt',
    durability: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function unavailable(root: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`Node directory storage ${JSON.stringify(root)} ${detail}`, {
    code: 'unavailable',
    durability: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
