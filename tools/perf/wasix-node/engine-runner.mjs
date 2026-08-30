import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  assertExpectedRawProtocolResponse,
  assertExpectedResult,
  bulkSql,
  canonicalResult,
  expandExpectedResult,
  expectedBulkProtocol,
  findPackageManifest,
  latencySummary,
  loadPlan,
  sha256,
  simpleQueryMessage,
  stableJson,
} from './plan.mjs';

const args = parseArguments(process.argv.slice(2));
const source = await loadPlan(args.plan);
const expectedStream = createHash('sha256');
const responseStream = createHash('sha256');
let database;

try {
  const opened = await timed(() => openEngine(args.engine, source.plan, args.candidateRoot));
  database = opened.value;
  const first = await database.measureQuery(source.plan.firstQuery.sql, []);
  const firstExpectedSha256 = recordResult(
    first.result,
    source.plan.firstQuery.expectedResult,
    'first query',
  );
  const postgres = await postgresMetadata(database, source.plan);

  await database.execute(source.plan.warmSetupSql);
  const warmRtt = [];
  for (const benchmark of source.plan.warmRtt) {
    const expectedHash = createHash('sha256');
    const responseHash = createHash('sha256');
    const samples = [];
    const total =
      source.plan.measurement.warmupIterations + source.plan.measurement.sampleIterations;
    for (let iteration = 0; iteration < total; iteration += 1) {
      const measured = await database.measureQuery(benchmark.sql, benchmark.parameters);
      const expected = expectedWarmResult(benchmark, iteration);
      assertExpectedResult(
        measured.result,
        expected,
        `warm RTT ${benchmark.id} iteration ${iteration}`,
      );
      recordStream(expectedHash, expected);
      recordStream(responseHash, measured.result);
      recordStream(expectedStream, expected);
      recordStream(responseStream, measured.result);
      if (iteration >= source.plan.measurement.warmupIterations) {
        samples.push(measured.elapsedMs);
      }
    }
    warmRtt.push({
      id: benchmark.id,
      latency: latencySummary(samples, source.plan.measurement.trimFraction),
      correctness: {
        expectedSha256: expectedHash.digest('hex'),
        responseSha256: responseHash.digest('hex'),
      },
    });
  }

  const warmValidationExpected = expandExpectedResult(source.plan.warmValidation.expectedResult, {
    $totalIterations:
      source.plan.measurement.warmupIterations + source.plan.measurement.sampleIterations,
  });
  const warmValidation = await database.query(source.plan.warmValidation.sql, []);
  const warmValidationSha256 = recordResult(
    warmValidation,
    warmValidationExpected,
    'warm fixture validation',
  );

  const bulk = [];
  for (const benchmark of source.plan.bulk) {
    const sql = bulkSql(benchmark);
    const measured = await database.measureRawProtocol(simpleQueryMessage(sql));
    const expectedProtocol = expectedBulkProtocol(benchmark);
    const protocolOutcome = assertExpectedRawProtocolResponse(
      measured.response,
      expectedProtocol,
      `bulk ${benchmark.id}`,
    );
    recordStream(expectedStream, expectedProtocol);
    recordStream(responseStream, protocolOutcome);
    const result = await database.query(benchmark.validationSql ?? sql, []);
    const expectedSha256 = recordResult(result, benchmark.expectedResult, `bulk ${benchmark.id}`);
    bulk.push({
      id: benchmark.id,
      elapsedMs: measured.elapsedMs,
      correctness: {
        expectedSha256,
        protocolExpectedSha256: sha256(stableJson(expectedProtocol)),
        protocolOutcomeSha256: sha256(stableJson(protocolOutcome)),
        protocolResponseSha256: sha256(measured.response),
        responseSha256: sha256(stableJson(result)),
      },
    });
  }

  const expectedSha256 = expectedStream.digest('hex');
  const responseSha256 = responseStream.digest('hex');
  const correctness = {
    passed: expectedSha256 === responseSha256,
    expectedSha256,
    responseSha256,
    firstQuerySha256: firstExpectedSha256,
    warmValidationSha256,
  };
  if (!correctness.passed) throw new Error('correctness result-stream hashes differ');

  const report = {
    schema: 'oliphaunt-wasix-node-engine-run-v2',
    plan: { id: source.plan.id, sha256: source.sha256 },
    engine: database.identity,
    repeat: args.repeat,
    process: { pid: process.pid, node: process.version },
    postgres,
    timings: {
      openMs: opened.elapsedMs,
      firstQueryMs: first.elapsedMs,
      coldToFirstResultMs: opened.elapsedMs + first.elapsedMs,
      warmRtt,
      bulk,
    },
    correctness,
  };
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(`wasix-node engine run: PASS ${args.engine} repeat ${args.repeat}`);
} finally {
  await database?.close();
}

async function openEngine(engine, plan, candidateRoot) {
  if (engine === 'candidate-direct') return openCandidate(plan, candidateRoot, 'direct');
  if (engine === 'candidate-worker') return openCandidate(plan, candidateRoot, 'worker');
  if (engine === 'comparison-direct') return openComparisonCallerRealm(plan);
  if (engine === 'comparison-worker') return openComparisonWorker(plan);
  throw new Error(`unsupported benchmark engine ${JSON.stringify(engine)}`);
}

async function openCandidate(plan, candidateRoot, surfaceName) {
  if (candidateRoot === undefined)
    throw new Error('--candidate-root is required for candidate runs');
  const require = createRequire(resolve(candidateRoot, 'package.json'));
  const surface = plan.engines.candidate.surfaces[surfaceName];
  const entry = require.resolve(surface.entrypoint);
  const { manifest } = await findPackageManifest(entry, plan.engines.candidate.package);
  const expectedFile = surfaceName === 'worker' ? 'worker-entry.node.js' : 'direct.node.js';
  if (!entry.split('\\').join('/').endsWith(`/lib/${expectedFile}`)) {
    throw new Error(
      `${surface.entrypoint} resolved ${entry}, expected the conditional Node entrypoint lib/${expectedFile}`,
    );
  }
  const module = await import(pathToFileURL(entry).href);
  const client = module.default;
  if (typeof client?.open !== 'function') {
    throw new Error(`${plan.engines.candidate.package} has no default open() client`);
  }
  if (typeof module.memory !== 'function') {
    throw new Error(`${plan.engines.candidate.package} has no explicit memory storage selector`);
  }
  const instance = await client.open({
    storage: module.memory(),
  });
  return {
    identity: {
      kind: surface.engine,
      package: manifest.name,
      version: manifest.version,
      resolvedEntry: relative(candidateRoot, entry).split('\\').join('/'),
      entrypoint: surface.entrypoint,
      callingContract: surface.callingContract,
      executionOwner: surface.executionOwner,
      executionBoundary: surface.executionBoundary,
      isolationImplementation: surface.isolationImplementation,
      timingBoundary: surface.timingBoundary,
      storage: plan.engines.candidate.storage,
    },
    query: async (sql, parameters) =>
      canonicalCandidate(
        await instance.query(sql, parameters, { rowMode: 'array', valueMode: 'text' }),
      ),
    execute: (sql) => instance.execute(sql),
    measureQuery: async (sql, parameters) => {
      const measured = await timed(() =>
        instance.query(sql, parameters, { rowMode: 'array', valueMode: 'text' }),
      );
      return { result: canonicalCandidate(measured.value), elapsedMs: measured.elapsedMs };
    },
    measureRawProtocol: async (input) => {
      const measured = await timed(() => instance.execProtocolRaw(input));
      return { response: measured.value, elapsedMs: measured.elapsedMs };
    },
    close: () => instance.close(),
  };
}

async function openComparisonWorker(plan) {
  const surface = plan.engines.comparison.surfaces.worker;
  const resolved = await comparisonPackage(plan);
  const rpc = benchmarkWorkerRpc(
    new Worker(new URL('./pglite-node-worker.mjs', import.meta.url), {
      name: 'oliphaunt-pglite-benchmark',
    }),
  );
  await rpc.ready;
  return {
    identity: {
      kind: surface.engine,
      package: resolved.manifest.name,
      version: resolved.manifest.version,
      resolvedEntry: resolved.entry,
      entrypoint: surface.entrypoint,
      callingContract: surface.callingContract,
      executionOwner: surface.executionOwner,
      executionBoundary: surface.executionBoundary,
      isolationImplementation: surface.isolationImplementation,
      isolationAdapter: 'tools/perf/wasix-node/pglite-node-worker.mjs',
      timingBoundary: surface.timingBoundary,
      storage: plan.engines.comparison.storage,
    },
    query: async (sql, parameters) =>
      canonicalComparison((await rpc.request('query', [sql, parameters])).result),
    execute: async (sql) => {
      await rpc.request('execute', [sql]);
    },
    measureQuery: async (sql, parameters) => {
      const measured = await timed(() => rpc.request('query', [sql, parameters]));
      return {
        result: canonicalComparison(measured.value.result),
        elapsedMs: measured.elapsedMs,
      };
    },
    measureRawProtocol: async (input) => {
      const measured = await timed(() =>
        rpc.request('rawProtocol', [input, plan.bulkTransport.pgliteSyncToFs], [input.buffer]),
      );
      return {
        response: measured.value.response,
        elapsedMs: measured.elapsedMs,
      };
    },
    close: () => rpc.close(),
  };
}

async function openComparisonCallerRealm(plan) {
  const surface = plan.engines.comparison.surfaces.callerRealm;
  const resolved = await comparisonPackage(plan);
  const { PGlite } = await import(plan.engines.comparison.package);
  const instance = await PGlite.create('memory://');
  return {
    identity: {
      kind: surface.engine,
      package: resolved.manifest.name,
      version: resolved.manifest.version,
      resolvedEntry: resolved.entry,
      entrypoint: surface.entrypoint,
      callingContract: surface.callingContract,
      executionOwner: surface.executionOwner,
      executionBoundary: surface.executionBoundary,
      isolationImplementation: surface.isolationImplementation,
      timingBoundary: surface.timingBoundary,
      storage: plan.engines.comparison.storage,
    },
    query: async (sql, parameters) => canonicalComparison(await instance.query(sql, parameters)),
    execute: (sql) => instance.exec(sql),
    measureQuery: async (sql, parameters) => {
      const measured = await timed(() => instance.query(sql, parameters));
      return { result: canonicalComparison(measured.value), elapsedMs: measured.elapsedMs };
    },
    measureRawProtocol: async (input) => {
      const measured = await timed(() =>
        instance.execProtocolRaw(input, { syncToFs: plan.bulkTransport.pgliteSyncToFs }),
      );
      return { response: measured.value, elapsedMs: measured.elapsedMs };
    },
    close: () => instance.close(),
  };
}

async function comparisonPackage(plan) {
  const require = createRequire(import.meta.url);
  const requireEntry = require.resolve(plan.engines.comparison.package);
  const { file: manifestFile, manifest } = await findPackageManifest(
    requireEntry,
    plan.engines.comparison.package,
  );
  if (manifest.version !== plan.engines.comparison.version) {
    throw new Error(
      `${plan.engines.comparison.package} resolved ${manifest.version}, expected ${plan.engines.comparison.version}`,
    );
  }
  const resolvedEntry = fileURLToPath(import.meta.resolve(plan.engines.comparison.package));
  return {
    manifest,
    entry: relative(dirname(manifestFile), resolvedEntry).split('\\').join('/'),
  };
}

function benchmarkWorkerRpc(worker) {
  let closing = false;
  let nextId = 1;
  let terminalError;
  let resolveReady;
  let rejectReady;
  const pending = new Map();
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  worker.on('message', (message) => {
    if (message?.type === 'ready') {
      resolveReady();
      return;
    }
    if (message?.type !== 'response') return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    if (message.error === undefined) {
      request.resolve(message.result);
    } else {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      error.stack = message.error.stack;
      request.reject(error);
    }
  });
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!closing) fail(new Error(`PGlite benchmark worker exited with code ${code}`));
  });

  function fail(error) {
    terminalError ??= error;
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function request(method, args, transfer = []) {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    if (closing) return Promise.reject(new Error('PGlite benchmark worker is closing'));
    const id = nextId;
    nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      worker.postMessage({ id, method, args }, transfer);
    });
  }

  return {
    ready,
    request,
    async close() {
      const closed = request('close', []);
      closing = true;
      try {
        await closed;
      } finally {
        await worker.terminate();
      }
    },
  };
}

function canonicalCandidate(result) {
  return canonicalResult(
    result.fields.map((field) => field.name),
    result.rows.map((row) => [...row]),
  );
}

function canonicalComparison(result) {
  const fields = result.fields.map((field) => field.name);
  return canonicalResult(
    fields,
    result.rows.map((row) =>
      Array.isArray(row) ? row : fields.map((field) => row[field] ?? null),
    ),
  );
}

async function postgresMetadata(database, plan) {
  const settingColumns = plan.postgres.settings
    .map((setting) => `current_setting('${setting}')::text AS ${setting}`)
    .join(', ');
  const result = await database.query(`SELECT version()::text AS version, ${settingColumns}`, []);
  const version = result.rows[0]?.[0];
  if (typeof version !== 'string' || !version.startsWith(`PostgreSQL ${plan.postgres.major}.`)) {
    throw new Error(
      `engine reported ${JSON.stringify(version)}, expected PostgreSQL ${plan.postgres.major}`,
    );
  }
  return {
    version,
    settings: Object.fromEntries(
      plan.postgres.settings.map((setting, index) => [setting, result.rows[0][index + 1]]),
    ),
  };
}

function expectedWarmResult(benchmark, iteration) {
  if (benchmark.expectation.kind === 'exact') return benchmark.expectation.result;
  return {
    fields: [benchmark.expectation.field],
    rows: [[String(iteration + 1)]],
  };
}

function recordResult(actual, expected, label) {
  const expectedSha256 = assertExpectedResult(actual, expected, label);
  recordStream(expectedStream, expected);
  recordStream(responseStream, actual);
  return expectedSha256;
}

function recordStream(hash, result) {
  hash.update(stableJson(result));
  hash.update('\n');
}

async function timed(operation) {
  const started = process.hrtime.bigint();
  const value = await operation();
  const ended = process.hrtime.bigint();
  return { value, elapsedMs: Number(ended - started) / 1_000_000 };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--candidate-root', '--engine', '--output', '--plan', '--repeat'].includes(flag)) {
      throw new Error(`unknown engine runner option ${JSON.stringify(flag)}`);
    }
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (values[flag] !== undefined) throw new Error(`${flag} may only be provided once`);
    values[flag] = value;
  }
  if (
    !['candidate-direct', 'candidate-worker', 'comparison-direct', 'comparison-worker'].includes(
      values['--engine'],
    )
  ) {
    throw new Error(
      '--engine must be candidate-direct, candidate-worker, comparison-direct, or comparison-worker',
    );
  }
  const repeat = Number(values['--repeat']);
  if (!Number.isSafeInteger(repeat) || repeat < 0) {
    throw new Error('--repeat must be a non-negative integer');
  }
  if (values['--output'] === undefined) throw new Error('--output is required');
  return {
    engine: values['--engine'],
    output: resolve(values['--output']),
    plan: values['--plan'] === undefined ? undefined : resolve(values['--plan']),
    repeat,
    candidateRoot:
      values['--candidate-root'] === undefined ? undefined : resolve(values['--candidate-root']),
  };
}
