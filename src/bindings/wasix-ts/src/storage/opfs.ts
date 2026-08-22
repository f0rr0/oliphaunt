import { defineOpfsStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Select an origin-private persistent database. Each completed protocol
 * operation publishes only journaled PGDATA paths before it resolves.
 */
export function opfs(name: string): PersistentWasixStorage {
  return defineOpfsStorage(name);
}

export default opfs;
