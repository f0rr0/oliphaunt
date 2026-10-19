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
}

/** Run standard pg_dump plain output against a PostgreSQL connection string. */
export function pgDump(connectionString: string, options?: PgDumpOptions): Promise<string>;

/** Run non-interactive psql against a PostgreSQL connection string. */
export function psql(connectionString: string, options?: PsqlOptions): Promise<string>;
