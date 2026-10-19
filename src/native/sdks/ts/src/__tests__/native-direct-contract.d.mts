import type { OliphauntClient, OpenConfig } from '../index.js';

export function assertNativeDatabaseContract(
  Oliphaunt: OliphauntClient,
  config: OpenConfig,
  label: string,
): Promise<void>;
