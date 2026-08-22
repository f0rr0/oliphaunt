declare const storageDescriptorBrand: unique symbol;
declare const persistentStorageDescriptorBrand: unique symbol;

/**
 * An opaque storage selection created by this package's storage factories.
 * The descriptor is deliberately not a bag of user-authored paths or assets.
 */
export type WasixStorage = Readonly<{
  [storageDescriptorBrand]: 'oliphaunt-wasix-storage';
}>;

/** Opaque persistent storage accepted by static physical restore. */
export type PersistentWasixStorage = WasixStorage &
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
    }>
  | Readonly<{
      schema: 'oliphaunt-wasix-storage-v1';
      kind: 'directory';
      path: string;
      /** @internal Per-worker identity used for exact-owner lock cleanup. */
      ownerToken?: string;
    }>;

const descriptorValues = new WeakMap<object, SerializedWasixStorage>();

/**
 * Select a fresh Wasmer memory filesystem. This is also the default when
 * `storage` is omitted. Reusing the descriptor does not preserve data.
 */
export function memory(): WasixStorage {
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'memory',
  });
}

/** @internal Used by the selectively imported IndexedDB adapter. */
export function defineIndexedDbStorage(name: string): PersistentWasixStorage {
  validateIndexedDbDatabaseName(name);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'indexed-db',
    name,
  }) as PersistentWasixStorage;
}

/** @internal Used by the selectively imported OPFS adapter. */
export function defineOpfsStorage(name: string): PersistentWasixStorage {
  validateOpfsDatabaseName(name);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'opfs',
    name,
  }) as PersistentWasixStorage;
}

/** @internal Used by the selectively imported Node directory adapter. */
export function defineDirectoryStorage(path: string): PersistentWasixStorage {
  validateNodeDirectoryPath(path);
  return defineStorage({
    schema: 'oliphaunt-wasix-storage-v1',
    kind: 'directory',
    path,
  }) as PersistentWasixStorage;
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

export function validateNodeDirectoryPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new TypeError('Node directory storage path must be a non-empty string without NUL bytes');
  }
}

function defineStorage(value: SerializedWasixStorage): WasixStorage {
  const descriptor = Object.freeze({});
  descriptorValues.set(descriptor, Object.freeze(value));
  return descriptor as WasixStorage;
}
