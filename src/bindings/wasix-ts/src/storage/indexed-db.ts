import { defineIndexedDbStorage, type WasixStorage } from '../storage.js';

/**
 * Select an origin-scoped persistent database.
 *
 * The current adapter checkpoints the complete PGDATA memory mount atomically
 * on `database.checkpoint()` and clean `database.close()`. It is not a direct
 * filesystem mount and does not claim per-transaction crash durability.
 */
export function indexedDB(name: string): WasixStorage {
  return defineIndexedDbStorage(name);
}

export default indexedDB;
