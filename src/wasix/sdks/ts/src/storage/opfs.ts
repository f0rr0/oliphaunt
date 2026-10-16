import { defineOpfsStorage, type OpfsOptions, type PersistentWasixStorage } from './types.js';
export type { OpfsOptions } from './types.js';

/**
 * Select an origin-private database. Workers use direct file I/O with a
 * synchronous recovery journal; other placements use portable publication.
 */
export function opfs(name: string, options: OpfsOptions = {}): PersistentWasixStorage<'opfs'> {
  return defineOpfsStorage(name, options);
}

export default opfs;
