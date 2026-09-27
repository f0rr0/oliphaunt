import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NativeOpenConfig = {
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  storageKind: string;
  storagePath?: string;
  storageName?: string;
  startupGUCs?: Array<string>;
  username?: string;
  database?: string;
  extensions?: Array<string>;
};

export interface Spec extends TurboModule {
  getTopology(): string;
  open(config: NativeOpenConfig): Promise<number>;
  cancel(handle: number): Promise<void>;
  close(handle: number): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Oliphaunt');
