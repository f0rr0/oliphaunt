import {
  composeWasixStorageFailure,
  WasixStorageError,
  type WasixStorageCommitState,
} from '../errors.js';
import type { ExclusiveStorageLock } from './incremental-storage.js';

/** Preserve a restore failure while making ownership-release failure observable. */
export async function releaseRestoreLock(
  lock: ExclusiveStorageLock,
  label: string,
  commitState: WasixStorageCommitState,
  primary: unknown,
): Promise<unknown> {
  try {
    await lock.release();
    return primary;
  } catch (error) {
    const release = new WasixStorageError(`${label} ownership lock could not be released`, {
      code: 'unavailable',
      commitState,
      cause: error,
    });
    if (primary instanceof Error) {
      return composeWasixStorageFailure(primary, 'ownership release also failed', release);
    }
    if (primary !== undefined) {
      return new AggregateError([primary, release], `${label} ownership release also failed`);
    }
    return release;
  }
}
