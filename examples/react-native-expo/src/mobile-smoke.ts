import {
  PostgresError,
  type OliphauntDatabase,
  type QueryResult,
} from '@oliphaunt/react-native';

export type MobileReleaseExtensionProof = {
  readonly sqlName: string;
  readonly createsExtension: boolean;
  readonly selectedExtensionDependencies: readonly string[];
  readonly activationSql: readonly string[];
  readonly smokeStatements: readonly string[];
};

export type OperationCheck = {
  name: string;
  detail: string;
  elapsedMs: number;
};

export type CheckStage = {
  name: string;
  status: 'start' | 'done';
  detail?: string;
  elapsedMs?: number;
};

export type MobileReleaseExtensionProofResult = {
  readonly checks: OperationCheck[];
  readonly activatedExtensions: string[];
  readonly extensionCatalogComplete: boolean;
  readonly pgTextsearchEnglishBm25: boolean;
};

export async function runMobileBindingProof(
  db: OliphauntDatabase,
  onCheckStage?: (stage: CheckStage) => void,
): Promise<OperationCheck[]> {
  const checks: OperationCheck[] = [];

  await record(
    checks,
    'raw protocol response',
    async () => {
      const raw = await db.execProtocolRaw(simpleQuery('SELECT 1 AS raw_value; SELECT 2 AS raw_value'));
      assertPositiveInteger(raw.byteLength, 'raw protocol byte length');
      return `${raw.byteLength} raw bytes`;
    },
    onCheckStage,
  );

  await record(
    checks,
    'raw protocol stream',
    async () => {
      const autoExplainLogMinDuration = await scalar(
        db,
        "SELECT current_setting('auto_explain.log_min_duration')::text AS value",
      );
      await db.execute("SET auto_explain.log_min_duration = '-1'");
      try {
        const request = simpleQuery("SELECT repeat('x', 2048) FROM generate_series(1, 1024)");
        const expected = await db.execProtocolRaw(request);
        let chunkCount = 0;
        let callbackActive = false;
        const chunks: Uint8Array[] = [];
        await db.execProtocolStream(
          request,
          chunk => {
            if (callbackActive) {
              throw new Error('protocol stream callback was re-entered');
            }
            callbackActive = true;
            try {
              chunkCount += 1;
              chunks.push(chunk.slice());
            } finally {
              callbackActive = false;
            }
          },
        );
        if (chunkCount < 2) {
          throw new Error(`protocol stream expected multiple chunks, got ${chunkCount}`);
        }
        const streamed = concatenate(chunks);
        assertBytesEqual(streamed, expected, 'protocol stream complete response');
        assertReadyForQuery(streamed);

        const failure = new Error('mobile stream callback failure');
        let failureCallbackCount = 0;
        try {
          await db.execProtocolStream(
            simpleQuery("SELECT repeat('failure', 4096) FROM generate_series(1, 128)"),
            () => {
              failureCallbackCount += 1;
              throw failure;
            },
          );
          throw new Error('protocol stream unexpectedly ignored its callback failure');
        } catch (error) {
          if (error !== failure) {
            const detail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : `${typeof error}: ${String(error)}`;
            throw new Error(
              `protocol stream did not reject with the callback exception (received ${detail})`,
              { cause: error },
            );
          }
        }
        assertEqual(
          failureCallbackCount,
          1,
          'stream callback invocation count after failure',
        );
        assertEqual(
          await scalar(db, "SELECT 'after-stream-error'::text AS value"),
          'after-stream-error',
          'stream callback recovery query',
        );
        return `${chunkCount} acknowledged chunks, ${streamed.byteLength} complete raw bytes, callback exception preserved`;
      } finally {
        await db.query(
          "SELECT set_config('auto_explain.log_min_duration', $1, false) AS value",
          [autoExplainLogMinDuration],
        );
      }
    },
    onCheckStage,
  );

  await record(
    checks,
    'query cancellation and recovery',
    async () => {
      const running = db.query("SELECT pg_sleep(5), 'late'::text AS value");
      await sleep(120);
      await db.cancel();
      const sqlstate = await expectPostgresError(running, '57014');
      const recovered = await scalar(db, "SELECT 'after-cancel'::text AS value");
      assertEqual(recovered, 'after-cancel', 'cancel recovery query');
      return `cancelled with ${sqlstate}, then recovered`;
    },
    onCheckStage,
  );

  await record(
    checks,
    'checkpoint and physical backup',
    async () => {
      await db.checkpoint();
      const backup = await db.backup();
      assertPositiveInteger(backup.byteLength, 'physical backup bytes');
      return `${backup.byteLength} backup bytes`;
    },
    onCheckStage,
  );

  return checks;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${label}: expected ${expected.byteLength} bytes, got ${actual.byteLength}`);
  }
  for (let index = 0; index < actual.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      const start = Math.max(0, index - 8);
      const end = Math.min(actual.byteLength, index + 9);
      const hex = (bytes: Uint8Array) =>
        Array.from(bytes.subarray(start, end), byte => byte.toString(16).padStart(2, '0')).join(' ');
      throw new Error(
        `${label}: byte ${index} differs (actual ${actual[index]}, expected ${expected[index]}; actual ${hex(actual)}; expected ${hex(expected)})`,
      );
    }
  }
}

function assertReadyForQuery(response: Uint8Array): void {
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  let offset = 0;
  let finalTag = 0;
  let finalLength = 0;
  while (offset < response.byteLength) {
    if (response.byteLength - offset < 5) {
      throw new Error('protocol stream ended inside a message header');
    }
    finalTag = response[offset] ?? 0;
    finalLength = view.getUint32(offset + 1, false);
    if (finalLength < 4 || finalLength > response.byteLength - offset - 1) {
      throw new Error(`protocol stream contained invalid message length ${finalLength}`);
    }
    offset += 1 + finalLength;
  }
  if (finalTag !== 0x5a || finalLength !== 5) {
    throw new Error('protocol stream did not end with ReadyForQuery');
  }
}

async function provePgTextsearchEnglishSnowball(db: OliphauntDatabase): Promise<string> {
  const table = 'oliphaunt_mobile_pg_textsearch_english';
  const index = 'oliphaunt_mobile_pg_textsearch_english_bm25';
  await db.execute(`DROP TABLE IF EXISTS ${table}`);
  try {
    await executeStatements(db, [
      `CREATE TABLE ${table} (id bigint PRIMARY KEY, body text NOT NULL)`,
      `INSERT INTO ${table} (id, body) VALUES
        (1, 'PostgreSQL databases support reliable runners'),
        (2, 'An unrelated document about walking')`,
      `CREATE INDEX ${index}
        ON ${table}
        USING bm25 (body)
        WITH (text_config = 'pg_catalog.english')`,
    ]);
    const result = await db.query(
      `SELECT id::text AS id
       FROM ${table}
       ORDER BY body <@> to_bm25query('running database', '${index}')
       LIMIT 1`,
    );
    assertEqual(requiredText(result, 0, 'id'), '1', 'pg_textsearch English BM25 result');
    return 'nonempty English BM25 index returned the expected stemmed match';
  } finally {
    await db.execute(`DROP TABLE IF EXISTS ${table}`);
  }
}

export async function runMobileReleaseExtensionProof(
  db: OliphauntDatabase,
  plan: readonly MobileReleaseExtensionProof[],
  onCheckStage?: (stage: CheckStage) => void,
): Promise<MobileReleaseExtensionProofResult> {
  const checks: OperationCheck[] = [];
  const activatedExtensions: string[] = [];
  let pgTextsearchEnglishBm25 = false;
  for (const extension of plan) {
    await record(
      checks,
      `extension activation: ${extension.sqlName}`,
      async () => {
        for (const statement of extension.activationSql) {
          await db.execute(statement);
        }
        for (const statement of extension.smokeStatements) {
          // Canonical extension recipes intentionally mix DDL/DML with
          // row-producing SELECT/EXPLAIN statements. query() accepts both
          // response shapes, while execute() must reject returned rows.
          await db.query(statement);
        }
        if (extension.createsExtension) {
          const result = await db.query(
            `SELECT extname::text AS name, extversion::text AS version
             FROM pg_extension
             WHERE extname = $1`,
            [extension.sqlName],
          );
          assertEqual(requiredText(result, 0, 'name'), extension.sqlName, `${extension.sqlName} catalog identity`);
          const version = requiredText(result, 0, 'version');
          if (version.trim().length === 0) {
            throw new Error(`${extension.sqlName} catalog version is empty`);
          }
          return `${extension.sqlName} ${version}; dependency closure ${extension.selectedExtensionDependencies.join(',') || 'none'}`;
        }

        const configured = await scalar(
          db,
          "SELECT current_setting('auto_explain.log_min_duration')::text AS value",
        );
        assertEqual(configured, '0', 'auto_explain load/configuration proof');
        return 'auto_explain loaded and configured in the installed app session';
      },
      onCheckStage,
    );
    activatedExtensions.push(extension.sqlName);
    if (extension.sqlName === 'pg_textsearch') {
      await record(
        checks,
        'extension functional proof: pg_textsearch English BM25',
        () => provePgTextsearchEnglishSnowball(db),
        onCheckStage,
      );
      pgTextsearchEnglishBm25 = true;
    }
  }

  await record(
    checks,
    'extension activation catalog completeness',
    async () => {
      const expected = plan
        .filter(extension => extension.createsExtension)
        .map(extension => extension.sqlName)
        .sort()
        .join(',');
      const actual = await scalar(
        db,
        `SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '')::text AS value
         FROM pg_extension
         WHERE extname <> 'plpgsql'`,
      );
      assertEqual(actual, expected, 'installed mobile extension catalog');
      return `${plan.length} release extensions activated`;
    },
    onCheckStage,
  );

  return {
    checks,
    activatedExtensions,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25,
  };
}

export async function runPostgresLifecycleResumeCheck(
  db: OliphauntDatabase,
): Promise<OperationCheck> {
  const started = now();
  const select = await scalar(db, 'SELECT 1::text AS value');
  assertEqual(select, '1', 'resume SELECT 1');
  await db.execute('DROP TABLE IF EXISTS oliphaunt_mobile_resume_probe');
  await db.execute('CREATE TABLE oliphaunt_mobile_resume_probe(id integer PRIMARY KEY, value text NOT NULL)');
  await db.execute("INSERT INTO oliphaunt_mobile_resume_probe VALUES (1, 'resumed')");
  const value = await scalar(
    db,
    'SELECT value::text FROM oliphaunt_mobile_resume_probe WHERE id = 1',
  );
  await db.execute('DROP TABLE oliphaunt_mobile_resume_probe');
  assertEqual(value, 'resumed', 'resume write/read');
  return {
    name: 'background/foreground resume SQL',
    detail: `SELECT ${select}; write/read ${value}`,
    elapsedMs: now() - started,
  };
}

async function executeStatements(
  db: Pick<OliphauntDatabase, 'execute'>,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await db.execute(statement);
  }
}

async function scalar(db: OliphauntDatabase, sql: string): Promise<string> {
  const result = await db.query(sql);
  return requiredText(result, 0, 'value');
}

async function record(
  checks: OperationCheck[],
  name: string,
  run: () => Promise<string>,
  onStage?: (stage: CheckStage) => void,
): Promise<void> {
  const started = now();
  onStage?.({ name, status: 'start' });
  const detail = await run();
  const elapsedMs = now() - started;
  onStage?.({ name, status: 'done', detail, elapsedMs });
  checks.push({ name, detail, elapsedMs });
}

async function expectPostgresError(
  promise: Promise<unknown>,
  sqlstate: string,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PostgresError) {
      assertEqual(error.sqlstate ?? '', sqlstate, 'PostgreSQL SQLSTATE');
      return error.sqlstate ?? '';
    }
    throw error;
  }
  throw new Error(`expected PostgreSQL error ${sqlstate}`);
}

function requiredText(result: QueryResult, row: number, column: string): string {
  const value = result.getText(row, column);
  if (value == null) {
    throw new Error(`query result missing ${column} at row ${row}`);
  }
  return value;
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}: expected positive integer, got ${value}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function simpleQuery(sql: string): Uint8Array {
  const payload = new TextEncoder().encode(`${sql}\0`);
  const request = new Uint8Array(1 + 4 + payload.byteLength);
  request[0] = 'Q'.charCodeAt(0);
  new DataView(request.buffer).setUint32(1, 4 + payload.byteLength, false);
  request.set(payload, 5);
  return request;
}
