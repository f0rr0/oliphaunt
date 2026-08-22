type QueryResult = {
  fields: Array<{ name: string; typeOid: number; format: unknown }>;
  rows: unknown[];
  commandTag?: string;
  rowCount: number | null;
  getText(row: number, column: string): string | null;
};

type PostgresError = Error & {
  severity?: string;
  sqlstate?: string;
  postgresMessage: string;
};

export function assertSharedProtocolFixtures(options: {
  parseQueryResponse(bytes: Uint8Array): QueryResult;
  isPostgresError(error: unknown): error is PostgresError;
}): void;
