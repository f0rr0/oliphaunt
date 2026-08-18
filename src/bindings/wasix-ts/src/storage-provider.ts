import type { WasixDirectoryMount } from './archive.js';
import { WasixStorageError } from './errors.js';
import type { Directory } from './host/index.mjs';
import type { SerializedWasixStorage } from './storage.js';
import { validateIndexedDbDatabaseName, validateOpfsDatabaseName } from './storage.js';

export type WasixStorageCompatibility = Readonly<{
  schema: 'oliphaunt-wasix-pgdata-compatibility-v1';
  runtime: Readonly<{
    product: 'liboliphaunt-wasix';
    version: string;
    manifestSha256: string;
    runtimeArchiveSha256: string;
    pgdataTemplateSha256: string;
    moduleSha256: string;
    sourceFingerprint: string;
    postgresVersion: string;
  }>;
  extensions: readonly Readonly<{
    sqlName: string;
    product: string;
    version: string;
    archiveSha256: string;
    installContract: string;
  }>[];
}>;

export type StorageDirectoryEntry = Readonly<{
  type: 'dir' | 'file' | 'unknown';
  name: string;
}>;

/** Narrow surface currently offered by Wasmer's in-memory `Directory`. */
export type StorageDirectory = {
  readDir(path: string): Promise<StorageDirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  /** Host-patched mutation journal. Older/untracked directories fall back to a full scan. */
  changedPaths?(): readonly string[] | Promise<readonly string[]>;
  clearChanges?(): void | Promise<void>;
  entryType?(path: string): string | Promise<string>;
};

export type WasixStorageSyncBoundary = 'operation' | 'checkpoint' | 'close';

export type WasixStorageLease = {
  /** Whether first-open database and extension setup still has to complete. */
  readonly state: 'new' | 'existing';
  /** Initial contents for a provider's portable `/base` Wasmer memory mount. */
  readonly mount: WasixDirectoryMount;
  /** Optional direct filesystem materializer; portable providers omit it. */
  createDirectory?(DirectoryConstructor: typeof Directory): Promise<Directory>;
  /** Finalize provider-specific state after every first-open setup statement succeeds. */
  completeInitialization(directory: StorageDirectory): Promise<void>;
  /** Complete the provider's PostgreSQL-safe persistence boundary. */
  sync(directory: StorageDirectory, boundary: WasixStorageSyncBoundary): Promise<void>;
  close(directory: StorageDirectory | undefined, outcome: 'clean' | 'failed'): Promise<void>;
};

export type NodeDirectoryStorageAcquirer = (
  path: string,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
  ownerToken?: string,
) => Promise<WasixStorageLease>;

let acquireNodeDirectory: NodeDirectoryStorageAcquirer | undefined;

/** @internal Installed only by a Node host realm so browser graphs stay Node-free. */
export function installNodeDirectoryStorageProvider(acquire: NodeDirectoryStorageAcquirer): void {
  acquireNodeDirectory = acquire;
}

export async function acquireWasixStorage(
  storage: SerializedWasixStorage,
  template: WasixDirectoryMount,
  compatibility: WasixStorageCompatibility,
): Promise<WasixStorageLease> {
  if (storage.schema !== 'oliphaunt-wasix-storage-v2') {
    throw new WasixStorageError('WASIX storage descriptor has an unsupported schema', {
      code: 'unavailable',
      durability: 'unchanged',
    });
  }
  switch (storage.kind) {
    case 'memory':
      return memoryLease(template);
    case 'indexed-db': {
      validateIndexedDbDatabaseName(storage.name);
      const { acquireIndexedDbStorage } = await import('./storage/indexed-db-provider.js');
      return acquireIndexedDbStorage(storage.name, template, compatibility);
    }
    case 'opfs': {
      validateOpfsDatabaseName(storage.name);
      const { acquireOpfsStorage } = await import('./storage/opfs-provider.js');
      return acquireOpfsStorage(storage.name, template, compatibility);
    }
    case 'directory':
      if (acquireNodeDirectory === undefined) {
        throw new WasixStorageError(
          'directory storage is unavailable in this @oliphaunt/wasix-ts host',
          {
            code: 'unavailable',
            durability: 'unchanged',
          },
        );
      }
      return acquireNodeDirectory(storage.path, template, compatibility, storage.ownerToken);
  }
}

/** Stable JSON used only for exact, fail-closed compatibility identities. */
export function canonicalStorageContract(value: unknown): string {
  const active = new Set<object>();
  const canonicalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('storage compatibility metadata contains a non-finite number');
      }
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('storage compatibility metadata is not JSON-compatible');
    }
    if (active.has(candidate)) {
      throw new TypeError('storage compatibility metadata contains a cycle');
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map(canonicalize);
      }
      const record = candidate as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    } finally {
      active.delete(candidate);
    }
  };
  return JSON.stringify(canonicalize(value));
}

export type StoredCompatibilityContext = Readonly<{
  label: string;
  corrupt(detail: string, cause?: unknown): WasixStorageError;
}>;

/** Validate one provider's untrusted compatibility sidecar consistently. */
export function validateStoredCompatibility(
  value: unknown,
  expected: WasixStorageCompatibility,
  context: StoredCompatibilityContext,
): WasixStorageCompatibility {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw context.corrupt('has malformed compatibility metadata');
  }
  let storedContract: string;
  try {
    storedContract = canonicalStorageContract(value);
  } catch (error) {
    throw context.corrupt(`has malformed compatibility metadata: ${describeError(error)}`, error);
  }
  if (storedContract !== canonicalStorageContract(expected)) {
    throw new WasixStorageError(
      `${context.label} is incompatible with the selected runtime or extensions`,
      { code: 'incompatible', durability: 'unchanged' },
    );
  }
  return value as WasixStorageCompatibility;
}

function memoryLease(template: WasixDirectoryMount): WasixStorageLease {
  return {
    state: 'new',
    mount: template,
    async completeInitialization() {},
    async sync() {},
    async close() {},
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
