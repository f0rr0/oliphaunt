export * from '../../core/public.js';
import type * as Types from '../../core/types.js';
import type * as Storage from '../../storage/types.js';

type StorageKind = 'memory' | 'indexed-db' | 'opfs';
export type OpenConfig = Types.OpenConfig<StorageKind>;
export type OliphauntClient = Types.OliphauntClient<StorageKind>;
export type WasixStorage = Storage.WasixStorage<StorageKind>;
export type PersistentWasixStorage = Storage.PersistentWasixStorage<Exclude<StorageKind, 'memory'>>;
