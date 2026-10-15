import { defineOpfsStorage, type PersistentWasixStorage } from './types.js';

/**
 * Select an origin-private database pool that publishes changed files with
 * copy-on-write backings and commits its namespace last.
 */
export function opfs(name: string): PersistentWasixStorage<'opfs'> {
  return defineOpfsStorage(name);
}

export default opfs;
