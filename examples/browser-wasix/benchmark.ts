import { PGlite } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import Oliphaunt from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';

type QueryParameters = readonly (null | string | number | boolean)[];

type BenchDatabase = {
  postgres: PostgresProfile;
  query(sql: string, parameters?: QueryParameters): Promise<unknown>;
  scalar(sql: string): Promise<string>;
  transaction<T>(body: (transaction: Pick<BenchDatabase, 'query'>) => Promise<T>): Promise<T>;
  consume(result: unknown): number;
  close(): Promise<void>;
};

type OpenResult = {
  database: BenchDatabase;
  readyMs: number;
};

type Engine = {
  name: 'wasixDirect' | 'wasixWorker' | 'pgliteDirect' | 'pgliteWorker';
  open(): Promise<OpenResult>;
};

type PostgresProfile = {
  version: string;
  fsync: string;
  walSyncMethod: string;
  sharedBuffers: string;
  walBuffers: string;
  synchronousCommit: string;
  fullPageWrites: string;
  walLevel: string;
};

const workloadMetrics = [
  'readyMs',
  'createTableMs',
  'insert10kMs',
  'pointMedianMs',
  'pointP95Ms',
  'range100MedianMs',
  'range100P95Ms',
  'aggregateMedianMs',
  'aggregateP95Ms',
  'scanAndDecode10kMs',
  'transactionInsertBatchMs',
  'update1kMs',
  'delete1kMs',
  'closeMs',
] as const;
type WorkloadMetric = (typeof workloadMetrics)[number];
type WorkloadRun = {
  postgres: PostgresProfile;
  metrics: Record<WorkloadMetric, number>;
  observations: {
    pointMs: number[];
    range100Ms: number[];
    aggregateMs: number[];
  };
};

type InsertDiagnostic = {
  postgres: PostgresProfile;
  expressionOnlyMs: number;
  heapInsert10kMs: number;
  indexedInsert10kMs: number;
  indexedInsertServerMs: number;
  indexedInsertWalBytes: number;
};

const insertDiagnosticMetrics = [
  'expressionOnlyMs',
  'heapInsert10kMs',
  'indexedInsert10kMs',
  'indexedInsertServerMs',
  'indexedInsertWalBytes',
] as const;
type InsertDiagnosticMetric = (typeof insertDiagnosticMetrics)[number];
type InsertDiagnosticSummary = Record<InsertDiagnosticMetric, Record<Engine['name'], number>>;

type PGliteAssets = {
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
};

const durablePGliteStartParams = [
  '--single',
  '-O',
  '-j',
  '-c',
  'search_path=public',
  '-c',
  'exit_on_error=false',
  '-c',
  'log_checkpoints=false',
  '-c',
  'wal_buffers=4MB',
  '-c',
  'min_wal_size=80MB',
  '-c',
  'shared_buffers=128MB',
  '-c',
  'max_wal_senders=0',
  '-c',
  'max_worker_processes=0',
  '-c',
  'max_parallel_workers=0',
  '-c',
  'max_parallel_workers_per_gather=0',
  '-c',
  'io_method=sync',
  '-c',
  'wal_sync_method=fdatasync',
  '-c',
  'max_parallel_maintenance_workers=0',
] as const;

const status = requireElement<HTMLParagraphElement>('status');
const output = requireElement<HTMLPreElement>('output');
const quick = new URL(location.href).searchParams.has('quick');
const persistentWorkerStorage = new URL(location.href).searchParams.has('opfs');
const persistentRun = crypto.randomUUID();
let persistentDatabase = 0;
const startupRuns = quick ? 2 : 5;
const workloadRuns = quick ? 1 : 8;
const insertDiagnosticRuns = quick ? 1 : 5;
const pointSamples = quick ? 20 : 200;
const rangeSamples = quick ? 10 : 50;
const aggregateSamples = quick ? 5 : 30;
const transactionInserts = quick ? 20 : 100;
let pgliteAssetsPromise: Promise<PGliteAssets> | undefined;

const engines: Engine[] = [
  { name: 'wasixDirect', open: () => openWasix('direct') },
  { name: 'wasixWorker', open: () => openWasix('worker') },
  { name: 'pgliteDirect', open: openPGliteDirect },
  { name: 'pgliteWorker', open: openPGliteWorker },
];
const oliphauntExecutionSurfaces = {
  direct: {
    entrypoint: '@oliphaunt/wasix-ts',
    callingContract: 'async',
    executionOwner: 'caller',
  },
  worker: {
    entrypoint: '@oliphaunt/wasix-ts/worker',
    callingContract: 'async',
    executionOwner: 'sdk-worker',
  },
} as const;
type OliphauntExecutionSurface = keyof typeof oliphauntExecutionSurfaces;

document.documentElement.dataset.oliphauntSmoke = 'running';
status.textContent = 'Running caller-owned and Worker-owned browser benchmarks…';

try {
  const startup = await measureStartup();
  const workload = await measureWorkloads();
  const insertDiagnostic = await measureInsertDiagnostics();
  const summary = summarizeResults(startup, workload);
  const insertSummary = summarizeInsertDiagnostics(insertDiagnostic);
  const postgresProfiles = representativePostgresProfiles(workload);
  const result = {
    schema: 'oliphaunt-wasix-browser-engine-result-v2',
    plan: 'browser-pglite-memory-v2',
    mode: quick ? 'quick' : 'full',
    benchmark: 'oliphaunt-wasix-vs-pglite-v4',
    measuredAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: globalThis.crossOriginIsolated,
    },
    configuration: {
      executionSurfaces: oliphauntExecutionSurfaces,
      coldStartupComparable: false,
      coldStartupNote:
        'firstReady samples are descriptive because each implementation caches compiled assets differently',
      storage: persistentWorkerStorage ? 'worker-opfs/direct-memory' : 'ephemeral-memory',
      workloadProfile: 'fresh database after one untimed representative warmup',
      startupRuns,
      workloadRuns,
      insertDiagnosticRuns,
      rows: 10_000,
      pointSamples,
      rangeSamples,
      aggregateSamples,
      transactionInserts,
    },
    postgresProfiles,
    summary,
    insertDiagnostic: {
      summary: insertSummary,
      samples: insertDiagnostic,
    },
    correctness: { assertionsPassed: true },
    samples: { startup, workload },
  };

  output.textContent = JSON.stringify(result);
  status.textContent = 'Benchmark completed; the runner is qualifying and writing the report.';
  document.documentElement.dataset.oliphauntSmoke = 'passed';
} catch (error) {
  const phase = status.textContent;
  output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  status.textContent = phase ? `Benchmark failed during ${phase}.` : 'Benchmark failed.';
  document.documentElement.dataset.oliphauntSmoke = 'failed';
}

async function measureInsertDiagnostics(): Promise<Record<Engine['name'], InsertDiagnostic[]>> {
  const measured = emptySamples<InsertDiagnostic>();
  for (let run = 0; run < insertDiagnosticRuns; run += 1) {
    for (const engine of orderedEngines(run + 2)) {
      status.textContent = `Insert diagnostic ${run + 1}/${insertDiagnosticRuns}: ${engine.name}`;
      const opened = await engine.open();
      const database = opened.database;
      try {
        await warmRepresentativePaths(database);
        const expressionOnlyMs = await elapsed(async () => {
          const value = Number(
            await database.scalar(
              'SELECT sum(length(repeat(md5(i::text), 2))) FROM generate_series(1, 10000) AS series(i)',
            ),
          );
          requireEqual(value, 640_000, 'expression diagnostic');
        });
        await database.query('CREATE TABLE insert_heap (id integer, payload text NOT NULL)');
        const heapInsert10kMs = await elapsed(() =>
          database.query(
            "INSERT INTO insert_heap SELECT i, repeat('x', 64) FROM generate_series(1, 10000) AS series(i)",
          ),
        );
        await expectTableState(database, 'insert_heap', 10_000, 50_005_000, 640_000);
        await database.query(
          'CREATE TABLE insert_indexed (id integer PRIMARY KEY, payload text NOT NULL)',
        );
        const beforeWal = await scalarText(database, 'SELECT pg_current_wal_insert_lsn()::text');
        const indexedInsert10kMs = await elapsed(() =>
          database.query(
            "INSERT INTO insert_indexed SELECT i, repeat('x', 64) FROM generate_series(1, 10000) AS series(i)",
          ),
        );
        await expectTableState(database, 'insert_indexed', 10_000, 50_005_000, 640_000);
        const indexedInsertWalBytes = Number(
          await scalarText(
            database,
            `SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '${beforeWal}')::text`,
          ),
        );
        await database.query(
          'CREATE TABLE insert_explain (id integer PRIMARY KEY, payload text NOT NULL)',
        );
        const explain = await database.query(
          "EXPLAIN (ANALYZE, TIMING OFF, FORMAT TEXT, WAL) INSERT INTO insert_explain SELECT i, repeat('x', 64) FROM generate_series(1, 10000) AS series(i)",
        );
        const executionTime = scalarFromResult(explain);
        const indexedInsertServerMs = Number(
          /Execution Time: ([0-9.]+) ms/.exec(executionTime)?.[1],
        );
        if (!Number.isFinite(indexedInsertServerMs)) {
          throw new Error('insert EXPLAIN returned no execution time');
        }
        if (!Number.isFinite(indexedInsertWalBytes)) {
          throw new Error('insert WAL diagnostic returned no byte count');
        }
        await expectTableState(database, 'insert_explain', 10_000, 50_005_000, 640_000);
        measured[engine.name].push({
          postgres: database.postgres,
          expressionOnlyMs,
          heapInsert10kMs,
          indexedInsert10kMs,
          indexedInsertServerMs,
          indexedInsertWalBytes,
        });
      } finally {
        await database.close();
      }
    }
  }
  return measured;
}

function summarizeInsertDiagnostics(
  samples: Record<Engine['name'], InsertDiagnostic[]>,
): InsertDiagnosticSummary {
  return Object.fromEntries(
    insertDiagnosticMetrics.map((metric) => [
      metric,
      Object.fromEntries(
        engines.map((engine) => [
          engine.name,
          median(samples[engine.name].map((sample) => sample[metric])),
        ]),
      ),
    ]),
  ) as InsertDiagnosticSummary;
}

async function scalarText(database: BenchDatabase, sql: string): Promise<string> {
  return database.scalar(sql);
}

function representativePostgresProfiles(
  samples: Record<Engine['name'], WorkloadRun[]>,
): Record<Engine['name'], PostgresProfile | null> {
  return Object.fromEntries(
    engines.map((engine) => [engine.name, samples[engine.name][0]?.postgres ?? null]),
  ) as Record<Engine['name'], PostgresProfile | null>;
}

async function measureStartup(): Promise<Record<Engine['name'], number[]>> {
  const samples = emptySamples<number>();
  for (let run = 0; run < startupRuns; run += 1) {
    for (const engine of orderedEngines(run)) {
      status.textContent = `Startup ${run + 1}/${startupRuns}: ${engine.name}`;
      const opened = await engine.open();
      samples[engine.name].push(opened.readyMs);
      await opened.database.close();
    }
  }
  return samples;
}

async function measureWorkloads(): Promise<Record<Engine['name'], WorkloadRun[]>> {
  const samples = emptySamples<WorkloadRun>();
  for (let run = 0; run < workloadRuns; run += 1) {
    for (const engine of orderedEngines(run + 1)) {
      const label = `Workload ${run + 1}/${workloadRuns}: ${engine.name}`;
      samples[engine.name].push(
        await runWorkload(engine.open, (phase) => {
          status.textContent = `${label} · ${phase}`;
        }),
      );
    }
  }
  return samples;
}

function orderedEngines(run: number): Engine[] {
  const offset = run % engines.length;
  return [...engines.slice(offset), ...engines.slice(0, offset)];
}

async function runWorkload(
  open: () => Promise<OpenResult>,
  progress: (phase: string) => void,
): Promise<WorkloadRun> {
  progress('open');
  const opened = await open();
  const database = opened.database;
  try {
    progress('warmup');
    await warmRepresentativePaths(database);
    progress('schema and insert');
    const createTableMs = await elapsed(() =>
      database.query('CREATE TABLE bench (id integer PRIMARY KEY, payload text NOT NULL)'),
    );
    const insert10kMs = await elapsed(() =>
      database.query(
        'INSERT INTO bench SELECT i, repeat(md5(i::text), 2) FROM generate_series(1, 10000) AS series(i)',
      ),
    );
    await expectTableState(database, 'bench', 10_000, 50_005_000, 640_000);
    await database.query('ANALYZE bench');

    for (let index = 1; index <= 20; index += 1) {
      const result = await database.query('SELECT id, payload FROM bench WHERE id = $1', [index]);
      requireEqual(database.consume(result), index + 64, 'point query warmup');
    }
    progress('point lookups');
    const point = await samples(pointSamples, async (index) => {
      const id = ((index * 7919) % 10_000) + 1;
      const result = await database.query('SELECT id, payload FROM bench WHERE id = $1', [id]);
      requireEqual(database.consume(result), id + 64, 'point query');
    });

    progress('range lookups');
    const range = await samples(rangeSamples, async (index) => {
      const firstId = ((index * 193) % 9_900) + 1;
      const result = await database.query(
        'SELECT id, payload FROM bench WHERE id >= $1 ORDER BY id LIMIT 100',
        [firstId],
      );
      const expectedIdSum = (100 * (2 * firstId + 99)) / 2;
      requireEqual(database.consume(result), expectedIdSum + 6_400, 'indexed range query');
    });

    for (let index = 0; index < 3; index += 1) {
      const result = await database.query(
        'SELECT 1 AS id, sum(id)::text AS payload FROM bench WHERE id % 7 = 0',
      );
      requireEqual(database.consume(result), 8, 'aggregate query warmup');
    }
    progress('aggregates');
    const aggregate = await samples(aggregateSamples, async () => {
      const result = await database.query(
        'SELECT 1 AS id, sum(id)::text AS payload FROM bench WHERE id % 7 = 0',
      );
      requireEqual(database.consume(result), 8, 'aggregate query');
    });

    progress('scan and decode');
    const scanAndDecode10kMs = await elapsed(async () => {
      const result = await database.query('SELECT id, payload FROM bench ORDER BY id');
      requireEqual(database.consume(result), 50_645_000, '10k row scan');
    });

    progress('transaction inserts');
    const transactionInsertBatchMs = await elapsed(async () => {
      await database.transaction(async (transaction) => {
        for (let index = 1; index <= transactionInserts; index += 1) {
          await transaction.query('INSERT INTO bench VALUES ($1, $2)', [
            10_000 + index,
            `batch-${index}`,
          ]);
        }
      });
    });
    const batchIdSum = (transactionInserts * (20_001 + transactionInserts)) / 2;
    const batchPayloadLength = Array.from(
      { length: transactionInserts },
      (_, index) => `batch-${index + 1}`.length,
    ).reduce((total, length) => total + length, 0);
    await expectTableState(
      database,
      'bench',
      10_000 + transactionInserts,
      50_005_000 + batchIdSum,
      640_000 + batchPayloadLength,
    );

    progress('update and delete');
    const update1kMs = await elapsed(() =>
      database.query("UPDATE bench SET payload = payload || 'x' WHERE id <= 1000"),
    );
    await expectTableState(
      database,
      'bench',
      10_000 + transactionInserts,
      50_005_000 + batchIdSum,
      641_000 + batchPayloadLength,
    );
    const delete1kMs = await elapsed(() => database.query('DELETE FROM bench WHERE id <= 1000'));
    await expectTableState(
      database,
      'bench',
      9_000 + transactionInserts,
      49_504_500 + batchIdSum,
      576_000 + batchPayloadLength,
    );

    progress('close');
    const closeStarted = performance.now();
    await database.close();
    const closeMs = performance.now() - closeStarted;

    return {
      postgres: database.postgres,
      metrics: {
        readyMs: opened.readyMs,
        createTableMs,
        insert10kMs,
        pointMedianMs: median(point),
        pointP95Ms: quantile(point, 0.95),
        range100MedianMs: median(range),
        range100P95Ms: quantile(range, 0.95),
        aggregateMedianMs: median(aggregate),
        aggregateP95Ms: quantile(aggregate, 0.95),
        scanAndDecode10kMs,
        transactionInsertBatchMs,
        update1kMs,
        delete1kMs,
        closeMs,
      },
      observations: {
        pointMs: point,
        range100Ms: range,
        aggregateMs: aggregate,
      },
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function warmRepresentativePaths(database: BenchDatabase): Promise<void> {
  await database.query(
    'CREATE TEMP TABLE bench_warmup (id integer PRIMARY KEY, payload text NOT NULL)',
  );
  await database.query(
    'INSERT INTO bench_warmup SELECT i, repeat(md5(i::text), 2) FROM generate_series(1, 2000) AS series(i)',
  );
  await database.query('SELECT id, payload FROM bench_warmup WHERE id = $1', [997]);
  await database.query('SELECT id, payload FROM bench_warmup ORDER BY id LIMIT 100');
  await database.query('SELECT sum(id) FROM bench_warmup');
  await database.query("UPDATE bench_warmup SET payload = payload || 'x' WHERE id <= 100");
  await database.query('DELETE FROM bench_warmup WHERE id <= 100');
  await database.transaction(async (transaction) => {
    for (let index = 1; index <= 20; index += 1) {
      await transaction.query('INSERT INTO bench_warmup VALUES ($1, $2)', [
        2_000 + index,
        `warm-${index}`,
      ]);
    }
  });
  await database.query('DROP TABLE bench_warmup');
}

function summarizeResults(
  startup: Record<Engine['name'], number[]>,
  workload: Record<Engine['name'], WorkloadRun[]>,
): Record<string, unknown> {
  const startupSummary = {
    firstReadyMs: executionSurfaceComparisons(startup, (samples) => samples.slice(0, 1)),
    warmReadyMs: executionSurfaceComparisons(startup, (samples) => samples.slice(1)),
  };
  const workloadSummary = Object.fromEntries(
    workloadMetrics.map((metric) => [
      metric,
      {
        direct: pairedComparison(
          workload.wasixDirect.map((run) => run.metrics[metric]),
          workload.pgliteDirect.map((run) => run.metrics[metric]),
        ),
        worker: pairedComparison(
          workload.wasixWorker.map((run) => run.metrics[metric]),
          workload.pgliteWorker.map((run) => run.metrics[metric]),
        ),
      },
    ]),
  );
  return { startup: startupSummary, workload: workloadSummary };
}

function executionSurfaceComparisons(
  samples: Record<Engine['name'], number[]>,
  select: (values: number[]) => number[],
) {
  return {
    direct: pairedComparison(select(samples.wasixDirect), select(samples.pgliteDirect)),
    worker: pairedComparison(select(samples.wasixWorker), select(samples.pgliteWorker)),
  };
}

function pairedComparison(wasixSamples: number[], pgliteSamples: number[]) {
  const sampleCount = Math.min(wasixSamples.length, pgliteSamples.length);
  if (sampleCount === 0) {
    return {
      ...comparison(undefined, undefined),
      sampleCount,
      pairedMedianAdvantagePercent: null,
      pairedP25AdvantagePercent: null,
      pairedP75AdvantagePercent: null,
    };
  }
  const pairs = wasixSamples.slice(0, sampleCount).map((wasix, index) => {
    const pglite = pgliteSamples[index];
    if (pglite === undefined) throw new Error(`missing paired PGlite sample ${index}`);
    return {
      advantagePercent: ((pglite - wasix) / pglite) * 100,
      ratio: wasix / pglite,
    };
  });
  const pairedAdvantages = pairs.map((pair) => pair.advantagePercent);
  const pairedP25AdvantagePercent = quantile(pairedAdvantages, 0.25);
  const pairedRatios = pairs.map((pair) => pair.ratio);
  return {
    ...comparison(
      median(wasixSamples.slice(0, sampleCount)),
      median(pgliteSamples.slice(0, sampleCount)),
    ),
    sampleCount,
    pairedRatioMedian: round(median(pairedRatios)),
    pairedMedianAdvantagePercent: round(median(pairedAdvantages)),
    pairedP25AdvantagePercent: round(pairedP25AdvantagePercent),
    pairedP75AdvantagePercent: round(quantile(pairedAdvantages, 0.75)),
  };
}

function comparison(wasixMs: number | undefined, pgliteMs: number | undefined) {
  if (wasixMs === undefined || pgliteMs === undefined) {
    return { wasixMs: null, pgliteMs: null, advantagePercent: null };
  }
  const advantagePercent = ((pgliteMs - wasixMs) / pgliteMs) * 100;
  return {
    wasixMs: round(wasixMs),
    pgliteMs: round(pgliteMs),
    advantagePercent: round(advantagePercent),
  };
}

async function openWasix(executionSurface: OliphauntExecutionSurface): Promise<OpenResult> {
  const started = performance.now();
  const client = executionSurface === 'direct' ? Oliphaunt : WorkerOliphaunt;
  const database = await client.open({
    ...(persistentWorkerStorage && executionSurface === 'worker'
      ? { storage: opfs(nextPersistentDatabase('wasix')) }
      : {}),
  });
  const readyMs = performance.now() - started;
  const postgres = await readWasixPostgresProfile(database);
  return {
    readyMs,
    database: {
      postgres,
      query: (sql, parameters = []) => database.queryRaw(sql, parameters),
      scalar: async (sql) => {
        const result = await database.queryRaw(sql);
        return result.rows[0]?.text(0) ?? '';
      },
      transaction: (body) =>
        database.transaction((transaction) =>
          body({ query: (sql, parameters = []) => transaction.queryRaw(sql, parameters) }),
        ),
      consume(result) {
        const query = result as Awaited<ReturnType<typeof database.queryRaw>>;
        let checksum = 0;
        for (const row of query.rows) {
          checksum += Number(row.text(0));
          checksum += row.text(1)?.length ?? 0;
        }
        return checksum;
      },
      close: () => database.close(),
    },
  };
}

async function openPGliteWorker(): Promise<OpenResult> {
  const started = performance.now();
  const assets = await pgliteAssets();
  const worker = new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' });
  const database = new PGliteWorker(worker, {
    ...assets,
    ...(persistentWorkerStorage
      ? {
          dataDir: `opfs-ahp://${nextPersistentDatabase('pglite')}`,
          startParams: [...durablePGliteStartParams],
        }
      : {}),
  });
  await database.waitReady;
  const readyMs = performance.now() - started;
  const postgres = await readPGlitePostgresProfile(database);
  return {
    readyMs,
    database: {
      postgres,
      query: (sql, parameters = []) => database.query(sql, [...parameters]),
      scalar: async (sql) => {
        const result = await database.query<Record<string, unknown>>(sql);
        return String(Object.values(result.rows[0] ?? {})[0] ?? '');
      },
      transaction: (body) =>
        database.transaction((transaction) =>
          body({ query: (sql, parameters = []) => transaction.query(sql, [...parameters]) }),
        ),
      consume(result) {
        const query = result as { rows: Array<{ id: number; payload: string }> };
        let checksum = 0;
        for (const row of query.rows) {
          checksum += row.id;
          checksum += row.payload.length;
        }
        return checksum;
      },
      close: async () => {
        await database.close();
        worker.terminate();
      },
    },
  };
}

function nextPersistentDatabase(engine: 'wasix' | 'pglite'): string {
  persistentDatabase += 1;
  return `benchmark-${engine}-${persistentRun}-${persistentDatabase}`;
}

async function openPGliteDirect(): Promise<OpenResult> {
  const started = performance.now();
  const database = await PGlite.create(await pgliteAssets());
  const readyMs = performance.now() - started;
  const postgres = await readPGlitePostgresProfile(database);
  return {
    readyMs,
    database: pgliteAdapter(database, postgres),
  };
}

function pgliteAdapter(
  database: Pick<PGlite, 'query' | 'transaction' | 'close'>,
  postgres: PostgresProfile,
): BenchDatabase {
  return {
    postgres,
    query: (sql, parameters = []) => database.query(sql, [...parameters]),
    scalar: async (sql) => {
      const result = await database.query<Record<string, unknown>>(sql);
      return String(Object.values(result.rows[0] ?? {})[0] ?? '');
    },
    transaction: (body) =>
      database.transaction((transaction) =>
        body({ query: (sql, parameters = []) => transaction.query(sql, [...parameters]) }),
      ),
    consume(result) {
      const query = result as { rows: Array<{ id: number; payload: string }> };
      let checksum = 0;
      for (const row of query.rows) {
        checksum += row.id;
        checksum += row.payload.length;
      }
      return checksum;
    },
    close: () => database.close(),
  };
}

function scalarFromResult(result: unknown): string {
  const rows = (result as { rows?: unknown[] }).rows ?? [];
  const values: string[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const text = (row as { text?: (column: number) => string | null }).text;
    if (typeof text === 'function') {
      const value = text.call(row, 0);
      if (value !== null) values.push(value);
      continue;
    }
    for (const value of Object.values(row)) {
      if (typeof value === 'string') values.push(value);
    }
  }
  if (values.length > 0) return values.join('\n');
  throw new Error('query returned no scalar text value');
}

async function readWasixPostgresProfile(
  database: Awaited<ReturnType<typeof Oliphaunt.open>>,
): Promise<PostgresProfile> {
  const result = await database.queryRaw(postgresProfileSql());
  return {
    version: result.getText(0, 'version') ?? 'unknown',
    fsync: result.getText(0, 'fsync') ?? 'unknown',
    walSyncMethod: result.getText(0, 'wal_sync_method') ?? 'unknown',
    sharedBuffers: result.getText(0, 'shared_buffers') ?? 'unknown',
    walBuffers: result.getText(0, 'wal_buffers') ?? 'unknown',
    synchronousCommit: result.getText(0, 'synchronous_commit') ?? 'unknown',
    fullPageWrites: result.getText(0, 'full_page_writes') ?? 'unknown',
    walLevel: result.getText(0, 'wal_level') ?? 'unknown',
  };
}

async function readPGlitePostgresProfile(
  database: Pick<PGlite, 'query'>,
): Promise<PostgresProfile> {
  const result = await database.query<{
    version: string;
    fsync: string;
    wal_sync_method: string;
    shared_buffers: string;
    wal_buffers: string;
    synchronous_commit: string;
    full_page_writes: string;
    wal_level: string;
  }>(postgresProfileSql());
  const row = result.rows[0];
  if (row === undefined) throw new Error('PGlite returned no PostgreSQL profile');
  return {
    version: row.version,
    fsync: row.fsync,
    walSyncMethod: row.wal_sync_method,
    sharedBuffers: row.shared_buffers,
    walBuffers: row.wal_buffers,
    synchronousCommit: row.synchronous_commit,
    fullPageWrites: row.full_page_writes,
    walLevel: row.wal_level,
  };
}

function postgresProfileSql(): string {
  return `SELECT
    current_setting('server_version') AS version,
    current_setting('fsync') AS fsync,
    current_setting('wal_sync_method') AS wal_sync_method,
    current_setting('shared_buffers') AS shared_buffers,
    current_setting('wal_buffers') AS wal_buffers,
    current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('full_page_writes') AS full_page_writes,
    current_setting('wal_level') AS wal_level`;
}

function pgliteAssets(): Promise<PGliteAssets> {
  pgliteAssetsPromise ??= Promise.all([
    fetch('/wasix-assets/pglite.data')
      .then(requireOk)
      .then((response) => response.blob()),
    fetch('/wasix-assets/pglite.wasm')
      .then(requireOk)
      .then((response) => WebAssembly.compileStreaming(Promise.resolve(response))),
    fetch('/wasix-assets/initdb.wasm')
      .then(requireOk)
      .then((response) => WebAssembly.compileStreaming(Promise.resolve(response))),
  ]).then(([fsBundle, pgliteWasmModule, initdbWasmModule]) => ({
    fsBundle,
    pgliteWasmModule,
    initdbWasmModule,
  }));
  return pgliteAssetsPromise;
}

async function samples(
  count: number,
  operation: (index: number) => Promise<unknown>,
): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(await elapsed(() => operation(index)));
  }
  return result;
}

async function elapsed(operation: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error('median requires at least one sample');
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error('median requires at least two samples for an even set');
  return (lower + upper) / 2;
}

function quantile(values: number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const result = sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)];
  if (result === undefined) {
    throw new Error('quantile requires at least one sample');
  }
  return result;
}

function emptySamples<Value>(): Record<Engine['name'], Value[]> {
  return { wasixDirect: [], wasixWorker: [], pgliteDirect: [], pgliteWorker: [] };
}

function requireEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, received ${actual}`);
  }
}

async function expectTableState(
  database: BenchDatabase,
  table: string,
  expectedRows: number,
  expectedIdSum: number,
  expectedPayloadLength: number,
): Promise<void> {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error(`benchmark table name is invalid: ${JSON.stringify(table)}`);
  }
  const state = await database.scalar(
    `SELECT count(*)::text || ':' || coalesce(sum(id), 0)::text || ':' || coalesce(sum(length(payload)), 0)::text FROM ${table}`,
  );
  const expected = `${expectedRows}:${expectedIdSum}:${expectedPayloadLength}`;
  if (state !== expected) {
    throw new Error(`${table} state expected ${expected}, received ${JSON.stringify(state)}`);
  }
}

function requireOk(response: Response): Response {
  if (!response.ok) {
    throw new Error(`asset request failed: ${response.status} ${response.url}`);
  }
  return response;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element as ElementType;
}
