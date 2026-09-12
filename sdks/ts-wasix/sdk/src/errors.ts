export type WasixStorageErrorCode =
  | 'busy'
  | 'corrupt'
  | 'incomplete'
  | 'incompatible'
  | 'publication-failed'
  | 'unavailable';

/** What is known about the latest storage generation after an operation fails. */
export type WasixStorageCommitState = 'not-persisted' | 'persisted' | 'unchanged' | 'unknown';

/** Native persistence boundary at which a storage failure was observed. */
export type WasixStoragePhase =
  | 'ownership'
  | 'open'
  | 'open-publication'
  | 'operation'
  | 'backup'
  | 'close'
  | 'restore-validation'
  | 'restore-staging'
  | 'restore-publication'
  | 'restore-durability';

/**
 * A persistence or ownership failure, kept distinct from PostgreSQL's
 * `PostgresError`. `code` is suitable for branching, `phase` identifies the
 * native persistence boundary, and `commitState` describes only what is known
 * about the stored generation. None of these fields by itself makes retrying
 * an application transaction safe.
 */
export class WasixStorageError extends Error {
  readonly code: WasixStorageErrorCode;
  readonly commitState: WasixStorageCommitState;
  readonly phase: WasixStoragePhase | undefined;

  constructor(
    message: string,
    options: Readonly<{
      code: WasixStorageErrorCode;
      commitState: WasixStorageCommitState;
      phase?: WasixStoragePhase;
      cause?: unknown;
    }>,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WasixStorageError';
    this.code = options.code;
    this.commitState = options.commitState;
    this.phase = options.phase;
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
      ...(primary.phase === undefined ? {} : { phase: primary.phase }),
      cause,
    });
  }
  return new Error(message, { cause });
}
