import { defineIndexedDbStorage, type WasixStorage } from '../storage.js';

/**
 * Select an origin-scoped persistent database.
 *
 * Every completed protocol operation commits only journaled PGDATA path
 * changes in one strict IndexedDB transaction before its Promise resolves.
 * `database.checkpoint()` additionally runs PostgreSQL `CHECKPOINT` first.
 */
export function indexedDB(name: string): WasixStorage {
  return defineIndexedDbStorage(name);
}

export default indexedDB;
