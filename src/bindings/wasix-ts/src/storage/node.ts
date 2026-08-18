import { fileURLToPath } from 'node:url';

import { defineDirectoryStorage, type WasixStorage } from '../storage.js';

/**
 * Persist PGDATA below a Node.js host directory.
 *
 * The selected path is PGDATA itself. The adapter publishes only the paths
 * mutated by PostgreSQL at every completed operation boundary and uses WAL-
 * first durable host writes. Network and cross-host shared filesystems are
 * unsupported.
 */
export function directory(path: string | URL): WasixStorage {
  return defineDirectoryStorage(typeof path === 'string' ? path : fileURLToPath(path));
}

export default directory;
