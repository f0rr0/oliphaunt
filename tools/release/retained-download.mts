import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function createRetainedDownload(destination: string) {
  const absolute = path.resolve(destination);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.lstat(absolute);
    throw new Error(`refusing to replace existing retained download ${absolute}`);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = await fs.open(temporary, 'wx', 0o600);
  let committed = false;
  let published: { dev: number; ino: number } | null = null;
  const close = async () => {
    if (handle === null) return;
    const owned = handle;
    handle = null;
    await owned.close();
  };
  return {
    async write(bytes: Uint8Array) {
      if (handle === null) throw new Error('retained download is already closed');
      await handle.writeFile(bytes);
    },
    async commit() {
      if (handle === null) throw new Error('retained download is already closed');
      const ownership = await handle.stat();
      await handle.chmod(0o444);
      await close();
      await fs.link(temporary, absolute);
      published = ownership;
      await fs.unlink(temporary);
      committed = true;
      return absolute;
    },
    async abort() {
      if (committed) return;
      try {
        await close();
      } finally {
        try {
          if (published !== null) {
            const stat = await fs.lstat(absolute).catch((cause) => {
              if (cause?.code !== 'ENOENT') throw cause;
              return null;
            });
            if (stat?.dev === published.dev && stat?.ino === published.ino) {
              await fs.unlink(absolute);
            }
          }
        } finally {
          await fs.unlink(temporary).catch((cause) => {
            if (cause?.code !== 'ENOENT') throw cause;
          });
        }
      }
    },
  };
}
