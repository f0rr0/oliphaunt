import type {
  EngineCapabilities,
  OpenConfig,
  PackageSizeReport,
  OliphauntClient,
  OliphauntDatabase,
  ProcessMemoryReport,
} from './client';
import { simpleQuery } from './protocol';

export type ReactNativeBenchmarkOptions = {
  readonly open?: OpenConfig;
  readonly requirePackageSizeReport?: boolean;
  readonly warmupIterations?: number;
  readonly rawRttIterations?: number;
  readonly typedRttIterations?: number;
  readonly parameterizedRttIterations?: number;
  readonly insertRows?: number;
  readonly lookupIterations?: number;
  readonly aggregateIterations?: number;
  readonly updateIterations?: number;
  readonly checkpointIterations?: number;
  readonly largeResultRows?: number;
  readonly metadata?: Record<string, string | number | boolean | null>;
};

export type LatencySummary = {
  readonly iterations: number;
  readonly totalMs: number;
  readonly minMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
};

export type ThroughputSummary = {
  readonly rows: number;
  readonly totalMs: number;
  readonly rowsPerSecond: number;
};

export type ReactNativeBenchmarkWorkload = {
  readonly id: string;
  readonly description: string;
  readonly latency?: LatencySummary;
  readonly throughput?: ThroughputSummary;
  readonly rows?: number;
  readonly responseBytes?: number;
  readonly checksum?: string;
};

export type PostgresSettings = Record<string, string | null>;

export type ReactNativeBenchmarkReport = {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly openMs: number;
  readonly closeMs: number;
  readonly engine: EngineCapabilities['engine'];
  readonly rawProtocolTransport: EngineCapabilities['rawProtocolTransport'];
  readonly capabilities: EngineCapabilities;
  readonly options: Required<
    Pick<
      ReactNativeBenchmarkOptions,
      | 'warmupIterations'
      | 'rawRttIterations'
      | 'typedRttIterations'
      | 'parameterizedRttIterations'
      | 'insertRows'
      | 'lookupIterations'
      | 'aggregateIterations'
      | 'updateIterations'
      | 'checkpointIterations'
      | 'largeResultRows'
    >
  >;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly postgresSettings: PostgresSettings;
  readonly packageSizeReport?: PackageSizeReport | null;
  readonly processMemoryReport: ProcessMemoryReport;
  readonly jsTimerTicks: number;
  readonly workloads: ReactNativeBenchmarkWorkload[];
};

type ResolvedBenchmarkOptions = ReactNativeBenchmarkReport['options'];

const defaultBenchmarkOptions: ResolvedBenchmarkOptions = {
  warmupIterations: 50,
  rawRttIterations: 500,
  typedRttIterations: 500,
  parameterizedRttIterations: 500,
  insertRows: 1_000,
  lookupIterations: 500,
  aggregateIterations: 250,
  updateIterations: 200,
  checkpointIterations: 20,
  largeResultRows: 500,
};

const benchmarkPostgresSettings = [
  'shared_buffers',
  'wal_buffers',
  'wal_segment_size',
  'min_wal_size',
  'max_wal_size',
  'max_connections',
  'superuser_reserved_connections',
  'reserved_connections',
  'autovacuum_worker_slots',
  'max_wal_senders',
  'max_replication_slots',
  'io_method',
  'io_max_concurrency',
  'fsync',
  'full_page_writes',
  'synchronous_commit',
  'work_mem',
  'maintenance_work_mem',
] as const;

export async function runOliphauntReactNativeBenchmark(
  client: OliphauntClient,
  options: ReactNativeBenchmarkOptions = {},
): Promise<ReactNativeBenchmarkReport> {
  const resolved = resolveOptions(options);
  const startedAt = new Date().toISOString();
  const totalStart = monotonicNow();
  const liveness = startTimerLivenessProbe();
  const packageSizePromise =
    options.requirePackageSizeReport === true
      ? client.packageSizeReport({ resourceRoot: options.open?.resourceRoot })
      : Promise.resolve<PackageSizeReport | null | undefined>(undefined);

  let closeMs = 0;
  const openStart = monotonicNow();
  const db = await client.open({
    engine: 'nativeDirect',
    temporary: true,
    durability: 'balanced',
    username: 'postgres',
    database: 'postgres',
    ...options.open,
  });
  const openMs = monotonicNow() - openStart;

  try {
    const capabilities = await db.capabilities();
    assertBenchmarkCapabilities(capabilities);
    const postgresSettings = await readPostgresSettings(db);

    await runWarmup(db, resolved.warmupIterations);
    const workloads: ReactNativeBenchmarkWorkload[] = [];
    workloads.push(await runRawSimpleQueryRtt(db, resolved.rawRttIterations));
    workloads.push(await runTypedSelectRtt(db, resolved.typedRttIterations));
    workloads.push(await runParameterizedSelectRtt(db, resolved.parameterizedRttIterations));
    workloads.push(await prepareDataset(db, resolved.insertRows));
    workloads.push(await runIndexedLookup(db, resolved.lookupIterations, resolved.insertRows));
    workloads.push(await runAggregateScan(db, resolved.aggregateIterations));
    workloads.push(await runIndexedUpdates(db, resolved.updateIterations, resolved.insertRows));
    workloads.push(await runBackgroundCheckpointLatency(db, resolved.checkpointIterations));
    workloads.push(await runLargeResult(db, resolved.largeResultRows));

    const processMemoryReport = await client.processMemory();
    const closeStart = monotonicNow();
    await db.close();
    closeMs = monotonicNow() - closeStart;
    liveness.stop();

    const packageSizeReport = await packageSizePromise;
    if (options.requirePackageSizeReport === true && packageSizeReport == null) {
      throw new Error('Oliphaunt React Native benchmark expected packaged resource size evidence');
    }

    return {
      schemaVersion: 1,
      startedAt,
      elapsedMs: monotonicNow() - totalStart,
      openMs,
      closeMs,
      engine: capabilities.engine,
      rawProtocolTransport: capabilities.rawProtocolTransport,
      capabilities,
      options: resolved,
      metadata: options.metadata ?? {},
      postgresSettings,
      packageSizeReport,
      processMemoryReport,
      jsTimerTicks: liveness.ticks(),
      workloads,
    };
  } finally {
    liveness.stop();
    await db.close();
  }
}

export async function runInstalledOliphauntReactNativeBenchmark(
  options: ReactNativeBenchmarkOptions = {},
): Promise<ReactNativeBenchmarkReport> {
  const { Oliphaunt } = await import('./index.js');
  return runOliphauntReactNativeBenchmark(Oliphaunt, options);
}

function resolveOptions(options: ReactNativeBenchmarkOptions): ResolvedBenchmarkOptions {
  return {
    warmupIterations: positiveInteger(
      options.warmupIterations,
      defaultBenchmarkOptions.warmupIterations,
      'warmupIterations',
    ),
    rawRttIterations: positiveInteger(
      options.rawRttIterations,
      defaultBenchmarkOptions.rawRttIterations,
      'rawRttIterations',
    ),
    typedRttIterations: positiveInteger(
      options.typedRttIterations,
      defaultBenchmarkOptions.typedRttIterations,
      'typedRttIterations',
    ),
    parameterizedRttIterations: positiveInteger(
      options.parameterizedRttIterations,
      defaultBenchmarkOptions.parameterizedRttIterations,
      'parameterizedRttIterations',
    ),
    insertRows: positiveInteger(
      options.insertRows,
      defaultBenchmarkOptions.insertRows,
      'insertRows',
    ),
    lookupIterations: positiveInteger(
      options.lookupIterations,
      defaultBenchmarkOptions.lookupIterations,
      'lookupIterations',
    ),
    aggregateIterations: positiveInteger(
      options.aggregateIterations,
      defaultBenchmarkOptions.aggregateIterations,
      'aggregateIterations',
    ),
    updateIterations: positiveInteger(
      options.updateIterations,
      defaultBenchmarkOptions.updateIterations,
      'updateIterations',
    ),
    checkpointIterations: positiveInteger(
      options.checkpointIterations,
      defaultBenchmarkOptions.checkpointIterations,
      'checkpointIterations',
    ),
    largeResultRows: positiveInteger(
      options.largeResultRows,
      defaultBenchmarkOptions.largeResultRows,
      'largeResultRows',
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return selected;
}

async function readPostgresSettings(db: OliphauntDatabase): Promise<PostgresSettings> {
  const values = benchmarkPostgresSettings.map((name) => `('${sqlLiteral(name)}')`).join(', ');
  const result = await db.query(`
    SELECT name, current_setting(name, true) AS value
    FROM (VALUES ${values}) AS settings(name)
    ORDER BY name
  `);
  const nameColumn = result.fieldIndex('name');
  const valueColumn = result.fieldIndex('value');
  if (nameColumn === undefined || valueColumn === undefined) {
    throw new Error('PostgreSQL settings probe returned an unexpected row shape');
  }

  const settings: PostgresSettings = {};
  for (const row of result.rows) {
    const name = row.text(nameColumn);
    if (name == null || name.length === 0) {
      continue;
    }
    settings[name] = row.text(valueColumn);
  }
  return settings;
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function runWarmup(db: OliphauntDatabase, iterations: number): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await db.execProtocolRaw(simpleQuery('SELECT 1'));
  }
}

async function runRawSimpleQueryRtt(
  db: OliphauntDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async (index) => {
    const response = await db.execProtocolRaw(simpleQuery(`SELECT ${index % 17}::int AS value`));
    checksum += response.byteLength;
  });
  return {
    id: 'raw_simple_query_rtt',
    description: 'Raw PostgreSQL simple-query protocol round trip through JSI ArrayBuffer',
    latency,
    checksum: String(checksum),
  };
}

async function runTypedSelectRtt(
  db: OliphauntDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async (index) => {
    const result = await db.query(`SELECT ${index % 17}::text AS value`);
    checksum += Number(result.getText(0, 'value') ?? '0');
  });
  return {
    id: 'typed_select_rtt',
    description: 'Typed query() SELECT round trip including JS protocol response parsing',
    latency,
    checksum: String(checksum),
  };
}

async function runParameterizedSelectRtt(
  db: OliphauntDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async (index) => {
    const result = await db.query('SELECT $1::text AS value', [`value-${index}`]);
    checksum += result.getText(0, 'value')?.length ?? 0;
  });
  return {
    id: 'parameterized_select_rtt',
    description: 'Extended-query parameter binding round trip through query()',
    latency,
    checksum: String(checksum),
  };
}

async function prepareDataset(
  db: OliphauntDatabase,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  await db.execute(`
    DROP TABLE IF EXISTS rn_bench_events;
    CREATE TABLE rn_bench_events (
      id integer PRIMARY KEY,
      bucket integer NOT NULL,
      label text NOT NULL,
      amount integer NOT NULL,
      payload text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX rn_bench_events_bucket_idx ON rn_bench_events(bucket);
    CREATE INDEX rn_bench_events_label_idx ON rn_bench_events(label);
  `);

  const started = monotonicNow();
  await db.transaction(async (tx) => {
    for (let index = 1; index <= rows; index += 1) {
      await tx.query(
        `INSERT INTO rn_bench_events (id, bucket, label, amount, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          index,
          index % 32,
          `label-${index % 128}`,
          index % 10_000,
          `payload-${index}-${'x'.repeat(48)}`,
        ],
      );
    }
  });
  const totalMs = monotonicNow() - started;

  return {
    id: 'transaction_insert',
    description: 'Parameterized INSERT workload inside one transaction',
    throughput: {
      rows,
      totalMs,
      rowsPerSecond: rows / (totalMs / 1_000),
    },
    rows,
  };
}

async function runIndexedLookup(
  db: OliphauntDatabase,
  iterations: number,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async (index) => {
    const id = (index % rows) + 1;
    const result = await db.query('SELECT payload FROM rn_bench_events WHERE id = $1', [id]);
    checksum += result.getText(0, 'payload')?.length ?? 0;
  });
  return {
    id: 'indexed_lookup',
    description: 'Parameterized primary-key lookup against the benchmark table',
    latency,
    checksum: String(checksum),
  };
}

async function runAggregateScan(
  db: OliphauntDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async (index) => {
    const result = await db.query(
      `SELECT count(*)::text AS rows, coalesce(sum(amount), 0)::text AS total
       FROM rn_bench_events
       WHERE bucket = $1`,
      [index % 32],
    );
    checksum += Number(result.getText(0, 'rows') ?? '0');
    checksum += Number(result.getText(0, 'total') ?? '0');
  });
  return {
    id: 'indexed_aggregate',
    description: 'Indexed aggregate with count and sum over a bucket predicate',
    latency,
    checksum: String(checksum),
  };
}

async function runIndexedUpdates(
  db: OliphauntDatabase,
  iterations: number,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  const latency = await measureLatency(iterations, async (index) => {
    const id = ((index * 17) % rows) + 1;
    await db.query(
      `UPDATE rn_bench_events
       SET amount = amount + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING amount::text AS amount`,
      [id],
    );
  });
  const checksum = await db.query(
    'SELECT coalesce(sum(amount), 0)::text AS checksum FROM rn_bench_events',
  );
  return {
    id: 'indexed_update',
    description: 'Single-row parameterized UPDATE by primary key',
    latency,
    checksum: checksum.getText(0, 'checksum') ?? '0',
  };
}

async function runBackgroundCheckpointLatency(
  db: OliphauntDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  const latency = await measureLatency(iterations, async () => {
    const result = await db.prepareForBackground({
      cancelActiveWork: false,
      checkpointWhenIdle: true,
    });
    if (!result.checkpointed) {
      throw new Error(
        `background checkpoint was skipped: ${result.skippedCheckpointReason ?? 'unknown'}`,
      );
    }
  });
  return {
    id: 'background_checkpoint',
    description: 'prepareForBackground checkpoint latency while the direct session is idle',
    latency,
  };
}

async function runLargeResult(
  db: OliphauntDatabase,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  const sql = `
    SELECT id::text AS id, label, payload
    FROM rn_bench_events
    ORDER BY id
    LIMIT ${rows}
  `;
  let responseBytes = 0;
  const latency = await measureLatency(20, async () => {
    const response = await db.execProtocolRaw(simpleQuery(sql));
    responseBytes = response.byteLength;
  });
  return {
    id: 'large_result_raw',
    description: 'Large raw protocol result transfer without JS row parsing',
    latency,
    rows,
    responseBytes,
    checksum: String(responseBytes),
  };
}

async function measureLatency(
  iterations: number,
  run: (index: number) => Promise<void>,
): Promise<LatencySummary> {
  const values: number[] = [];
  const totalStart = monotonicNow();
  for (let index = 0; index < iterations; index += 1) {
    const started = monotonicNow();
    await run(index);
    values.push(monotonicNow() - started);
  }
  const totalMs = monotonicNow() - totalStart;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    iterations,
    totalMs,
    minMs: sorted[0] ?? 0,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentileSorted(sorted, 0.5),
    p90Ms: percentileSorted(sorted, 0.9),
    p95Ms: percentileSorted(sorted, 0.95),
    p99Ms: percentileSorted(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function percentileSorted(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index] ?? 0;
}

function assertBenchmarkCapabilities(capabilities: EngineCapabilities): void {
  if (capabilities.engine !== 'nativeDirect') {
    throw new Error(
      `React Native benchmark currently requires nativeDirect, got ${capabilities.engine}`,
    );
  }
  if (capabilities.rawProtocolTransport !== 'jsi-array-buffer') {
    throw new Error(
      `React Native benchmark requires JSI ArrayBuffer transport, got ${capabilities.rawProtocolTransport}`,
    );
  }
  if (!capabilities.protocolRaw || !capabilities.simpleQuery) {
    throw new Error('React Native benchmark requires raw protocol and simple-query support');
  }
}

function monotonicNow(): number {
  const performanceNow = globalThis.performance?.now.bind(globalThis.performance);
  return performanceNow ? performanceNow() : Date.now();
}

function startTimerLivenessProbe(): { ticks: () => number; stop: () => void } {
  let active = true;
  let ticks = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timeout = setTimeout(() => {
      if (!active) {
        return;
      }
      ticks += 1;
      schedule();
    }, 0);
  };
  schedule();
  return {
    ticks: () => ticks,
    stop: () => {
      active = false;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}
