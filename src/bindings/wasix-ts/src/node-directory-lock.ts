import { realpathSync, rmdirSync } from 'node:fs';
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { WasixStorageError } from './errors.js';
import { isNodeError } from './node-fs-commit-state.js';

const NODE_DIRECTORY_LOCK_SUFFIX = '.oliphaunt-wasix-ts.lock';

const OWNER_TOKEN = /^[A-Za-z0-9-]{16,128}$/u;
const OWNER_PREFIX = 'owner-';

type HeldNodeDirectoryLock = {
  readonly root: string;
  release(): Promise<void>;
};

/**
 * Claim one local managed root. A pre-existing slot fails closed: callers may
 * remove a stale slot only after establishing that no process owns the root.
 */
export async function acquireNodeDirectoryLock(
  root: string,
  ownerToken: string,
): Promise<HeldNodeDirectoryLock> {
  if (!OWNER_TOKEN.test(ownerToken)) {
    throw unavailable(root, 'received an invalid ownership token');
  }

  const canonicalRoot = await canonicalLockRoot(root);
  const slot = nodeDirectoryLockPath(canonicalRoot);
  const owner = join(slot, ownerName(ownerToken));
  try {
    await mkdir(slot, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) throw busy(canonicalRoot, slot);
    throw unavailable(canonicalRoot, `could not claim ownership: ${describeError(error)}`, error);
  }

  try {
    await mkdir(owner, { mode: 0o700 });
  } catch (error) {
    await rmdir(slot).catch(() => undefined);
    throw unavailable(canonicalRoot, `could not record ownership: ${describeError(error)}`, error);
  }

  let released = false;
  return {
    root: canonicalRoot,
    async release() {
      if (released) return;
      await releaseNodeDirectoryLock(canonicalRoot, ownerToken);
      released = true;
    },
  };
}

/** Remove the slot only after removing this exact owner's child. */
async function releaseNodeDirectoryLock(root: string, ownerToken: string): Promise<void> {
  const slot = nodeDirectoryLockPath(root);
  try {
    await rmdir(join(slot, ownerName(ownerToken)));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  try {
    await rmdir(slot);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/** Best-effort exact-owner cleanup after the database worker exits. */
export function releaseNodeDirectoryLockSync(root: string, ownerToken: string): void {
  if (!OWNER_TOKEN.test(ownerToken)) return;
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalLockRootSync(root);
  } catch {
    return;
  }
  const slot = nodeDirectoryLockPath(canonicalRoot);
  try {
    rmdirSync(join(slot, ownerName(ownerToken)));
  } catch {
    return;
  }
  try {
    rmdirSync(slot);
  } catch {
    // Foreign content keeps the slot busy; never remove it recursively.
  }
}

/** Stable sibling lock identity shared by this binding's open and restore paths. */
export function nodeDirectoryLockPath(root: string): string {
  const name = basename(root);
  if (name.length === 0) throw unavailable(root, 'cannot lock a filesystem root');
  return join(dirname(root), `.${name}${NODE_DIRECTORY_LOCK_SUFFIX}`);
}

/** Resolve parent aliases while keeping a not-yet-created database leaf intact. */
async function canonicalLockRoot(root: string): Promise<string> {
  const absolute = isAbsolute(root) ? root : resolve(root);
  const name = basename(absolute);
  const parent = dirname(absolute);
  if (name.length === 0 || parent === absolute) {
    throw unavailable(root, 'cannot lock a filesystem root');
  }
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return join(await realpath(parent), name);
  } catch (error) {
    throw unavailable(root, `could not resolve its parent: ${describeError(error)}`, error);
  }
}

function canonicalLockRootSync(root: string): string {
  const absolute = isAbsolute(root) ? root : resolve(root);
  const name = basename(absolute);
  const parent = dirname(absolute);
  if (name.length === 0 || parent === absolute) throw new Error('cannot lock a filesystem root');
  return join(realpathSync(parent), name);
}

function ownerName(ownerToken: string): string {
  return `${OWNER_PREFIX}${ownerToken}`;
}

function busy(root: string, slot: string): WasixStorageError {
  return new WasixStorageError(
    `Node directory storage ${JSON.stringify(root)} is already open; ` +
      `if no process owns it, remove the stale lock directory ${JSON.stringify(slot)}`,
    { code: 'busy', commitState: 'unchanged' },
  );
}

function unavailable(root: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`Node directory storage ${JSON.stringify(root)} ${detail}`, {
    code: 'unavailable',
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
