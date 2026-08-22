import type { WasixDirectoryMount } from './archive.js';
import type { WasixStorageError } from './errors.js';
import type { StorageDirectory } from './storage-provider.js';

export const VOLATILE_DATABASE_FILES = new Set(['postmaster.opts', 'postmaster.pid']);

export type StoredSnapshot = {
  schema: 'oliphaunt-wasix-directory-snapshot-v1';
  directories: string[];
  files: { path: string; bytes: Uint8Array }[];
};

/** A current-state delta. Deletions and upserts are committed as one boundary. */
export type StorageDelta = {
  directories: string[];
  files: { path: string; bytes: Uint8Array }[];
  deleted: string[];
};

export type StorageEntryType = 'dir' | 'file';

export function splitStorageDeltaDeletes(delta: StorageDelta): {
  replacements: string[];
  removals: string[];
} {
  const upserts = new Set([...delta.directories, ...delta.files.map(({ path }) => path)]);
  return {
    replacements: delta.deleted.filter((path) => upserts.has(path)),
    removals: delta.deleted.filter((path) => !upserts.has(path)),
  };
}

export type SnapshotErrorContext = Readonly<{
  label: string;
  corrupt(detail: string, cause?: unknown): WasixStorageError;
}>;

export async function snapshotStorageDirectory(
  directory: StorageDirectory,
  filter: Readonly<{
    skipFile?: (path: string) => boolean;
    skipDirectoryContents?: (path: string) => boolean;
  }> = {},
): Promise<StoredSnapshot> {
  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];

  const walk = async (parent: string): Promise<void> => {
    const entries = [...(await directory.readDir(parent))].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      validateDirectoryEntryName(entry.name);
      const path = parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
      if (parent.length === 0 && VOLATILE_DATABASE_FILES.has(entry.name)) continue;
      if (entry.type === 'dir') {
        directories.push(path);
        if (filter.skipDirectoryContents?.(path) !== true) await walk(path);
      } else if (entry.type === 'file') {
        if (filter.skipFile?.(path) === true) continue;
        files.push({ path, bytes: (await directory.readFile(path)).slice() });
      } else {
        throw new Error(
          `Wasmer cannot snapshot PGDATA entry ${JSON.stringify(path)} of unknown type`,
        );
      }
    }
  };

  await walk('');
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories,
    files,
  };
}

/**
 * Read only journaled PGDATA paths, falling back to a complete snapshot when
 * the host does not expose mutation tracking or no durable generation exists.
 */
export async function snapshotStorageDelta(
  directory: StorageDirectory,
  persistedEntries: ReadonlyMap<string, StorageEntryType>,
  forceFull = false,
): Promise<StorageDelta> {
  if (forceFull || directory.changedPaths === undefined || directory.entryType === undefined) {
    const snapshot = await snapshotStorageDirectory(directory);
    const current = new Map<string, StorageEntryType>([
      ...snapshot.directories.map((path) => [path, 'dir'] as const),
      ...snapshot.files.map(({ path }) => [path, 'file'] as const),
    ]);
    return {
      directories: snapshot.directories,
      files: snapshot.files,
      deleted: [...persistedEntries]
        .filter(([path, type]) => current.get(path) !== type)
        .map(([path]) => path)
        .sort(comparePathDepthDescending),
    };
  }

  const touched = collapseTouchedPaths(await directory.changedPaths());
  if (touched.length === 0) {
    return { directories: [], files: [], deleted: [] };
  }

  const directories = new Map<string, string>();
  const files = new Map<string, { path: string; bytes: Uint8Array }>();
  const current = new Map<string, StorageEntryType>();
  const inspect = async (path: string): Promise<void> => {
    if (isVolatilePath(path)) return;
    const type = await directory.entryType?.(path);
    if (type === 'missing') return;
    if (type !== 'dir' && type !== 'file') {
      throw new Error(`Wasmer cannot persist PGDATA entry ${JSON.stringify(path)} of unknown type`);
    }
    if (path.length > 0) current.set(path, type);
    if (type === 'file') {
      files.set(path, {
        path,
        bytes: (await directory.readFile(path)).slice(),
      });
      return;
    }
    if (path.length > 0) directories.set(path, path);
    const entries = [...(await directory.readDir(path))].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      validateDirectoryEntryName(entry.name);
      const child = path.length === 0 ? entry.name : `${path}/${entry.name}`;
      await inspect(child);
    }
  };

  for (const path of touched) await inspect(path);
  const deleted = [...persistedEntries]
    .filter(
      ([path, type]) =>
        touched.some((root) => pathIsWithin(path, root)) && current.get(path) !== type,
    )
    .map(([path]) => path)
    .sort(comparePathDepthDescending);
  return {
    directories: [...directories.keys()].sort(compareDirectoryDepth),
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    deleted,
  };
}

export function applyStorageDeltaToEntries(
  persistedEntries: Map<string, StorageEntryType>,
  delta: StorageDelta,
): void {
  for (const path of delta.deleted) persistedEntries.delete(path);
  for (const path of delta.directories) persistedEntries.set(path, 'dir');
  for (const { path } of delta.files) persistedEntries.set(path, 'file');
}

export function validateStoredSnapshot(
  value: unknown,
  expectedPostgresMajor: string,
  context: SnapshotErrorContext,
): StoredSnapshot {
  let snapshot: Record<string, unknown>;
  try {
    snapshot = requireRecord(value, `${context.label} snapshot`);
  } catch (error) {
    throw context.corrupt(`has a malformed directory snapshot: ${describeError(error)}`, error);
  }
  if (snapshot.schema !== 'oliphaunt-wasix-directory-snapshot-v1') {
    throw context.corrupt('has an unsupported directory snapshot');
  }
  if (!Array.isArray(snapshot.directories) || !Array.isArray(snapshot.files)) {
    throw context.corrupt('has malformed directory or file rows');
  }

  const directories: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const paths = new Set<string>();
  for (const path of snapshot.directories) {
    validateStoredPath(path, context);
    if (paths.has(path)) throw context.corrupt(`repeats snapshot path ${JSON.stringify(path)}`);
    paths.add(path);
    directories.push(path);
  }
  for (const value of snapshot.files) {
    let file: Record<string, unknown>;
    try {
      file = requireRecord(value, `${context.label} file row`);
    } catch (error) {
      throw context.corrupt(`has a malformed file row: ${describeError(error)}`, error);
    }
    validateStoredPath(file.path, context);
    if (!(file.bytes instanceof Uint8Array)) {
      throw context.corrupt(`has non-binary contents for ${JSON.stringify(file.path)}`);
    }
    if (paths.has(file.path)) {
      throw context.corrupt(`repeats snapshot path ${JSON.stringify(file.path)}`);
    }
    paths.add(file.path);
    files.push({ path: file.path, bytes: file.bytes.slice() });
  }
  validateSnapshotSemantics(directories, files, paths, expectedPostgresMajor, context);
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1',
    directories: directories.sort(compareDirectoryDepth),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function snapshotToMount(snapshot: StoredSnapshot): WasixDirectoryMount {
  return {
    files: Object.fromEntries(snapshot.files.map((file) => [file.path, file.bytes])),
    directories: [...snapshot.directories],
  };
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateSnapshotSemantics(
  directories: readonly string[],
  files: readonly { path: string; bytes: Uint8Array }[],
  paths: ReadonlySet<string>,
  expectedPostgresMajor: string,
  context: SnapshotErrorContext,
): void {
  for (const volatile of VOLATILE_DATABASE_FILES) {
    if (paths.has(volatile)) {
      throw context.corrupt(
        `contains transient PostgreSQL process state ${JSON.stringify(volatile)}`,
      );
    }
  }

  const directoryPaths = new Set(directories);
  const fileByPath = new Map(files.map((file) => [file.path, file.bytes]));
  for (const path of paths) {
    for (const parent of parentPaths(path)) {
      if (fileByPath.has(parent)) {
        throw context.corrupt(
          `contains path ${JSON.stringify(path)} below file ${JSON.stringify(parent)}`,
        );
      }
      if (!directoryPaths.has(parent)) {
        throw context.corrupt(
          `contains path ${JSON.stringify(path)} without parent directory ${JSON.stringify(parent)}`,
        );
      }
    }
  }

  const pgVersion = fileByPath.get('PG_VERSION');
  const pgControl = fileByPath.get('global/pg_control');
  if (pgVersion === undefined || pgControl === undefined || !directoryPaths.has('pg_wal')) {
    throw context.corrupt('is missing PG_VERSION, global/pg_control, or pg_wal');
  }
  if (pgControl.length === 0) throw context.corrupt('contains an empty global/pg_control');

  let actualPostgresMajor: string;
  try {
    actualPostgresMajor = new TextDecoder('utf-8', { fatal: true }).decode(pgVersion).trim();
  } catch (error) {
    throw context.corrupt(`contains a non-UTF-8 PG_VERSION: ${describeError(error)}`, error);
  }
  if (actualPostgresMajor !== expectedPostgresMajor) {
    throw context.corrupt(
      `contains PG_VERSION ${JSON.stringify(actualPostgresMajor)}, expected ${JSON.stringify(expectedPostgresMajor)}`,
    );
  }
}

export function validateDirectoryEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`Wasmer returned an unsafe PGDATA entry name ${JSON.stringify(name)}`);
  }
}

function validateStoredPath(
  value: unknown,
  context: SnapshotErrorContext,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')) {
    throw context.corrupt(`contains invalid snapshot path ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw context.corrupt(`contains unsafe snapshot path ${JSON.stringify(value)}`);
  }
}

function parentPaths(path: string): string[] {
  const segments = path.split('/');
  const parents: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    parents.push(segments.slice(0, length).join('/'));
  }
  return parents;
}

function compareDirectoryDepth(left: string, right: string): number {
  return left.split('/').length - right.split('/').length || left.localeCompare(right);
}

function collapseTouchedPaths(values: readonly string[]): string[] {
  const paths = [...new Set(values.map(validateTouchedPath))].sort(compareDirectoryDepth);
  return paths.filter(
    (path, index) => !paths.slice(0, index).some((parent) => pathIsWithin(path, parent)),
  );
}

function validateTouchedPath(path: string): string {
  if (path === '') return path;
  if (typeof path !== 'string' || path.startsWith('/')) {
    throw new Error(`Wasmer returned an unsafe changed PGDATA path ${JSON.stringify(path)}`);
  }
  const segments = path.split('/');
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Wasmer returned an unsafe changed PGDATA path ${JSON.stringify(path)}`);
  }
  return path;
}

function pathIsWithin(path: string, root: string): boolean {
  return root.length === 0 || path === root || path.startsWith(`${root}/`);
}

function isVolatilePath(path: string): boolean {
  const root = path.split('/')[0];
  return root !== undefined && VOLATILE_DATABASE_FILES.has(root);
}

function comparePathDepthDescending(left: string, right: string): number {
  return right.split('/').length - left.split('/').length || right.localeCompare(left);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
