import { rmdirSync, rmSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { WasixStorageError } from './errors.js';
import {
  NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX,
  NODE_DIRECTORY_LOCK_SLOT,
  nodeDirectoryLockCandidateToken,
  nodeDirectoryLockIsStale,
  nodeDirectoryLockName,
  parseNodeDirectoryLockName,
} from './node-lock-identity.js';

const OWNER_TOKEN = /^[A-Za-z0-9-]{16,128}$/u;
const ACQUIRE_ATTEMPTS = 16;

export type HeldNodeDirectoryLock = { release(): Promise<void> };

/**
 * Elect one owner through a fixed atomic rename target. The candidate is fully
 * populated first, so the published directory is also the complete lease.
 */
export async function acquireNodeDirectoryLock(
  root: string,
  ownerToken: string,
): Promise<HeldNodeDirectoryLock> {
  if (!OWNER_TOKEN.test(ownerToken)) {
    throw unavailable(root, 'received an invalid ownership token');
  }
  const ownerName = nodeDirectoryLockName(process.pid, ownerToken);
  const candidate = join(root, `${NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX}${ownerToken}`);
  const slot = join(root, NODE_DIRECTORY_LOCK_SLOT);
  let candidateExists = false;
  let published = false;
  try {
    await mkdir(candidate, { mode: 0o700 });
    candidateExists = true;
    await mkdir(join(candidate, ownerName), { mode: 0o700 });
    await syncDirectory(candidate);
    await syncDirectory(root);

    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        await rename(candidate, slot);
        candidateExists = false;
        published = true;
        await syncDirectory(root);
        await reapLockCandidates(root);
        let released = false;
        return {
          async release() {
            if (released) return;
            await releaseNodeDirectoryLock(root, ownerName);
            released = true;
          },
        };
      } catch (error) {
        if (!isRenameContention(error)) throw error;
        await reapStaleSlot(root, slot);
      }
    }
    throw busy(root);
  } catch (error) {
    if (published) {
      await releaseNodeDirectoryLock(root, ownerName).catch(() => undefined);
    } else if (candidateExists) {
      await rm(candidate, { force: true, recursive: true }).catch(() => undefined);
    }
    if (error instanceof WasixStorageError) throw error;
    throw unavailable(root, `could not record ownership: ${describeError(error)}`, error);
  }
}

/** Remove only the exact owner child before retiring the fixed slot. */
export async function releaseNodeDirectoryLock(root: string, ownerName: string): Promise<void> {
  const slot = join(root, NODE_DIRECTORY_LOCK_SLOT);
  try {
    await rmdir(join(slot, ownerName));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  try {
    await rmdir(slot);
  } catch (error) {
    // A successor may atomically replace the now-empty slot. Never remove it.
    if (!isRetiredSlotRace(error)) throw error;
  }
  await syncDirectory(root);
}

/** Last-resort exact-owner cleanup from the caller's worker exit handler. */
export function releaseNodeDirectoryLockSync(root: string, ownerToken: string): void {
  try {
    rmSync(join(root, `${NODE_DIRECTORY_LOCK_CANDIDATE_PREFIX}${ownerToken}`), {
      force: true,
      recursive: true,
    });
  } catch {
    // The candidate may already be published or retired. Continue with the
    // exact fixed-slot owner cleanup below.
  }
  const slot = join(root, NODE_DIRECTORY_LOCK_SLOT);
  const owner = join(slot, nodeDirectoryLockName(process.pid, ownerToken));
  try {
    rmdirSync(owner);
  } catch {
    return;
  }
  try {
    rmdirSync(slot);
  } catch {
    // A non-empty replacement belongs to a successor and must remain intact.
  }
}

/** A fixed-slot owner may retire every fully namespaced loser candidate. */
async function reapLockCandidates(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (nodeDirectoryLockCandidateToken(entry.name) === undefined) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw busy(root);
    await rm(join(root, entry.name), { force: true, recursive: true });
    removed = true;
  }
  if (removed) await syncDirectory(root);
}

async function reapStaleSlot(root: string, slot: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(slot);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw busy(root);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw busy(root);

  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await readdir(slot, { withFileTypes: true });
  } catch {
    throw busy(root);
  }
  if (entries.length === 0) {
    try {
      await rmdir(slot);
    } catch (error) {
      if (!isRetiredSlotRace(error)) throw busy(root);
    }
    return true;
  }
  if (entries.length !== 1) throw busy(root);
  const entry = entries[0];
  if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) throw busy(root);
  const owner = parseNodeDirectoryLockName(entry.name);
  if (owner === undefined || !nodeDirectoryLockIsStale(owner)) throw busy(root);

  try {
    await rmdir(join(slot, entry.name));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw busy(root);
  }
  try {
    await rmdir(slot);
  } catch (error) {
    if (!isRetiredSlotRace(error)) throw busy(root);
  }
  await syncDirectory(root);
  return true;
}

function isRenameContention(error: unknown): boolean {
  return ['EACCES', 'EEXIST', 'ENOENT', 'ENOTEMPTY', 'EPERM'].some((code) =>
    isNodeError(error, code),
  );
}

function isRetiredSlotRace(error: unknown): boolean {
  return ['EEXIST', 'ENOENT', 'ENOTEMPTY'].some((code) => isNodeError(error, code));
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].some((code) => isNodeError(error, code))) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function busy(root: string): WasixStorageError {
  return new WasixStorageError(`Node directory storage ${JSON.stringify(root)} is already open`, {
    code: 'busy',
    durability: 'unchanged',
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
