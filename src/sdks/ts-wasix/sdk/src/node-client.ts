import { serializeOpenConfig } from './client-common.js';
import { requireNodeStorage, restoreNodeWasix } from './node-client-common.js';
import { openNodeActor } from './node-actor.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

/** Open PostgreSQL on a dedicated Rust owner while keeping the caller event loop responsive. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  requireNodeStorage(openOptions);
  return openNodeActor(openOptions);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreNodeWasix,
};
