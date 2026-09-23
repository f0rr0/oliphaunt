export * from './public.js';
import type * as Types from './types.js';
import type * as Storage from './storage.js';

type StorageKind = 'memory' | 'directory';
export type OpenConfig = Types.OpenConfig<StorageKind>;
export type OliphauntClient = Types.OliphauntClient<StorageKind>;
export type WasixStorage = Storage.WasixStorage<StorageKind>;
export type PersistentWasixStorage = Storage.PersistentWasixStorage<Exclude<StorageKind, 'memory'>>;
