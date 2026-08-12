import { PGlite } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import Oliphaunt from '@oliphaunt/wasix';

type QueryParameters = readonly (null | string | number | boolean)[];

type BenchDatabase = {
  version: string;
  query(sql: string, parameters?: QueryParameters): Promise<unknown>;
  consume(result: unknown): number;
  close(): Promise<void>;
};

type OpenResult = {
  database: BenchDatabase;
  readyMs: number;
};

type Engine = {
  name: 'wasix' | 'pgliteWorker' | 'pgliteDirect';
  open(): Promise<OpenResult>;
};

type WorkloadRun = { postgresVersion: string } & Record<string, string | number>;

type PGliteAssets = {
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
};

const status = requireElement<HTMLParagraphElement>('status');
const output = requireElement<HTMLPreElement>('output');
const quick = new URL(location.href).searchParams.has('quick');
const startupRuns = quick ? 2 : 5;
const workloadRuns = quick ? 1 : 5;
const targetPercent = 25;
let pgliteAssetsPromise: Promise<PGliteAssets> | undefined;

const engines: Engine[] = [
  { name: 'wasix', open: openWasix },
  { name: 'pgliteWorker', open: openPGliteWorker },
  { name: 'pgliteDirect', open: openPGliteDirect },
];

document.documentElement.dataset.oliphauntSmoke = 'running';
status.textContent = 'Running worker-for-worker browser benchmarks…';

try {
  const startup = await measureStartup();
  const workload = await measureWorkloads();
  const summary = summarizeResults(startup, workload);
  const result = {
    benchmark: 'oliphaunt-wasix-vs-pglite-worker-v1',
    measuredAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: globalThis.crossOriginIsolated,
    },
    configuration: {
      primaryTopology: 'dedicated Web Worker per database',
      directPGliteControl: true,
      storage: 'ephemeral memory',
      targetPercent,
      startupRuns,
      workloadRuns,
      rows: 10_000,
      pointSamples: 200,
      rangeSamples: 50,
      aggregateSamples: 30,
    },
    summary,
    samples: { startup, workload },
  };

  output.textContent = JSON.stringify(result);
  status.textContent = 'Benchmark passed.';
  document.documentElement.dataset.oliphauntSmoke = 'passed';
} catch (error) {
  output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  status.textContent = 'Benchmark failed.';
  document.documentElement.dataset.oliphauntSmoke = 'failed';
}

async function measureStartup(): Promise<Record<Engine['name'], number[]>> {
  const samples = emptySamples<number>();
  for (let run = 0; run < startupRuns; run += 1) {
    for (const engine of orderedEngines(run)) {
      status.textContent = `Startup ${run + 1}/${startupRuns}: ${engine.name}`;
      const opened = await engine.open();
      samples[engine.name].push(round(opened.readyMs));
      await opened.database.close();
    }
  }
  return samples;
}

async function measureWorkloads(): Promise<Record<Engine['name'], WorkloadRun[]>> {
  const samples = emptySamples<WorkloadRun>();
  for (let run = 0; run < workloadRuns; run += 1) {
    for (const engine of orderedEngines(run + 1)) {
      status.textContent = `Workload ${run + 1}/${workloadRuns}: ${engine.name}`;
      samples[engine.name].push(await runWorkload(engine.open));
    }
  }
  return samples;
}

function orderedEngines(run: number): Engine[] {
  const offset = run % engines.length;
  return [...engines.slice(offset), ...engines.slice(0, offset)];
}

async function runWorkload(open: () => Promise<OpenResult>): Promise<WorkloadRun> {
  const opened = await open();
  const database = opened.database;
  try {
    const createTableMs = await elapsed(() =>
      database.query('CREATE TABLE bench (id integer PRIMARY KEY, payload text NOT NULL)'),
    );
    const insert10kMs = await elapsed(() =>
      database.query(
        'INSERT INTO bench SELECT i, repeat(md5(i::text), 2) FROM generate_series(1, 10000) AS series(i)',
      ),
    );
    await database.query('ANALYZE bench');

    for (let index = 1; index <= 20; index += 1) {
      const result = await database.query('SELECT id, payload FROM bench WHERE id = $1', [index]);
      requireChecksum(database.consume(result), 'point query warmup');
    }
    const point = await samples(200, async (index) => {
      const result = await database.query('SELECT id, payload FROM bench WHERE id = $1', [
        ((index * 7919) % 10_000) + 1,
      ]);
      requireChecksum(database.consume(result), 'point query');
    });

    const range = await samples(50, async (index) => {
      const result = await database.query(
        'SELECT id, payload FROM bench WHERE id >= $1 ORDER BY id LIMIT 100',
        [((index * 193) % 9_900) + 1],
      );
      requireChecksum(database.consume(result), 'indexed range query');
    });

    for (let index = 0; index < 3; index += 1) {
      const result = await database.query(
        'SELECT 1 AS id, sum(id)::text AS payload FROM bench WHERE id % 7 = 0',
      );
      requireChecksum(database.consume(result), 'aggregate query warmup');
    }
    const aggregate = await samples(30, async () => {
      const result = await database.query(
        'SELECT 1 AS id, sum(id)::text AS payload FROM bench WHERE id % 7 = 0',
      );
      requireChecksum(database.consume(result), 'aggregate query');
    });

    const scanAndDecode10kMs = await elapsed(async () => {
      const result = await database.query('SELECT id, payload FROM bench ORDER BY id');
      requireChecksum(database.consume(result), '10k row scan');
    });

    const transactionInsert100Ms = await elapsed(async () => {
      await database.query('BEGIN');
      for (let index = 1; index <= 100; index += 1) {
        await database.query('INSERT INTO bench VALUES ($1, $2)', [
          10_000 + index,
          `batch-${index}`,
        ]);
      }
      await database.query('COMMIT');
    });

    const update1kMs = await elapsed(() =>
      database.query("UPDATE bench SET payload = payload || 'x' WHERE id <= 1000"),
    );
    const delete1kMs = await elapsed(() => database.query('DELETE FROM bench WHERE id <= 1000'));

    const closeStarted = performance.now();
    await database.close();
    const closeMs = performance.now() - closeStarted;

    return {
      postgresVersion: database.version,
      readyMs: round(opened.readyMs),
      createTableMs: round(createTableMs),
      insert10kMs: round(insert10kMs),
      pointMedianMs: round(median(point)),
      pointP95Ms: round(quantile(point, 0.95)),
      range100MedianMs: round(median(range)),
      range100P95Ms: round(quantile(range, 0.95)),
      aggregateMedianMs: round(median(aggregate)),
      aggregateP95Ms: round(quantile(aggregate, 0.95)),
      scanAndDecode10kMs: round(scanAndDecode10kMs),
      transactionInsert100Ms: round(transactionInsert100Ms),
      update1kMs: round(update1kMs),
      delete1kMs: round(delete1kMs),
      closeMs: round(closeMs),
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

function summarizeResults(
  startup: Record<Engine['name'], number[]>,
  workload: Record<Engine['name'], WorkloadRun[]>,
): Record<string, unknown> {
  const startupSummary = {
    firstReadyMs: comparisons(startup.wasix[0], startup.pgliteWorker[0], startup.pgliteDirect[0]),
    warmReadyMs: comparisons(
      median(startup.wasix.slice(1)),
      median(startup.pgliteWorker.slice(1)),
      median(startup.pgliteDirect.slice(1)),
    ),
  };
  const metrics = Object.keys(workload.wasix[0] ?? {}).filter((key) => key !== 'postgresVersion');
  const workloadSummary = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      comparisons(
        median(workload.wasix.map((run) => requireNumber(run[metric], metric))),
        median(workload.pgliteWorker.map((run) => requireNumber(run[metric], metric))),
        median(workload.pgliteDirect.map((run) => requireNumber(run[metric], metric))),
      ),
    ]),
  );
  return { startup: startupSummary, workload: workloadSummary };
}

function comparison(wasixMs: number | undefined, pgliteMs: number | undefined) {
  if (wasixMs === undefined || pgliteMs === undefined) {
    return { wasixMs: null, pgliteMs: null, advantagePercent: null, meetsTarget: null };
  }
  const advantagePercent = ((pgliteMs - wasixMs) / pgliteMs) * 100;
  return {
    wasixMs: round(wasixMs),
    pgliteMs: round(pgliteMs),
    advantagePercent: round(advantagePercent),
    meetsTarget: advantagePercent >= targetPercent,
  };
}

function comparisons(
  wasixMs: number | undefined,
  pgliteWorkerMs: number | undefined,
  pgliteDirectMs: number | undefined,
) {
  return {
    versusWorker: comparison(wasixMs, pgliteWorkerMs),
    versusDirectControl: comparison(wasixMs, pgliteDirectMs),
  };
}

async function openWasix(): Promise<OpenResult> {
  const started = performance.now();
  const database = await Oliphaunt.open();
  const versionResult = await database.query(
    "SELECT current_setting('server_version') AS server_version",
  );
  const version = versionResult.getText(0, 'server_version') ?? 'unknown';
  return {
    readyMs: performance.now() - started,
    database: {
      version,
      query: (sql, parameters = []) => database.query(sql, parameters),
      consume(result) {
        const query = result as Awaited<ReturnType<typeof database.query>>;
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
  const database = new PGliteWorker(worker, assets);
  const versionResult = await database.query<{ server_version: string }>(
    "SELECT current_setting('server_version') AS server_version",
  );
  const version = versionResult.rows[0]?.server_version ?? 'unknown';
  return {
    readyMs: performance.now() - started,
    database: {
      version,
      query: (sql, parameters = []) => database.query(sql, [...parameters]),
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

async function openPGliteDirect(): Promise<OpenResult> {
  const started = performance.now();
  const database = await PGlite.create(await pgliteAssets());
  const versionResult = await database.query<{ server_version: string }>(
    "SELECT current_setting('server_version') AS server_version",
  );
  const version = versionResult.rows[0]?.server_version ?? 'unknown';
  return {
    readyMs: performance.now() - started,
    database: pgliteAdapter(database, version),
  };
}

function pgliteAdapter(database: Pick<PGlite, 'query' | 'close'>, version: string): BenchDatabase {
  return {
    version,
    query: (sql, parameters = []) => database.query(sql, [...parameters]),
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
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
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
  return { wasix: [], pgliteWorker: [], pgliteDirect: [] };
}

function requireNumber(value: string | number | undefined, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${label} did not produce a numeric sample`);
  }
  return value;
}

function requireChecksum(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} produced an invalid checksum ${value}`);
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
