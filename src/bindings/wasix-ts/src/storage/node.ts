import { fileURLToPath } from 'node:url';

import { defineNodeDirectoryStorage, type WasixStorage } from '../storage.js';

/**
 * Persist PGDATA below a Node.js host directory.
 *
 * The adapter hydrates a Wasmer memory filesystem when opening and atomically
 * publishes a complete generation on `checkpoint()` and clean `close()`. It is
 * snapshot persistence for local filesystems opened from Node's main thread,
 * not a direct or per-query host-filesystem mount. Network and cross-host
 * shared filesystems are unsupported.
 */
export function directory(path: string | URL): WasixStorage {
  return defineNodeDirectoryStorage(typeof path === 'string' ? path : fileURLToPath(path));
}

export default directory;
