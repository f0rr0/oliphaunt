import { fileURLToPath } from 'node:url';

import { validateDirectoryPath } from '../config.js';
import type { RestoreDestination } from '../types.js';

/** Persist a database in a host directory. Oliphaunt creates it when opened. */
export function directory(path: string | URL): RestoreDestination {
  const location = typeof path === 'string' ? path : fileURLToPath(path);
  validateDirectoryPath(location, 'database storage directory');
  return Object.freeze({ kind: 'directory', path: location });
}

export default directory;
