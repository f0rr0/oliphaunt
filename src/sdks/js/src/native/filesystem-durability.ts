import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);

export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

export async function syncDirectoryTree(root: string): Promise<void> {
  await syncTree(root, false);
}

/** Flush a staged runtime tree without following packaged symbolic links. */
export async function syncRuntimeDirectoryTree(root: string): Promise<void> {
  await syncTree(root, true);
}

async function syncTree(root: string, allowSymlinks: boolean): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`durable publication root ${root} must be a real directory`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const file = join(root, entry.name);
    const entryMetadata = await lstat(file);
    if (entryMetadata.isSymbolicLink()) {
      if (!allowSymlinks) {
        throw new Error(`durable publication tree contains a symbolic link: ${file}`);
      }
      await readlink(file);
    } else if (entryMetadata.isDirectory()) {
      await syncTree(file, allowSymlinks);
    } else if (entryMetadata.isFile()) {
      const handle = await open(file, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error(`durable publication tree contains a special file: ${file}`);
    }
  }
  await syncDirectory(root);
}
