import { DEFAULT_OPFS_MAX_CONCURRENT_IO } from './types.js';
import type { WasixDirectoryMount } from '../resources/archive.js';
import { parseJsonWithUniqueObjectKeys } from './database-root.js';
import { WasixStorageError } from '../core/errors.js';
import {
  assertWasixPhysicalIdentity,
  physicalIdentityMatches,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
} from './storage-provider.js';
import {
  type StorageDelta,
  type StoredSnapshot,
  splitStorageDeltaDeletes,
  VOLATILE_DATABASE_FILES,
  validateDirectoryEntryName,
  validateStoredSnapshot,
} from './storage-snapshot.js';

export const OPFS_POOL_ROOT = '.oliphaunt-wasix-pool-v1';

const STATE_FILE = 'state.json';
const DATA_DIRECTORY = 'data';
const STATE_SCHEMA = 'oliphaunt-wasix-opfs-pool-v1';
const UTF8_ENCODER = new TextEncoder();

type StoredDirectory = Readonly<{ path: string; type: 'directory' }>;
type StoredFile = Readonly<{ path: string; type: 'file'; backing: string }>;
type StoredEntry = StoredDirectory | StoredFile;

type PoolState = Readonly<{
  schema: typeof STATE_SCHEMA;
  name: string;
  phase: 'initializing' | 'ready';
  physicalIdentity: WasixPhysicalIdentity;
  entries: readonly StoredEntry[];
}>;

export type PooledOpfsDatabase = Readonly<{
  snapshot: StoredSnapshot | undefined;
  state: 'new' | 'existing';
}>;

export async function inspectPooledOpfsDatabase(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<PooledOpfsDatabase> {
  const state = await readPoolState(database, name, physicalIdentity);
  return inspectPoolState(database, name, physicalIdentity, state, maxConcurrentIO);
}

/** Reset only an unpublished first-open generation before portable hydration. */
export async function preparePooledOpfsDatabase(
  database: FileSystemDirectoryHandle,
  name: string,
  loadClusterSeed: WasixClusterSeedLoader,
  physicalIdentity: WasixPhysicalIdentity,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<PooledOpfsDatabase> {
  let state = await readPoolState(database, name, physicalIdentity);
  if (state?.phase === 'initializing') {
    ({ state } = await resetPoolClusterSeed(
      database,
      name,
      await loadClusterSeed(),
      assertWasixPhysicalIdentity(physicalIdentity),
      maxConcurrentIO,
    ));
  }
  return inspectPoolState(database, name, physicalIdentity, state, maxConcurrentIO);
}

async function inspectPoolState(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  state: PoolState | undefined,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<PooledOpfsDatabase> {
  if (state === undefined) return { snapshot: undefined, state: 'new' };
  let data: FileSystemDirectoryHandle;
  try {
    data = await database.getDirectoryHandle(DATA_DIRECTORY);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') {
      throw corrupt(name, 'is missing its backing-file directory', error);
    }
    throw error;
  }
  const entries = state.entries.filter((entry) => !VOLATILE_DATABASE_FILES.has(entry.path));
  if (entries.length !== state.entries.length) {
    await writePoolState(database, { ...state, entries });
    await pruneUnreferencedData(data, entries, maxConcurrentIO).catch(() => undefined);
  }
  const directories = entries
    .filter((entry): entry is StoredDirectory => entry.type === 'directory')
    .map(({ path }) => path);
  const storedFiles = entries.filter((entry): entry is StoredFile => entry.type === 'file');
  const files = await parallelMap(
    storedFiles,
    async ({ path, backing }) => {
      try {
        return {
          path,
          bytes: new Uint8Array(
            await (await (await data.getFileHandle(backing)).getFile()).arrayBuffer(),
          ),
        };
      } catch (error) {
        if (errorName(error) === 'NotFoundError') {
          throw corrupt(
            name,
            `is missing backing ${JSON.stringify(backing)} for ${JSON.stringify(path)}`,
            error,
          );
        }
        throw error;
      }
    },
    maxConcurrentIO,
  );
  return {
    snapshot: validateStoredSnapshot(
      { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories, files },
      String(physicalIdentity.postgresMajor),
      {
        label: poolLabel(name),
        corrupt: (detail, cause) => corrupt(name, detail, cause),
      },
    ),
    state: state.phase === 'ready' ? 'existing' : 'new',
  };
}

export async function applyPooledOpfsDelta(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
  delta: StorageDelta,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<void> {
  validateDeltaPaths(delta, name);
  const data = await database.getDirectoryHandle(DATA_DIRECTORY, { create: true });
  const existing = await readPoolState(database, name, physicalIdentity);
  const entries = new Map<string, StoredEntry>(
    existing?.entries.map((entry) => [entry.path, entry]),
  );
  await pruneUnreferencedData(data, entries.values(), maxConcurrentIO).catch(() => undefined);
  const deletes = splitStorageDeltaDeletes(delta);
  for (const path of deletes.replacements) removeStoredPath(entries, path);
  for (const path of delta.directories) entries.set(path, { path, type: 'directory' });
  const files = [...delta.files].sort(comparePostgresPaths);
  for (const { path, bytes } of files) {
    const backing = newBackingName();
    await writeAtomicDataFile(data, backing, bytes);
    entries.set(path, { path, type: 'file', backing });
  }
  for (const path of deletes.removals) removeStoredPath(entries, path);
  validateEntryRelationships([...entries.values()], name);
  await writePoolState(database, {
    schema: STATE_SCHEMA,
    name,
    phase: 'ready',
    physicalIdentity: assertWasixPhysicalIdentity(physicalIdentity),
    entries: [...entries.values()].sort(compareStoredEntries),
  });
  await pruneUnreferencedData(data, entries.values(), maxConcurrentIO).catch(() => undefined);
}

export async function openPooledDatabaseDirectory(
  name: string,
): Promise<FileSystemDirectoryHandle> {
  const root = await openPooledOpfsRoot();
  return root.getDirectoryHandle(name, { create: true });
}

export async function openPooledOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const origin = await requireOpfsRoot();
  return origin.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
}

async function initializePoolState(
  database: FileSystemDirectoryHandle,
  data: FileSystemDirectoryHandle,
  name: string,
  clusterSeed: WasixDirectoryMount,
  physicalIdentity: WasixPhysicalIdentity,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<PoolState> {
  const entries: StoredEntry[] = [...new Set(clusterSeed.directories)].map((path) => ({
    path,
    type: 'directory',
  }));
  const files = await parallelMap(
    Object.entries(clusterSeed.files),
    async ([path, bytes]) => {
      const backing = newBackingName();
      await writeAtomicDataFile(data, backing, bytes);
      return { path, type: 'file', backing } satisfies StoredFile;
    },
    maxConcurrentIO,
  );
  entries.push(...files);
  const state: PoolState = {
    schema: STATE_SCHEMA,
    name,
    phase: 'initializing',
    physicalIdentity,
    entries: entries.sort(compareStoredEntries),
  };
  await writePoolState(database, state);
  return state;
}

async function resetPoolClusterSeed(
  database: FileSystemDirectoryHandle,
  name: string,
  clusterSeed: WasixDirectoryMount,
  physicalIdentity: WasixPhysicalIdentity,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<{ data: FileSystemDirectoryHandle; state: PoolState }> {
  try {
    await database.removeEntry(DATA_DIRECTORY, { recursive: true });
  } catch (error) {
    if (errorName(error) !== 'NotFoundError') throw error;
  }
  const data = await database.getDirectoryHandle(DATA_DIRECTORY, { create: true });
  const state = await initializePoolState(
    database,
    data,
    name,
    clusterSeed,
    physicalIdentity,
    maxConcurrentIO,
  );
  return { data, state };
}

async function readPoolState(
  database: FileSystemDirectoryHandle,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
): Promise<PoolState | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await database.getFileHandle(STATE_FILE);
  } catch (error) {
    if (errorName(error) === 'NotFoundError') {
      for await (const entry of database.keys()) {
        if (entry !== DATA_DIRECTORY)
          throw corrupt(name, 'contains storage without state metadata');
      }
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithUniqueObjectKeys(await (await handle.getFile()).text());
  } catch (error) {
    throw corrupt(name, `has malformed state metadata: ${describeError(error)}`, error);
  }
  if (
    !isObject(parsed) ||
    parsed.schema !== STATE_SCHEMA ||
    parsed.name !== name ||
    (parsed.phase !== 'initializing' && parsed.phase !== 'ready') ||
    !Array.isArray(parsed.entries) ||
    !hasExactKeys(parsed, ['entries', 'name', 'phase', 'physicalIdentity', 'schema'])
  ) {
    throw corrupt(name, 'has unsupported or mismatched state metadata');
  }
  let compatible: boolean;
  try {
    compatible = physicalIdentityMatches(parsed.physicalIdentity, physicalIdentity);
  } catch (error) {
    throw corrupt(name, `has malformed physical identity: ${describeError(error)}`, error);
  }
  if (!compatible) {
    throw new WasixStorageError(
      `${poolLabel(name)} is incompatible with the selected WASIX runtime`,
      { code: 'incompatible', commitState: 'unchanged' },
    );
  }
  const paths = new Set<string>();
  const backings = new Set<string>();
  const entries: StoredEntry[] = parsed.entries.map((entry: unknown) => {
    if (!isObject(entry) || typeof entry.path !== 'string') {
      throw corrupt(name, 'contains a malformed state entry');
    }
    try {
      validateStoredPath(entry.path);
    } catch (error) {
      throw corrupt(name, `contains invalid path ${JSON.stringify(entry.path)}`, error);
    }
    if (paths.has(entry.path)) throw corrupt(name, `repeats path ${JSON.stringify(entry.path)}`);
    paths.add(entry.path);
    if (entry.type === 'directory') {
      if (!hasExactKeys(entry, ['path', 'type'])) {
        throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
      }
      return { path: entry.path, type: 'directory' };
    }
    if (entry.type !== 'file' || typeof entry.backing !== 'string') {
      throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
    }
    if (!hasExactKeys(entry, ['backing', 'path', 'type'])) {
      throw corrupt(name, `contains a malformed entry for ${JSON.stringify(entry.path)}`);
    }
    try {
      validateBackingName(entry.backing);
    } catch (error) {
      throw corrupt(name, `contains invalid backing for ${JSON.stringify(entry.path)}`, error);
    }
    if (backings.has(entry.backing)) {
      throw corrupt(name, `aliases backing file ${JSON.stringify(entry.backing)}`);
    }
    backings.add(entry.backing);
    return { path: entry.path, type: 'file', backing: entry.backing };
  });
  validateEntryRelationships(entries, name);
  return {
    schema: STATE_SCHEMA,
    name,
    phase: parsed.phase,
    physicalIdentity: parsed.physicalIdentity as WasixPhysicalIdentity,
    entries,
  };
}

async function writePoolState(
  database: FileSystemDirectoryHandle,
  state: PoolState,
): Promise<void> {
  const handle = await database.getFileHandle(STATE_FILE, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(UTF8_ENCODER.encode(JSON.stringify(state)) as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function writeAtomicDataFile(
  data: FileSystemDirectoryHandle,
  backing: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await data.getFileHandle(backing, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

function removeStoredPath(entries: Map<string, StoredEntry>, path: string): void {
  for (const candidate of [...entries.keys()]) {
    if (candidate === path || candidate.startsWith(`${path}/`)) entries.delete(candidate);
  }
}

async function pruneUnreferencedData(
  data: FileSystemDirectoryHandle,
  entries: Iterable<StoredEntry>,
  maxConcurrentIO = DEFAULT_OPFS_MAX_CONCURRENT_IO,
): Promise<void> {
  const referenced = new Set(
    [...entries].flatMap((entry) => (entry.type === 'file' ? [entry.backing] : [])),
  );
  const removals: string[] = [];
  for await (const backing of data.keys()) {
    if (!referenced.has(backing)) removals.push(backing);
  }
  await parallelMap(removals, (backing) => data.removeEntry(backing), maxConcurrentIO);
}

function validateDeltaPaths(delta: StorageDelta, name: string): void {
  for (const path of [
    ...delta.directories,
    ...delta.files.map((file) => file.path),
    ...delta.deleted,
  ]) {
    try {
      validateStoredPath(path);
    } catch (error) {
      throw corrupt(name, `received invalid path ${JSON.stringify(path)}`, error);
    }
  }
}

function validateEntryRelationships(entries: readonly StoredEntry[], name: string): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    if (parent !== '' && byPath.get(parent)?.type !== 'directory') {
      throw corrupt(name, `is missing parent directory ${JSON.stringify(parent)}`);
    }
  }
}

function validateStoredPath(path: string): void {
  const parts = segments(path);
  if (parts.length === 0) throw new Error('empty stored path');
  for (const part of parts) validateDirectoryEntryName(part);
}

function segments(path: string): string[] {
  if (path === '') return [];
  const parts = path.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    throw invalid();
  }
  return parts;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function newBackingName(): string {
  return `f-${crypto.randomUUID()}`;
}

function validateBackingName(name: string): void {
  if (!/^f-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) {
    throw new Error(`invalid OPFS pool backing name ${JSON.stringify(name)}`);
  }
}

function comparePostgresPaths(left: { path: string }, right: { path: string }): number {
  return postgresRank(left.path) - postgresRank(right.path) || left.path.localeCompare(right.path);
}

function postgresRank(path: string): number {
  if (path.startsWith('pg_wal/')) return 0;
  if (path === 'global/pg_control') return 2;
  return 1;
}

function compareStoredEntries(left: StoredEntry, right: StoredEntry): number {
  return left.path.localeCompare(right.path);
}
function invalid(): DOMException {
  return new DOMException('invalid OPFS path', 'DataError');
}

async function requireOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = globalThis.navigator?.storage;
  if (storage?.getDirectory === undefined) {
    throw new WasixStorageError('OPFS is unavailable in this @oliphaunt/wasix-ts host', {
      code: 'unavailable',
      commitState: 'unchanged',
    });
  }
  return storage.getDirectory();
}

async function parallelMap<Input, Output>(
  values: readonly Input[],
  operation: (value: Input) => Promise<Output>,
  maxConcurrentIO: number,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && cursor < values.length) {
      const index = cursor++;
      try {
        output[index] = await operation(values[index] as Input);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrentIO, values.length) }, worker));
  if (failed) throw failure;
  return output;
}

function poolLabel(name: string): string {
  return `OPFS storage ${JSON.stringify(name)}`;
}
function corrupt(name: string, detail: string, cause?: unknown): WasixStorageError {
  return new WasixStorageError(`${poolLabel(name)} ${detail}`, {
    code: 'corrupt',
    commitState: 'unchanged',
    ...(cause === undefined ? {} : { cause }),
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
