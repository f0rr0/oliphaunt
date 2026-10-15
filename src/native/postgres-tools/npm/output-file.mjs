import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import path from 'node:path';

// The destination stays create-only, even if another writer publishes first.
export async function writeNewFile(destination, write) {
  if (destination instanceof URL) destination = fileURLToPath(destination);
  if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
    throw new TypeError('output destination must be a non-empty host path without NUL bytes');
  }
  const staging = path.join(path.dirname(destination), `.oliphaunt-tool-${randomUUID()}`);
  const file = await open(staging, 'wx', 0o600);
  let closed = false;
  let published = false;
  let result;
  let failure;
  try {
    result = await write(
      new WritableStream({
        async write(chunk) {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
            if (bytesWritten === 0) throw new Error('output file write made no progress');
            offset += bytesWritten;
          }
        },
      }),
    );
    await file.close();
    closed = true;
    await link(staging, destination);
    published = true;
  } catch (cause) {
    failure = { cause };
  }
  const cleanup = [];
  if (!closed) {
    try {
      await file.close();
    } catch (cause) {
      cleanup.push(cause);
    }
  }
  try {
    await unlink(staging);
  } catch (cause) {
    cleanup.push(cause);
  }
  if (cleanup.length !== 0) {
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.cause]), ...cleanup],
      published
        ? `output was published to ${destination}; staging cleanup failed`
        : 'output staging cleanup failed',
    );
  }
  if (failure !== undefined) throw failure.cause;
  return result;
}
