import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type AbortableOperationOptions,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult as KyselyQueryResult,
  type TransactionSettings,
} from "kysely";

import type { OliphauntDatabase, QueryParam } from "@oliphaunt/ts";

export class OliphauntDialect implements Dialect {
  constructor(private readonly db: OliphauntDatabase) {}

  createDriver(): Driver {
    return new OliphauntDriver(this.db);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

class OliphauntDriver implements Driver {
  private readonly connection: OliphauntConnection;

  constructor(db: OliphauntDatabase) {
    this.connection = new OliphauntConnection(db);
  }

  async init(_options?: AbortableOperationOptions): Promise<void> {}

  async acquireConnection(_options?: AbortableOperationOptions): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    let statement = "begin";
    if (settings.isolationLevel || settings.accessMode) {
      statement = "start transaction";
      if (settings.isolationLevel) statement += ` isolation level ${settings.isolationLevel}`;
      if (settings.accessMode) statement += ` ${settings.accessMode}`;
    }
    await connection.executeQuery(CompiledQuery.raw(statement));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(
    _connection: DatabaseConnection,
    _options?: AbortableOperationOptions,
  ): Promise<void> {}

  async destroy(_options?: AbortableOperationOptions): Promise<void> {}
}

class OliphauntConnection implements DatabaseConnection {
  constructor(private readonly db: OliphauntDatabase) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<KyselyQueryResult<R>> {
    const result = await this.db.query(
      compiledQuery.sql,
      compiledQuery.parameters.map(toQueryParam),
    );
    const rows = result.rows.map((_, rowIndex) => {
      const row: Record<string, string | null> = {};
      for (const field of result.fields) {
        row[field.name] = result.getText(rowIndex, field.name);
      }
      return row as R;
    });
    return {
      numAffectedRows: affectedRows(result.commandTag),
      rows,
    };
  }

  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
    _options?: AbortableOperationOptions,
  ): AsyncIterableIterator<KyselyQueryResult<R>> {
    throw new Error("Streaming is not supported by the Oliphaunt Kysely example dialect.");
  }
}

function toQueryParam(value: unknown): QueryParam {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  throw new Error(`unsupported Oliphaunt query parameter: ${typeof value}`);
}

function affectedRows(commandTag: string | undefined): bigint | undefined {
  if (!commandTag) return undefined;
  const command = commandTag.split(/\s+/, 1)[0];
  if (command !== "INSERT" && command !== "UPDATE" && command !== "DELETE" && command !== "MERGE") {
    return undefined;
  }
  const count = Number(commandTag.trim().split(/\s+/).at(-1));
  return Number.isFinite(count) ? BigInt(count) : undefined;
}
