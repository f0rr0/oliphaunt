export * from '../../core/public.js';
import type * as Types from '../../core/types.js';
import type * as Storage from '../../storage/types.js';

type StorageKind = 'memory' | 'directory';
export type OpenConfig = Omit<Types.OpenConfig<StorageKind>, 'timeouts'>;
export type OliphauntClient = Omit<Types.OliphauntClient<StorageKind>, 'open'> & {
  open(config?: OpenConfig): Promise<Types.OliphauntDatabase>;
};
export type WasixStorage = Storage.WasixStorage<StorageKind>;
export type PersistentWasixStorage = Storage.PersistentWasixStorage<Exclude<StorageKind, 'memory'>>;

export { configureHostRuntime, type HostRuntimeOptions } from './host-runtime-options.js';
