import { open } from 'node:fs/promises';

/**
 * Persist a directory-entry change with PostgreSQL-like error semantics.
 * Windows cannot always open directories through Node; other hosts must not
 * silently downgrade a real fsync failure.
 */
export async function syncNodeDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const unsupportedWindowsDirectorySync =
      process.platform === 'win32' &&
      ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].some((code) => isNodeError(error, code));
    if (!unsupportedWindowsDirectorySync) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
