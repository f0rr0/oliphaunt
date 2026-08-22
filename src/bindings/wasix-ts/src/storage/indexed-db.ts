import { defineIndexedDbStorage, type PersistentWasixStorage } from '../storage.js';

/**
 * Select an origin-scoped persistent database.
 *
 * Every completed protocol operation commits only journaled PGDATA path
 * changes in one atomic read-write IndexedDB transaction before its Promise resolves.
 * `database.checkpoint()` additionally runs PostgreSQL `CHECKPOINT` first.
 */
export function indexedDB(name: string): PersistentWasixStorage {
  return defineIndexedDbStorage(name);
}

export default indexedDB;
