import { serializeOpenConfig } from './client-common.js';
import { requireNodeStorage, restoreNodeWasixDirect } from './node-client-common.js';
import { openNodeDirect } from './node-direct.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

/** Open PostgreSQL in the importing realm, where native work blocks its event loop. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  requireNodeStorage(openOptions);
  return openNodeDirect(openOptions);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreNodeWasixDirect,
};
