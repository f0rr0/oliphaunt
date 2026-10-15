export type PgDumpOptions = Readonly<{
  /** Ordinary PostgreSQL pg_dump arguments. Connection, file input/output, format, compression, encoding, and job flags are managed. */
  args?: readonly string[];
}>;

export type PsqlOptions = Readonly<{
  /** Ordinary PostgreSQL psql arguments. Connection, input, and output flags are managed. */
  args?: readonly string[];
  command?: string;
  script?: string;
}>;

export class PostgresToolError extends Error {
  readonly tool: 'pg_dump' | 'psql';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export type PostgresToolSummary = Readonly<{
  stdoutBytes: number;
  /** Latest 8 KiB of diagnostics, decoded lossily as UTF-8. */
  stderr: string;
  stderrTruncated: boolean;
}>;

export type PostgresToolOutputOptions = Readonly<{
  /** Stop the owned frontend process. No SQL retry or rollback is implied. */
  signal?: AbortSignal;
  /** Optional complete diagnostic destination, drained alongside stdout. */
  stderr?: WritableStream<Uint8Array>;
}>;

/** Run standard pg_dump plain output against a PostgreSQL connection string. */
export function pgDump(connectionString: string, options?: PgDumpOptions): Promise<string>;

/** Run non-interactive psql against a PostgreSQL connection string. */
export function psql(connectionString: string, options?: PsqlOptions): Promise<string>;

/** Write exact stdout bytes with backpressure. The caller owns closing both streams. */
export function pgDumpToStream(
  connectionString: string,
  destination: WritableStream<Uint8Array>,
  options?: PgDumpOptions & PostgresToolOutputOptions,
): Promise<PostgresToolSummary>;
export function psqlToStream(
  connectionString: string,
  destination: WritableStream<Uint8Array>,
  options?: PsqlOptions & PostgresToolOutputOptions,
): Promise<PostgresToolSummary>;

/** Stage a private host file and publish it create-only after successful tool completion and close. */
export function pgDumpToFile(
  connectionString: string,
  destination: string,
  options?: PgDumpOptions & PostgresToolOutputOptions,
): Promise<PostgresToolSummary>;
export function psqlToFile(
  connectionString: string,
  destination: string,
  options?: PsqlOptions & PostgresToolOutputOptions,
): Promise<PostgresToolSummary>;
