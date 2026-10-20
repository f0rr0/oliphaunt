declare const storageDescriptorBrand: unique symbol;
declare const persistentStorageDescriptorBrand: unique symbol;

export type OpfsOptions = Readonly<{
  /** Parallel asynchronous setup, snapshot and cleanup operations. Default: 16. */
  maxConcurrentIO?: number;
  /** Target unused synchronous file handles between operations. Default: 32.
   * More handles reduce overflow staging but increase startup and browser resource use.
   * This is a reserve, not a database file-count limit; zero uses durable staging.
   */
  spareFileCount?: number;
}>;
export const DEFAULT_OPFS_MAX_CONCURRENT_IO = 16;
export const DEFAULT_OPFS_SPARE_FILE_COUNT = 32;

/**
 * An opaque storage selection created by this package's storage factories.
 * The descriptor is deliberately not a bag of user-authored paths or assets.
 */
export type WasixStorageKind = 'memory' | 'directory' | 'indexed-db' | 'opfs';

export type WasixStorage<Kind extends WasixStorageKind = WasixStorageKind> = Readonly<{
  [storageDescriptorBrand]: Kind;
}>;

/** Opaque persistent storage accepted by static physical restore. */
export type PersistentWasixStorage<
  Kind extends Exclude<WasixStorageKind, 'memory'> = Exclude<WasixStorageKind, 'memory'>,
> = WasixStorage<Kind> &
  Readonly<{
    [persistentStorageDescriptorBrand]: 'oliphaunt-wasix-persistent-storage';
  }>;

export type SerializedWasixStorage =
  | Readonly<{
      schema: 'oliphaunt-wasix-storage-v1';
      kind: 'memory';
    }>
  | Readonly<{
      schema: 'oliphaunt-wasix-storage-v1';
      kind: 'indexed-db';
      name: string;
    }>
  | Readonly<{
      schema: 'oliphaunt-wasix-storage-v1';
      kind: 'opfs';
      name: string;
      maxConcurrentIO?: number;
      spareFileCount?: number;
    }>
  | Readonly<{
      schema: 'oliphaunt-wasix-storage-v1';
      kind: 'directory';
      path: string;
    }>;

const descriptorValues = new WeakMap<object, SerializedWasixStorage>();

/**
 * Select a fresh in-memory database. This is also the default when `storage`
 * is omitted. Reusing the descriptor does not preserve data.
 */
export function memory(): WasixStorage<'memory'> {
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'memory',
  });
}

/** @internal Used by the selectively imported IndexedDB adapter. */
export function defineIndexedDbStorage(name: string): PersistentWasixStorage<'indexed-db'> {
  validateIndexedDbDatabaseName(name);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'indexed-db',
    name,
  }) as PersistentWasixStorage<'indexed-db'>;
}

/** @internal Used by the selectively imported OPFS adapter. */
export function defineOpfsStorage(
  name: string,
  options: OpfsOptions = {},
): PersistentWasixStorage<'opfs'> {
  validateOpfsDatabaseName(name);
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'maxConcurrentIO' && key !== 'spareFileCount')
  ) {
    throw new TypeError('unknown OPFS option; expected maxConcurrentIO or spareFileCount');
  }
  const maxConcurrentIO = options.maxConcurrentIO;
  validateOpfsConcurrency(maxConcurrentIO);
  const spareFileCount = options.spareFileCount;
  validateOpfsSpareFileCount(spareFileCount);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'opfs',
    name,
    ...(maxConcurrentIO === undefined ? {} : { maxConcurrentIO }),
    ...(spareFileCount === undefined ? {} : { spareFileCount }),
  }) as PersistentWasixStorage<'opfs'>;
}

/** @internal Used by the selectively imported Node directory adapter. */
export function defineDirectoryStorage(path: string): PersistentWasixStorage<'directory'> {
  validateHostDirectoryPath(path);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'directory',
    path,
  }) as PersistentWasixStorage<'directory'>;
}

/** @internal Validate and project the opaque main-thread value for the worker. */
export function serializeWasixStorage(storage: WasixStorage | undefined): SerializedWasixStorage {
  if (storage === undefined) {
    return { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' };
  }
  const value = descriptorValues.get(storage as object);
  if (value === undefined) {
    throw new TypeError(
      'storage must come from @oliphaunt/wasix-ts or one of its storage adapter subpaths',
    );
  }
  switch (value.kind) {
    case 'memory':
      return { ...value };
    case 'indexed-db':
      return { ...value, name: value.name };
    case 'opfs':
      return { ...value, name: value.name };
    case 'directory':
      return { ...value, path: value.path };
  }
}

export function validateIndexedDbDatabaseName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200 || name.includes('\0')) {
    throw new TypeError('IndexedDB storage name must be 1-200 characters without NUL bytes');
  }
}

export function validateOpfsDatabaseName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 100 ||
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new TypeError(
      'OPFS storage name must be 1-100 ASCII letters, digits, dot, dash, or underscore',
    );
  }
}

export function validateOpfsConcurrency(value: unknown): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
    throw new TypeError('OPFS maxConcurrentIO must be a positive safe integer');
  }
}

export function validateOpfsSpareFileCount(value: unknown): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new TypeError('OPFS spareFileCount must be a non-negative safe integer');
  }
}

export function validateHostDirectoryPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new TypeError('host directory storage path must be a non-empty string without NUL bytes');
  }
}

function defineStorage<Value extends SerializedWasixStorage>(
  value: Value,
): WasixStorage<Value['kind']> {
  const descriptor = Object.freeze({});
  descriptorValues.set(descriptor, Object.freeze<SerializedWasixStorage>(value));
  return descriptor as WasixStorage<Value['kind']>;
}
