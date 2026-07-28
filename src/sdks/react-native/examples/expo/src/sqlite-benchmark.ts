import * as SQLite from 'expo-sqlite';
import type {
  LatencySummary,
  ReactNativeBenchmarkWorkload,
  ThroughputSummary,
} from '@oliphaunt/react-native';

export type SQLiteDurabilityProfile = 'safe' | 'balanced' | 'fastDev';

export type ExpoSQLiteBenchmarkOptions = {
  readonly durability?: SQLiteDurabilityProfile;
  readonly warmupIterations?: number;
  readonly simpleRttIterations?: number;
  readonly parameterizedRttIterations?: number;
  readonly insertRows?: number;
  readonly lookupIterations?: number;
  readonly aggregateIterations?: number;
  readonly updateIterations?: number;
  readonly checkpointIterations?: number;
  readonly largeResultRows?: number;
  readonly metadata?: Record<string, string | number | boolean | null>;
};

export type ExpoSQLiteBenchmarkReport = {
  readonly schemaVersion: 1;
  readonly engine: 'expo-sqlite';
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly openMs: number;
  readonly closeMs: number;
  readonly databaseName: string;
  readonly durability: SQLiteDurabilityProfile;
  readonly options: Required<
    Pick<
      ExpoSQLiteBenchmarkOptions,
      | 'warmupIterations'
      | 'simpleRttIterations'
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
  readonly workloads: ReactNativeBenchmarkWorkload[];
};

type SQLiteDatabase = Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>;
type ResolvedSQLiteBenchmarkOptions = ExpoSQLiteBenchmarkReport['options'];

const defaultSQLiteBenchmarkOptions: ResolvedSQLiteBenchmarkOptions = {
  warmupIterations: 75,
  simpleRttIterations: 750,
  parameterizedRttIterations: 750,
  insertRows: 1_500,
  lookupIterations: 750,
  aggregateIterations: 300,
  updateIterations: 300,
  checkpointIterations: 20,
  largeResultRows: 750,
};

export async function runExpoSQLiteBenchmark(
  options: ExpoSQLiteBenchmarkOptions = {},
): Promise<ExpoSQLiteBenchmarkReport> {
  const resolved = resolveOptions(options);
  const durability = options.durability ?? 'balanced';
  const startedAt = new Date().toISOString();
  const totalStart = monotonicNow();
  const databaseName = `oliphaunt-sqlite-bench-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.db`;
  await SQLite.deleteDatabaseAsync(databaseName).catch(() => undefined);

  let closeMs = 0;
  const openStart = monotonicNow();
  const db = await SQLite.openDatabaseAsync(databaseName);
  const openMs = monotonicNow() - openStart;

  try {
    await configureDurability(db, durability);
    await runWarmup(db, resolved.warmupIterations);

    const workloads: ReactNativeBenchmarkWorkload[] = [];
    workloads.push(await runSimpleSelectRtt(db, resolved.simpleRttIterations));
    workloads.push(await runParameterizedSelectRtt(db, resolved.parameterizedRttIterations));
    workloads.push(await prepareDataset(db, resolved.insertRows));
    workloads.push(await runIndexedLookup(db, resolved.lookupIterations, resolved.insertRows));
    workloads.push(await runAggregateScan(db, resolved.aggregateIterations));
    workloads.push(await runIndexedUpdates(db, resolved.updateIterations, resolved.insertRows));
    workloads.push(await runCheckpointLatency(db, resolved.checkpointIterations));
    workloads.push(await runLargeResult(db, resolved.largeResultRows));

    const closeStart = monotonicNow();
    await db.closeAsync();
    closeMs = monotonicNow() - closeStart;

    return {
      schemaVersion: 1,
      engine: 'expo-sqlite',
      startedAt,
      elapsedMs: monotonicNow() - totalStart,
      openMs,
      closeMs,
      databaseName,
      durability,
      options: resolved,
      metadata: options.metadata ?? {},
      workloads,
    };
  } finally {
    await db.closeAsync().catch(() => undefined);
    await SQLite.deleteDatabaseAsync(databaseName).catch(() => undefined);
  }
}

function resolveOptions(
  options: ExpoSQLiteBenchmarkOptions,
): ResolvedSQLiteBenchmarkOptions {
  return {
    warmupIterations: positiveInteger(
      options.warmupIterations,
      defaultSQLiteBenchmarkOptions.warmupIterations,
      'sqlite warmupIterations',
    ),
    simpleRttIterations: positiveInteger(
      options.simpleRttIterations,
      defaultSQLiteBenchmarkOptions.simpleRttIterations,
      'sqlite simpleRttIterations',
    ),
    parameterizedRttIterations: positiveInteger(
      options.parameterizedRttIterations,
      defaultSQLiteBenchmarkOptions.parameterizedRttIterations,
      'sqlite parameterizedRttIterations',
    ),
    insertRows: positiveInteger(
      options.insertRows,
      defaultSQLiteBenchmarkOptions.insertRows,
      'sqlite insertRows',
    ),
    lookupIterations: positiveInteger(
      options.lookupIterations,
      defaultSQLiteBenchmarkOptions.lookupIterations,
      'sqlite lookupIterations',
    ),
    aggregateIterations: positiveInteger(
      options.aggregateIterations,
      defaultSQLiteBenchmarkOptions.aggregateIterations,
      'sqlite aggregateIterations',
    ),
    updateIterations: positiveInteger(
      options.updateIterations,
      defaultSQLiteBenchmarkOptions.updateIterations,
      'sqlite updateIterations',
    ),
    checkpointIterations: positiveInteger(
      options.checkpointIterations,
      defaultSQLiteBenchmarkOptions.checkpointIterations,
      'sqlite checkpointIterations',
    ),
    largeResultRows: positiveInteger(
      options.largeResultRows,
      defaultSQLiteBenchmarkOptions.largeResultRows,
      'sqlite largeResultRows',
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

async function configureDurability(
  db: SQLiteDatabase,
  durability: SQLiteDurabilityProfile,
): Promise<void> {
  const synchronous = (() => {
    switch (durability) {
      case 'safe':
        return 'FULL';
      case 'balanced':
        return 'NORMAL';
      case 'fastDev':
        return 'OFF';
    }
  })();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = ${synchronous};
    PRAGMA foreign_keys = ON;
  `);
}

async function runWarmup(db: SQLiteDatabase, iterations: number): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await db.getFirstAsync('SELECT ? AS value', index % 17);
  }
}

async function runSimpleSelectRtt(
  db: SQLiteDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async index => {
    const row = await db.getFirstAsync<{ value: number }>('SELECT ? AS value', index % 17);
    checksum += row?.value ?? 0;
  });
  return {
    id: 'sqlite_simple_select_rtt',
    description: 'SQLite SELECT round trip through expo-sqlite',
    latency,
    checksum: String(checksum),
  };
}

async function runParameterizedSelectRtt(
  db: SQLiteDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async index => {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT ? AS value',
      `value-${index}`,
    );
    checksum += row?.value.length ?? 0;
  });
  return {
    id: 'sqlite_parameterized_select_rtt',
    description: 'SQLite parameter binding round trip through expo-sqlite',
    latency,
    checksum: String(checksum),
  };
}

async function prepareDataset(
  db: SQLiteDatabase,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  await db.execAsync(`
    DROP TABLE IF EXISTS rn_bench_events;
    CREATE TABLE rn_bench_events (
      id integer PRIMARY KEY,
      bucket integer NOT NULL,
      label text NOT NULL,
      amount integer NOT NULL,
      payload text NOT NULL,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX rn_bench_events_bucket_idx ON rn_bench_events(bucket);
    CREATE INDEX rn_bench_events_label_idx ON rn_bench_events(label);
  `);

  const started = monotonicNow();
  await db.withExclusiveTransactionAsync(async tx => {
    for (let index = 1; index <= rows; index += 1) {
      await tx.runAsync(
        `INSERT INTO rn_bench_events (id, bucket, label, amount, payload)
         VALUES (?, ?, ?, ?, ?)`,
        index,
        index % 32,
        `label-${index % 128}`,
        index % 10_000,
        `payload-${index}-${'x'.repeat(48)}`,
      );
    }
  });
  const totalMs = monotonicNow() - started;

  return {
    id: 'sqlite_transaction_insert',
    description: 'SQLite parameterized INSERT workload inside one transaction',
    throughput: throughput(rows, totalMs),
    rows,
  };
}

async function runIndexedLookup(
  db: SQLiteDatabase,
  iterations: number,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async index => {
    const id = (index % rows) + 1;
    const row = await db.getFirstAsync<{ payload: string }>(
      'SELECT payload FROM rn_bench_events WHERE id = ?',
      id,
    );
    checksum += row?.payload.length ?? 0;
  });
  return {
    id: 'sqlite_indexed_lookup',
    description: 'SQLite primary-key lookup against the benchmark table',
    latency,
    checksum: String(checksum),
  };
}

async function runAggregateScan(
  db: SQLiteDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let checksum = 0;
  const latency = await measureLatency(iterations, async index => {
    const row = await db.getFirstAsync<{ rows: number; total: number }>(
      `SELECT count(*) AS rows, coalesce(sum(amount), 0) AS total
       FROM rn_bench_events
       WHERE bucket = ?`,
      index % 32,
    );
    checksum += row?.rows ?? 0;
    checksum += row?.total ?? 0;
  });
  return {
    id: 'sqlite_indexed_aggregate',
    description: 'SQLite indexed aggregate with count and sum over a bucket predicate',
    latency,
    checksum: String(checksum),
  };
}

async function runIndexedUpdates(
  db: SQLiteDatabase,
  iterations: number,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  const latency = await measureLatency(iterations, async index => {
    const id = ((index * 17) % rows) + 1;
    await db.runAsync(
      `UPDATE rn_bench_events
       SET amount = amount + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      id,
    );
  });
  const row = await db.getFirstAsync<{ checksum: number }>(
    'SELECT coalesce(sum(amount), 0) AS checksum FROM rn_bench_events',
  );
  return {
    id: 'sqlite_indexed_update',
    description: 'SQLite single-row parameterized UPDATE by primary key',
    latency,
    checksum: String(row?.checksum ?? 0),
  };
}

async function runCheckpointLatency(
  db: SQLiteDatabase,
  iterations: number,
): Promise<ReactNativeBenchmarkWorkload> {
  const latency = await measureLatency(iterations, async () => {
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  return {
    id: 'sqlite_wal_checkpoint',
    description: 'SQLite WAL checkpoint latency through expo-sqlite',
    latency,
  };
}

async function runLargeResult(
  db: SQLiteDatabase,
  rows: number,
): Promise<ReactNativeBenchmarkWorkload> {
  let responseBytes = 0;
  const latency = await measureLatency(20, async () => {
    const result = await db.getAllAsync<{ id: number; label: string; payload: string }>(
      `SELECT id, label, payload
       FROM rn_bench_events
       ORDER BY id
       LIMIT ?`,
      rows,
    );
    responseBytes = JSON.stringify(result).length;
  });
  return {
    id: 'sqlite_large_result',
    description: 'SQLite large result transfer through expo-sqlite row objects',
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

function throughput(rows: number, totalMs: number): ThroughputSummary {
  return {
    rows,
    totalMs,
    rowsPerSecond: rows / (totalMs / 1_000),
  };
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
