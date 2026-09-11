import type { DatabaseStorage } from './client';

/**
 * Persist a database in a native directory. Accepts a filesystem path or the
 * local file URI returned by a mobile filesystem API; performs no file IO.
 */
export function directory(location: string): Extract<DatabaseStorage, { kind: 'directory' }> {
  let path = location;
  if (/^file:/i.test(location)) {
    const url = new URL(location);
    if (url.hostname !== '' && url.hostname !== 'localhost') {
      throw new TypeError('database storage directory must be a local file URI');
    }
    if (url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
      throw new TypeError(
        'database storage file URI must not contain a query, fragment, or encoded separator',
      );
    }
    path = decodeURIComponent(url.pathname);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
    throw new TypeError('database storage directory must be a filesystem path or local file URI');
  }
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new TypeError(
      'database storage directory must be an absolute native path without NUL bytes',
    );
  }
  return Object.freeze({ kind: 'directory', path });
}

export default directory;
