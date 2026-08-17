import { defineOpfsStorage, type WasixStorage } from '../storage.js';

/**
 * Select an origin-private filesystem PGDATA directory. Each completed
 * protocol operation publishes only journaled paths before it resolves.
 */
export function opfs(name: string): WasixStorage {
  return defineOpfsStorage(name);
}

export default opfs;
