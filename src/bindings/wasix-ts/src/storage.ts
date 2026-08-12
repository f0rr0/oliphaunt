declare const storageDescriptorBrand: unique symbol;

/**
 * An opaque storage selection created by this package's storage factories.
 * The descriptor is deliberately not a bag of user-authored paths or assets.
 */
export type WasixStorage = Readonly<{
  [storageDescriptorBrand]: 'oliphaunt-wasix-storage';
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
    }>;

const descriptorValues = new WeakMap<object, SerializedWasixStorage>();

/**
 * Select a fresh Wasmer memory filesystem. This is also the default when
 * `storage` is omitted. Reusing the descriptor does not preserve data.
 */
export function memory(): WasixStorage {
  return defineStorage({ schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' });
}

/** @internal Used by the selectively imported IndexedDB adapter. */
export function defineIndexedDbStorage(name: string): WasixStorage {
  validateIndexedDbDatabaseName(name);
  return defineStorage({ schema: 'oliphaunt-wasix-storage-v1', kind: 'indexed-db', name });
}

/** @internal Validate and project the opaque main-thread value for the worker. */
export function serializeWasixStorage(storage: WasixStorage | undefined): SerializedWasixStorage {
  if (storage === undefined) {
    return { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' };
  }
  const value = descriptorValues.get(storage as object);
  if (value === undefined) {
    throw new TypeError(
      'storage must come from @oliphaunt/wasix or one of its storage adapter subpaths',
    );
  }
  return value.kind === 'memory' ? { ...value } : { ...value, name: value.name };
}

export function validateIndexedDbDatabaseName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200 || name.includes('\0')) {
    throw new TypeError('IndexedDB storage name must be 1-200 characters without NUL bytes');
  }
}

function defineStorage(value: SerializedWasixStorage): WasixStorage {
  const descriptor = Object.freeze({});
  descriptorValues.set(descriptor, Object.freeze(value));
  return descriptor as WasixStorage;
}
