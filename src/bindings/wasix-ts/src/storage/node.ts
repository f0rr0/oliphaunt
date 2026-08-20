import { fileURLToPath } from 'node:url';

import { defineDirectoryStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Persist a managed database below a Node.js host directory.
 *
 * The selected path contains Oliphaunt metadata and a `pgdata` child. The
 * adapter publishes only paths mutated by PostgreSQL at every completed
 * operation boundary and uses WAL-first durable host writes. Network and
 * cross-host shared filesystems are unsupported.
 */
export function directory(path: string | URL): PersistentWasixStorage {
  return defineDirectoryStorage(typeof path === 'string' ? path : fileURLToPath(path));
}

export default directory;
