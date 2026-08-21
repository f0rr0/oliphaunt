import { WasixStorageError } from '../errors.js';
import type { ExclusiveStorageLock } from './incremental-storage.js';

type WebLockManager = {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T> | T,
  ): Promise<T>;
};

export async function acquireExclusiveWebLock(
  lockName: string,
  label: string,
): Promise<ExclusiveStorageLock> {
  const locks = (
    globalThis.navigator as typeof globalThis.navigator & {
      locks?: WebLockManager;
    }
  ).locks;
  if (locks === undefined) {
    throw new WasixStorageError(`${label} requires the browser Web Locks API`, {
      code: 'unavailable',
      commitState: 'unchanged',
    });
  }

  let releaseHold: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let acquisitionSettled = false;
  let resolveAcquisition: ((acquired: boolean) => void) | undefined;
  let rejectAcquisition: ((error: unknown) => void) | undefined;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquisition = resolve;
    rejectAcquisition = reject;
  });
  const request = locks
    .request(lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      acquisitionSettled = true;
      if (lock === null) {
        resolveAcquisition?.(false);
        return;
      }
      resolveAcquisition?.(true);
      await hold;
    })
    .catch((error) => {
      if (!acquisitionSettled) rejectAcquisition?.(error);
      throw error;
    });

  let available: boolean;
  try {
    available = await acquired;
  } catch (error) {
    void request.catch(() => undefined);
    throw new WasixStorageError(
      `could not acquire ownership of ${label}: ${describeError(error)}`,
      { code: 'unavailable', commitState: 'unchanged', cause: error },
    );
  }
  if (!available) {
    await request;
    throw new WasixStorageError(`${label} is already open in this origin`, {
      code: 'busy',
      commitState: 'unchanged',
    });
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      releaseHold?.();
      await request;
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
