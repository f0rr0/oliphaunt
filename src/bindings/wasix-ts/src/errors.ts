export type WasixStorageErrorCode =
  | 'busy'
  | 'checkpoint-failed'
  | 'corrupt'
  | 'incompatible'
  | 'unavailable';

/** What is known about the latest storage generation after an operation fails. */
export type WasixStorageDurability = 'not-persisted' | 'persisted' | 'unchanged' | 'unknown';

/**
 * A persistence or ownership failure, kept distinct from PostgreSQL's
 * `PostgresError`. `code` is suitable for branching; `durability` describes
 * only what is known about the stored generation. It does not by itself make
 * retrying an application transaction safe.
 */
export class WasixStorageError extends Error {
  readonly code: WasixStorageErrorCode;
  readonly durability: WasixStorageDurability;

  constructor(
    message: string,
    options: Readonly<{
      code: WasixStorageErrorCode;
      durability: WasixStorageDurability;
      cause?: unknown;
    }>,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WasixStorageError';
    this.code = options.code;
    this.durability = options.durability;
  }
}
