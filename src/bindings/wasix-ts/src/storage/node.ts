import { fileURLToPath } from 'node:url';

import { defineDirectoryStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Persist a managed database below a Node.js host directory.
 *
 * The selected path is a trusted, exclusively owned local root containing
 * Oliphaunt metadata and a real `pgdata` child. PostgreSQL operates directly
 * on that PGDATA; completed boundaries fsync dirty files and affected
 * directories in WAL/data/control order. The descriptor and physical-restore
 * formats are unchanged. Network and cross-host shared filesystems are
 * unsupported.
 */
export function directory(path: string | URL): PersistentWasixStorage {
  return defineDirectoryStorage(typeof path === 'string' ? path : fileURLToPath(path));
}

export default directory;
