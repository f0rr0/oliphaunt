import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Keep the archive callback synchronous, including Deno's borrowed FFI callback. */
export async function writeArchiveFile(
  destination: string,
  backup: (onChunk: (chunk: Uint8Array) => void) => Promise<void>,
): Promise<void> {
  const staging = join(dirname(destination), `.oliphaunt-backup-${randomUUID()}`);
  const file = await open(staging, 'wx', 0o600);
  let closed = false;
  let published = false;
  let failure: { error: unknown } | undefined;
  try {
    await backup((chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(file.fd, chunk, offset, chunk.length - offset);
        if (written === 0) throw new Error('backup file write made no progress');
        offset += written;
      }
    });
    await file.close();
    closed = true;
    await link(staging, destination);
    published = true;
  } catch (error) {
    failure = { error };
  }
  const cleanup: unknown[] = [];
  if (!closed) {
    try {
      await file.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    await unlink(staging);
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length !== 0) {
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...cleanup],
      published
        ? `backup was published to ${destination}; staging cleanup failed`
        : 'backup staging cleanup failed',
    );
  }
  if (failure !== undefined) throw failure.error;
}
