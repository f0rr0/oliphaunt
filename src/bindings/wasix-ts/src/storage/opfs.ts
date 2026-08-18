import { defineOpfsStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Select an origin-private opaque database pool. Worker execution uses
 * same-realm synchronous exact-range I/O; other placements publish to the
 * same format through the portable journaled path.
 */
export function opfs(name: string): PersistentWasixStorage {
  return defineOpfsStorage(name);
}

export default opfs;
