import type { WasixDirectoryMount } from './archive.js';
import type { WasixStorageError } from './errors.js';
import type { StorageDirectory, WasixStorageCompatibility } from './storage-provider.js';

export const VOLATILE_DATABASE_FILES = new Set(['postmaster.opts', 'postmaster.pid']);

export type StoredSnapshot = {
  schema: 'oliphaunt-wasix-directory-snapshot-v1';
  directories: string[];
  files: { path: string; bytes: Uint8Array }[];
};

export type StoredDatabase = {
  schema: 'oliphaunt-wasix-stored-database-v1';
  compatibility: WasixStorageCompatibility;
  snapshot: StoredSnapshot;
};

export type SnapshotErrorContext = Readonly<{
  label: string;
  corrupt(detail: string, cause?: unknown): WasixStorageError;
}>;

export async function snapshotStorageDirectory(
  directory: StorageDirectory,
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
        await walk(path);
      } else if (entry.type === 'file') {
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
  if (pgVersion === undefined || pgControl === undefined) {
    throw context.corrupt('is missing PG_VERSION or global/pg_control');
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

function validateDirectoryEntryName(name: string): void {
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
