import { defineOpfsStorage, type WasixStorage } from '../storage.js';

/**
 * Select an origin-private opaque database pool. Worker execution uses
 * same-realm synchronous exact-range I/O; other environments publish to the
 * same format through the portable incremental path.
 */
export function opfs(name: string): WasixStorage {
  return defineOpfsStorage(name);
}

export default opfs;
