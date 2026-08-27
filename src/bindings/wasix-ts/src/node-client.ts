import { serializeOpenConfig } from './client-common.js';
import { requireNodeStorage, restoreNodeWasix } from './node-client-common.js';
import { openNodeDirect } from './node-direct.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

/** Open PostgreSQL in the importing Node-compatible realm. Guest execution may block it. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  requireNodeStorage(openOptions);
  return openNodeDirect(openOptions);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreNodeWasix,
};
