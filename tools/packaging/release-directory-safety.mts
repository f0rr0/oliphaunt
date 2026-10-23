import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const DARWIN_ROOT_DIRECTORY_ALIASES = Object.freeze(
  new Map([
    ['etc', 'private/etc'],
    ['tmp', 'private/tmp'],
    ['var', 'private/var'],
  ]),
);

function hasStableDirectoryIdentity(metadata) {
  return (
    metadata?.isDirectory?.() === true &&
    typeof metadata.dev === 'bigint' &&
    metadata.dev > 0n &&
    typeof metadata.ino === 'bigint' &&
    metadata.ino > 0n
  );
}

/**
 * Canonicalize only Darwin's fixed root-level system directory aliases.
 *
 * The alias and canonical target must dereference to the same stable device
 * and inode. Any inspection failure or mismatch returns the lexical path so
 * the caller's lstat-based directory-chain validation fails closed.
 * Caller-created aliases outside this fixed set are never followed.
 */
export function canonicalSystemDirectoryPath(
  directory,
  { platform = process.platform, lstat = lstatSync, stat = statSync } = {},
) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('system directory canonicalization requires a nonempty path');
  }
  const resolved = path.resolve(directory);
  if (platform !== 'darwin') return resolved;
  if (!path.posix.isAbsolute(resolved)) {
    throw new Error('Darwin system directory canonicalization requires an absolute POSIX path');
  }

  const relative = path.posix.relative('/', resolved);
  const [aliasName, ...suffix] = relative ? relative.split('/') : [];
  const canonicalRelative = DARWIN_ROOT_DIRECTORY_ALIASES.get(aliasName);
  if (!canonicalRelative) return resolved;

  const alias = path.posix.join('/', aliasName);
  const canonicalAlias = path.posix.join('/', canonicalRelative);
  let aliasEntry;
  let aliasIdentity;
  let canonicalIdentity;
  try {
    aliasEntry = lstat(alias, { bigint: true });
    aliasIdentity = stat(alias, { bigint: true });
    canonicalIdentity = stat(canonicalAlias, { bigint: true });
  } catch {
    return resolved;
  }
  if (
    !aliasEntry.isSymbolicLink() ||
    !hasStableDirectoryIdentity(aliasIdentity) ||
    !hasStableDirectoryIdentity(canonicalIdentity) ||
    aliasIdentity.dev !== canonicalIdentity.dev ||
    aliasIdentity.ino !== canonicalIdentity.ino
  ) {
    return resolved;
  }
  return path.posix.join(canonicalAlias, ...suffix);
}

/**
 * Resolve and validate a complete directory chain without following arbitrary
 * symlinks. Missing suffix directories may be created one at a time and are
 * always re-inspected before use.
 */
export function requireSafeDirectoryChain(
  directory,
  {
    create = false,
    label = 'directory',
    mode = 0o755,
    platform = process.platform,
    lstat = lstatSync,
    stat = statSync,
    mkdir = mkdirSync,
  } = {},
) {
  const resolved = canonicalSystemDirectoryPath(directory, { platform, lstat, stat });
  const filesystemRoot = path.parse(resolved).root;
  let cursor = filesystemRoot;
  const inspect = (candidate, { allowCreate = false } = {}) => {
    let metadata;
    try {
      metadata = lstat(candidate);
    } catch (cause) {
      if (cause?.code !== 'ENOENT' || !allowCreate) {
        throw new Error(`${label} cannot be inspected: ${candidate}: ${cause.message}`);
      }
      try {
        mkdir(candidate, { mode });
        metadata = lstat(candidate);
      } catch (createCause) {
        throw new Error(`${label} cannot be created safely: ${candidate}: ${createCause.message}`);
      }
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} must not have a symlink or non-directory ancestor: ${candidate}`);
    }
  };

  inspect(cursor);
  const relative = path.relative(filesystemRoot, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, part);
    inspect(cursor, { allowCreate: create });
  }
  return resolved;
}

/** Remove only a caller-owned real directory; captured source modes stay untouched. */
export function removeOwnedDirectory(directory: string) {
  const resolved = canonicalSystemDirectoryPath(directory);
  if (resolved === path.parse(resolved).root)
    throw new Error('owned directory cleanup must not remove a filesystem root');
  requireSafeDirectoryChain(path.dirname(resolved), { label: 'owned directory cleanup' });
  try {
    lstatSync(resolved);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  const makeWritable = (directory: string) => {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('owned directory cleanup requires a real directory');
    chmodSync(directory, (metadata.mode & 0o777) | 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) makeWritable(path.join(directory, entry.name));
  };
  makeWritable(resolved);
  // Recursive removal unlinks nested symlinks; neither traversal nor chmod follows them.
  rmSync(resolved, { recursive: true, force: true });
}
