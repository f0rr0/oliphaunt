import { normalizeFilePath } from './config.js';
import type { DirectoryStorage } from './types.js';

/** A managed database directory, shared by open and restore. */
export function directory(path: string | URL): DirectoryStorage & { readonly path: string } {
  const value = normalizeFilePath(path, 'database storage directory');
  return Object.freeze({ kind: 'directory', path: value });
}

export default directory;
