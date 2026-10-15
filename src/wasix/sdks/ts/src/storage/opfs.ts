import { defineOpfsStorage, type OpfsOptions, type PersistentWasixStorage } from './types.js';
export type { OpfsOptions } from './types.js';

/**
 * Select an origin-private database pool that publishes changed files with
 * copy-on-write backings and commits its namespace last.
 */
export function opfs(name: string, options: OpfsOptions = {}): PersistentWasixStorage<'opfs'> {
  return defineOpfsStorage(name, options);
}

export default opfs;
