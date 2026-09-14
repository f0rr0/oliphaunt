import { fileURLToPath } from 'node:url';

import { defineDirectoryStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Persist a managed database below a Node.js host directory.
 *
 * Rust opens the selected managed root directly, owns its OS advisory lock,
 * and performs PostgreSQL-safe durable writes at each native operation
 * boundary. Network and cross-host shared filesystems are unsupported.
 */
export function directory(path: string | URL): PersistentWasixStorage {
  return defineDirectoryStorage(typeof path === 'string' ? path : fileURLToPath(path));
}

export default directory;
