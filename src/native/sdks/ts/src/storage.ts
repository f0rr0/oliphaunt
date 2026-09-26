import { fileURLToPath } from 'node:url';
import { validateDirectoryPath } from './config.js';
import type { DirectoryStorage } from './types.js';

/** A managed database directory, shared by open and restore. */
export function directory(path: string | URL): DirectoryStorage {
  const value = typeof path === 'string' ? path : fileURLToPath(path);
  validateDirectoryPath(value, 'database storage directory');
  return Object.freeze({ kind: 'directory', path: value });
}

export default directory;
