export type WasixStorageErrorCode =
  | 'busy'
  | 'corrupt'
  | 'incomplete'
  | 'incompatible'
  | 'publication-failed'
  | 'unavailable';

/** What is known about the latest storage generation after an operation fails. */
export type WasixStorageCommitState = 'not-persisted' | 'persisted' | 'unchanged' | 'unknown';

/**
 * A persistence or ownership failure, kept distinct from PostgreSQL's
 * `PostgresError`. `code` is suitable for branching; `commitState` describes
 * only what is known about the stored generation. It does not by itself make
 * retrying an application transaction safe.
 */
export class WasixStorageError extends Error {
  readonly code: WasixStorageErrorCode;
  readonly commitState: WasixStorageCommitState;

  constructor(
    message: string,
    options: Readonly<{
      code: WasixStorageErrorCode;
      commitState: WasixStorageCommitState;
      cause?: unknown;
    }>,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WasixStorageError';
    this.code = options.code;
    this.commitState = options.commitState;
  }
}

/** @internal Preserve storage classification while retaining cleanup diagnostics. */
export function composeWasixStorageFailure(
  primary: Error,
  label: string,
  secondary: unknown,
): Error {
  const detail = secondary instanceof Error ? secondary.message : String(secondary);
  const message = `${primary.message}; ${label}: ${detail}`;
  const cause = new AggregateError([primary, secondary], label);
  if (primary instanceof WasixStorageError) {
    return new WasixStorageError(message, {
      code: primary.code,
      commitState: primary.commitState,
      cause,
    });
  }
  return new Error(message, { cause });
}
