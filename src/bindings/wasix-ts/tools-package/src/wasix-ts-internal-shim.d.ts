import type { OliphauntDatabase } from '@oliphaunt/wasix-ts';

export type WasixToolProcessResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export function getWasixDatabaseIdentity(database: OliphauntDatabase): Readonly<{
  username: string;
  database: string;
}>;

export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: Readonly<{
    runtimeVersion: string;
    tool: Readonly<{
      name: 'pg_dump' | 'psql';
      sha256: string;
      size: number;
      source: string | Uint8Array;
    }>;
    args: readonly string[];
    stdin?: Uint8Array;
  }>,
): Promise<WasixToolProcessResult>;
