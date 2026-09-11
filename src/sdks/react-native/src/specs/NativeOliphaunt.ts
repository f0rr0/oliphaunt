import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NativeOpenConfig = {
  storageKind: string;
  storagePath?: string;
  startupGUCs?: Array<string>;
  username?: string;
  database?: string;
  extensions?: Array<{ sqlName: string; product: string; version?: string }>;
  icuVersion?: string;
};

export interface Spec extends TurboModule {
  open(config: NativeOpenConfig): Promise<number>;
  cancel(handle: number): Promise<void>;
  close(handle: number): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Oliphaunt');
