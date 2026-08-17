import {
  PostgresError,
  simpleQuery,
  type MobileReleaseExtensionProof,
  type OliphauntDatabase,
  type QueryResult,
} from '@oliphaunt/react-native';

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
    'raw protocol and streaming response',
    async () => {
      const raw = await db.execProtocolRaw(simpleQuery('SELECT 1 AS raw_value; SELECT 2 AS raw_value'));
      let streamBytes = 0;
      let chunks = 0;
      await db.execProtocolStream(
        simpleQuery("SELECT repeat('x', 65536) AS payload"),
        chunk => {
          chunks += 1;
          streamBytes += chunk.byteLength;
        },
      );
      assertPositiveInteger(raw.byteLength, 'raw protocol byte length');
      assertPositiveInteger(streamBytes, 'streaming byte length');
      return `${raw.byteLength} raw bytes, ${streamBytes} streamed bytes in ${chunks} chunk(s)`;
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
      const backup = await db.backup('physicalArchive');
      assertPositiveInteger(backup.bytes.byteLength, 'physical backup bytes');
      return `${backup.bytes.byteLength} backup bytes`;
    },
    onCheckStage,
  );

  return checks;
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
