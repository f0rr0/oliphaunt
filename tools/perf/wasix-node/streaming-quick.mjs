import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import { createPackedWasixConsumer } from '../../../src/bindings/wasix-ts/tools/packed-node-fixture.mjs';
import {
  connect,
  onceClosed,
  onceConnected,
  readExchange,
  simpleQuery,
  startupPacket,
} from '../../../src/bindings/wasix-ts/tools/pgwire-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const execFileAsync = promisify(execFile);
const benchmarkOptions = parseArguments(process.argv.slice(2));
const roundTripWarmups = 10;
const roundTripSamples = benchmarkOptions.full ? 200 : 100;
const bulkSizesMiB = benchmarkOptions.full ? [1 / 1024, 1, 64] : [1 / 1024, 1, 4];
const inputSizesMiB = benchmarkOptions.full ? [1 / 1024, 1, 64] : [1 / 1024, 1, 4];
const activeDatabaseCounts = benchmarkOptions.full ? [1, 4, 16] : [1, 4];
const overloadConcurrency = benchmarkOptions.full ? 16 : 4;
const overloadInputMiB = benchmarkOptions.full ? 4 : 1;
const slowConsumerDelayMs = 1;
const toolRows = 4_096;
const started = performance.now();

await requireInputs();
const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-streaming-quick-'));
const rssSampler = await openRssSampler().catch(async (error) => {
  await rm(scratch, { force: true, recursive: true });
  throw error;
});

try {
  const fixture = await createBenchmarkFixture({
    scratch,
    consumerName: 'oliphaunt-wasix-streaming-quick-consumer',
    includeTools: true,
  });
  const provenance = await benchmarkProvenance(fixture.packages);
  const fixtureRequire = createRequire(resolve(fixture.consumer, 'package.json'));
  const bindingName = fixture.packages.binding.name;
  const { default: ActorOliphaunt } = await importPackedEntrypoint(
    fixtureRequire,
    bindingName,
    '/lib/index.node.js',
  );
  const { default: DirectOliphaunt } = await importPackedEntrypoint(
    fixtureRequire,
    `${bindingName}/direct`,
    '/lib/direct.node.js',
  );
  const { default: WorkerOliphaunt } = await importPackedEntrypoint(
    fixtureRequire,
    `${bindingName}/worker`,
    '/lib/worker-entry.node.js',
  );
  const { openServer } = await importPackedEntrypoint(
    fixtureRequire,
    `${bindingName}/server`,
    '/lib/server.node.js',
  );
  const { pgDump, psql } = await importPackedEntrypoint(
    fixtureRequire,
    fixture.packages.toolsFacade.name,
    '/lib/index.js',
  );

  const surfaces = {
    actor: await benchmarkSurface(ActorOliphaunt, 'actor'),
    direct: await benchmarkSurface(DirectOliphaunt, 'direct'),
    worker: await benchmarkSurface(WorkerOliphaunt, 'worker'),
  };
  const server = await benchmarkServer(openServer);
  const tools = await benchmarkTools(ActorOliphaunt, pgDump, psql);
  const fanout = await benchmarkDatabaseFanout(ActorOliphaunt);
  const overload = await benchmarkActorOverload(ActorOliphaunt);
  const report = {
    schema: 'oliphaunt-wasix-placement-quick-v3',
    measuredAt: new Date().toISOString(),
    durationMs: rounded(performance.now() - started),
    provenance,
    environment: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
    },
    configuration: {
      roundTripWarmups,
      roundTripSamples,
      bulkSizesMiB,
      inputSizesMiB,
      activeDatabaseCounts,
      overloadConcurrency,
      overloadInputMiB,
      slowConsumerDelayMs,
      toolRows,
      storage: 'memory',
      executionSurfaces: {
        actor: {
          entrypoint: '@oliphaunt/wasix-ts',
          callingContract: 'async',
          executionOwner: 'rust-owner-thread',
        },
        direct: {
          entrypoint: '@oliphaunt/wasix-ts/direct',
          callingContract: 'async',
          executionOwner: 'caller',
        },
        worker: {
          entrypoint: '@oliphaunt/wasix-ts/worker',
          callingContract: 'async',
          executionOwner: 'sdk-worker',
        },
      },
      resourceSamples: `representative ${bulkSizesMiB.at(-1)} MiB streams, data dump, and restore`,
      surfaceOrder: ['actor', 'direct', 'worker'],
      openCloseNote:
        'single sequential observations are descriptive and must not be used for placement comparisons',
      resourceNote:
        'RSS is process-wide growth from each scenario start; retained allocations can reduce later deltas',
    },
    surfaces,
    comparison: compareSurfaces(surfaces),
    server,
    tools,
    fanout,
    overload,
  };

  if (benchmarkOptions.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} finally {
  await Promise.all([
    rm(scratch, { force: true, recursive: true }),
    rssSampler.terminate().then(() => undefined),
  ]);
}

async function createBenchmarkFixture(options) {
  try {
    return await createPackedWasixConsumer(options);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (
      /native carrier|Node-API carrier|native artifact provenance|oliphaunt_wasix_napi|wasix-napi-/iu.test(
        detail,
      )
    ) {
      throw new Error(
        'WASIX placement benchmark requires one optimized current-host Node-API carrier. ' +
          'After staging the portable/AOT runtime, ICU, and extension inputs, run ' +
          '`bash src/runtimes/wasix-napi/tools/build-native.sh`, then retry. ' +
          `Carrier preflight: ${detail}`,
        { cause },
      );
    }
    throw cause;
  }
}

async function importPackedEntrypoint(fixtureRequire, specifier, expectedSuffix) {
  const entry = fixtureRequire.resolve(specifier);
  if (!entry.split('\\').join('/').endsWith(expectedSuffix)) {
    throw new Error(
      `${specifier} resolved ${entry}, expected packed entrypoint ${expectedSuffix.slice(1)}`,
    );
  }
  return import(pathToFileURL(entry).href);
}

async function benchmarkSurface(Oliphaunt, surface) {
  const opening = await timed(() => Oliphaunt.open());
  const database = opening.value;
  try {
    const query = await samples(async () => {
      const result = await database.query('SELECT 1::int AS value');
      if (result.rows[0]?.value !== 1) throw new Error('query benchmark returned wrong value');
    });
    const request = simpleQuery('SELECT 1');
    const expected = await database.execProtocolRaw(request);
    const rawBuffered = await samples(async () => {
      const response = await database.execProtocolRaw(request);
      if (response.length !== expected.length) throw new Error('buffered protocol size changed');
    });
    const rawStreamed = await samples(async () => {
      let bytes = 0;
      await database.execProtocolRawStream(request, (chunk) => {
        bytes += chunk.length;
      });
      if (bytes !== expected.length) throw new Error('streamed protocol size changed');
    });
    const largeInput = [];
    for (const sizeMiB of inputSizesMiB) {
      const input = simpleQuery(largeInputQuery(sizeMiB));
      const measured = await resourceTimed(() => database.execProtocolRaw(input));
      if (measured.value.length === 0) throw new Error(`${surface} large input returned no bytes`);
      largeInput.push({
        sizeMiB,
        requestBytes: input.length,
        responseBytes: measured.value.length,
        elapsedMs: rounded(measured.ms),
        resources: measured.resources,
      });
    }

    await consumeStream(database, copyQuery(0.25));
    const bulk = [];
    for (const sizeMiB of bulkSizesMiB) {
      const input = simpleQuery(copyQuery(sizeMiB));
      const expectedCopyBytes = sizeMiB * 1024 * 1024;
      const buffered = await timed(() => database.execProtocolRaw(input));
      if (buffered.value.length < expectedCopyBytes) {
        throw new Error(`${surface} buffered COPY response was truncated`);
      }
      const streamed =
        sizeMiB === bulkSizesMiB.at(-1)
          ? await resourceTimed(() => consumeStream(database, input))
          : await timed(() => consumeStream(database, input));
      if (streamed.value.bytes !== buffered.value.length) {
        throw new Error(`${surface} streamed COPY response differed from buffered response`);
      }
      bulk.push({
        sizeMiB,
        buffered: transferResult(buffered.value.length, buffered.ms),
        streamed: {
          ...transferResult(streamed.value.bytes, streamed.ms),
          chunks: streamed.value.chunks,
          ...('resources' in streamed ? { resources: streamed.resources } : {}),
        },
      });
    }

    let slowConsumer;
    if (surface !== 'direct') {
      const input = simpleQuery(copyQuery(1));
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const measured = await timed(async () => {
        let bytes = 0;
        let chunks = 0;
        await database.execProtocolRawStream(input, (chunk) => {
          bytes += chunk.length;
          chunks += 1;
          Atomics.wait(sleeper, 0, 0, slowConsumerDelayMs);
        });
        return { bytes, chunks };
      });
      slowConsumer = {
        delayPerChunkMs: slowConsumerDelayMs,
        chunks: measured.value.chunks,
        bytes: measured.value.bytes,
        elapsedMs: rounded(measured.ms),
        requestedDelayMs: rounded(measured.value.chunks * slowConsumerDelayMs),
      };
    }

    const closing = await timed(() => database.close());
    return {
      openMs: rounded(opening.ms),
      closeMs: rounded(closing.ms),
      smallRoundTripMs: { query, rawBuffered, rawStreamed },
      largeInput,
      bulk,
      ...(slowConsumer === undefined ? {} : { slowConsumer }),
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function benchmarkServer(openServer) {
  const opening = await timed(() => openServer({ listen: { transport: 'tcp' } }));
  const server = opening.value;
  const socket = connect(server.connectionString);
  try {
    const startup = await timed(async () => {
      await onceConnected(socket);
      const response = readExchange(socket);
      socket.write(startupPacket('postgres', 'postgres'));
      await response;
    });
    const roundTrip = await samples(async () => {
      const response = readExchange(socket);
      socket.write(simpleQuery('SELECT 1'));
      await response;
    });
    const bulk = [];
    for (const sizeMiB of bulkSizesMiB) {
      const response = readExchange(socket);
      const measured =
        sizeMiB === bulkSizesMiB.at(-1)
          ? await resourceTimed(async () => {
              socket.write(simpleQuery(copyQuery(sizeMiB)));
              return response;
            })
          : await timed(async () => {
              socket.write(simpleQuery(copyQuery(sizeMiB)));
              return response;
            });
      const expected = sizeMiB * 1024 * 1024;
      if (measured.value.copyBytes !== expected) {
        throw new Error(
          `server COPY returned ${measured.value.copyBytes} bytes, expected ${expected}`,
        );
      }
      bulk.push({
        sizeMiB,
        ...transferResult(measured.value.totalBytes, measured.ms),
        copyBytes: measured.value.copyBytes,
        messages: measured.value.messages,
        ...('resources' in measured ? { resources: measured.resources } : {}),
      });
    }
    socket.end(Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4));
    await onceClosed(socket);
    const closing = await timed(() => server.close());
    return {
      openMs: rounded(opening.ms),
      connectAndStartupMs: rounded(startup.ms),
      closeMs: rounded(closing.ms),
      smallRoundTripMs: roundTrip,
      bulk,
    };
  } catch (error) {
    socket.destroy();
    await server.close().catch(() => undefined);
    throw error;
  }
}

async function benchmarkTools(Oliphaunt, pgDump, psql) {
  const source = await Oliphaunt.open();
  let dump;
  try {
    await source.execute(
      `CREATE TABLE quick_tool_data AS
       SELECT i::int AS id, repeat(md5(i::text), 8) AS payload
       FROM generate_series(1, ${toolRows}) AS values(i)`,
    );
    await source.execute('ALTER TABLE quick_tool_data ADD PRIMARY KEY (id)');
    const psqlCommand = await timed(() => psql(source, { command: 'SELECT 1' }));
    const schemaDump = await timed(() => pgDump(source, { args: ['--schema-only'] }));
    const dataDump = await resourceTimed(() => pgDump(source));
    dump = dataDump.value;
    if (!dump.includes('COPY public.quick_tool_data')) {
      throw new Error('tool benchmark pg_dump did not use standard COPY output');
    }
    return {
      psqlCommandMs: rounded(psqlCommand.ms),
      schemaDump: textResult(schemaDump.value, schemaDump.ms),
      dataDump: { ...textResult(dataDump.value, dataDump.ms), resources: dataDump.resources },
      restore: await benchmarkRestore(Oliphaunt, psql, dump),
    };
  } finally {
    await source.close();
  }
}

async function benchmarkDatabaseFanout(Oliphaunt) {
  const results = [];
  for (const count of activeDatabaseCounts) {
    const measured = await resourceTimed(async () => {
      const databases = [];
      try {
        for (let index = 0; index < count; index += 1) {
          databases.push(await Oliphaunt.open());
        }
        await Promise.all(
          databases.map(async (database) => {
            const result = await database.query('SELECT 1::int AS value');
            if (result.rows[0]?.value !== 1)
              throw new Error('fanout database returned wrong value');
          }),
        );
      } finally {
        await Promise.all(databases.map((database) => database.close().catch(() => undefined)));
      }
    });
    results.push({ count, elapsedMs: rounded(measured.ms), resources: measured.resources });
  }
  return results;
}

async function benchmarkActorOverload(Oliphaunt) {
  const database = await Oliphaunt.open();
  try {
    const input = simpleQuery(largeInputQuery(overloadInputMiB));
    const measured = await resourceTimed(async () => {
      const responses = await Promise.all(
        Array.from({ length: overloadConcurrency }, () => database.execProtocolRaw(input)),
      );
      if (responses.some((response) => response.length === 0)) {
        throw new Error('actor overload request returned an empty response');
      }
      return responses.reduce((sum, response) => sum + response.length, 0);
    });
    return {
      concurrency: overloadConcurrency,
      inputBytesPerCall: input.length,
      queuedInputMiB: rounded((input.length * overloadConcurrency) / (1024 * 1024)),
      responseBytes: measured.value,
      elapsedMs: rounded(measured.ms),
      resources: measured.resources,
    };
  } finally {
    await database.close();
  }
}

async function benchmarkRestore(Oliphaunt, psql, dump) {
  const target = await Oliphaunt.open();
  try {
    const restored = await resourceTimed(() => psql(target, { script: dump }));
    const rows = Number(
      (await target.query('SELECT count(*)::int AS rows FROM quick_tool_data')).rows[0]?.rows,
    );
    if (rows !== toolRows) throw new Error(`psql restored ${rows} rows, expected ${toolRows}`);
    return { elapsedMs: rounded(restored.ms), rows, resources: restored.resources };
  } finally {
    await target.close();
  }
}

async function samples(operation) {
  for (let index = 0; index < roundTripWarmups; index += 1) await operation();
  const values = [];
  for (let index = 0; index < roundTripSamples; index += 1) {
    values.push((await timed(operation)).ms);
  }
  values.sort((left, right) => left - right);
  return {
    median: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    p99: rounded(percentile(values, 0.99)),
    min: rounded(values[0]),
    max: rounded(values.at(-1)),
  };
}

async function timed(operation) {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

async function resourceTimed(operation) {
  const intervalMs = 2;
  let next = performance.now() + intervalMs;
  let maxEventLoopDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - next);
    next = now + intervalMs;
  }, intervalMs);
  await delay(intervalMs * 2);
  maxEventLoopDelayMs = 0;
  next = performance.now() + intervalMs;
  const rssStartBytes = process.memoryUsage.rss();
  rssSampler.reset(rssStartBytes);
  try {
    const measured = await timed(operation);
    await delay(intervalMs * 2);
    const peakRssBytes = rssSampler.peakBytes();
    return {
      ...measured,
      resources: {
        maxEventLoopDelayMs: rounded(maxEventLoopDelayMs),
        rssStartMiB: rounded(rssStartBytes / (1024 * 1024)),
        peakRssMiB: rounded(peakRssBytes / (1024 * 1024)),
        rssGrowthMiB: rounded(Math.max(0, peakRssBytes - rssStartBytes) / (1024 * 1024)),
      },
    };
  } finally {
    clearInterval(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function consumeStream(database, input) {
  const request = typeof input === 'string' ? simpleQuery(input) : input;
  let bytes = 0;
  let chunks = 0;
  await database.execProtocolRawStream(request, (chunk) => {
    bytes += chunk.length;
    chunks += 1;
  });
  return { bytes, chunks };
}

function copyQuery(sizeMiB) {
  const rows = Math.max(1, Math.round(sizeMiB * 1024));
  return `COPY (SELECT repeat('x', 1023) FROM generate_series(1, ${rows})) TO STDOUT`;
}

function largeInputQuery(sizeMiB) {
  const bytes = Math.max(1, Math.round(sizeMiB * 1024 * 1024));
  return `SELECT 1 /*${'x'.repeat(bytes)}*/`;
}

function transferResult(bytes, milliseconds) {
  return {
    bytes,
    elapsedMs: rounded(milliseconds),
    mebibytesPerSecond: rounded(bytes / (1024 * 1024) / (milliseconds / 1000)),
  };
}

function textResult(value, milliseconds) {
  return {
    bytes: Buffer.byteLength(value),
    elapsedMs: rounded(milliseconds),
  };
}

function compareSurfaces(surfaces) {
  const direct = surfaces.direct.smallRoundTripMs;
  return Object.fromEntries(
    ['query', 'rawBuffered', 'rawStreamed'].map((name) => [
      name,
      Object.fromEntries(
        ['actor', 'worker'].map((surface) => [
          surface,
          {
            minusDirectMedianMs: rounded(
              surfaces[surface].smallRoundTripMs[name].median - direct[name].median,
            ),
            toDirectMedianRatio: rounded(
              surfaces[surface].smallRoundTripMs[name].median / direct[name].median,
            ),
          },
        ]),
      ),
    ]),
  );
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  if (!Number.isFinite(value)) throw new Error(`benchmark produced non-finite value ${value}`);
  return Number(value.toFixed(3));
}

async function benchmarkProvenance(packages) {
  const artifact = packages.nativeCarrier?.artifactProvenance;
  if (artifact === undefined) throw new Error('placement benchmark has no native carrier metadata');
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
  });
  const sourceSha = stdout.trim();
  if (artifact.artifactSourceSha !== sourceSha) {
    throw new Error(
      `placement benchmark native carrier source is ${artifact.artifactSourceSha}, expected current HEAD ${sourceSha}; ` +
        'rebuild it with `bash src/runtimes/wasix-napi/tools/build-native.sh`',
    );
  }
  return {
    binding: {
      package: packages.binding.name,
      version: packages.binding.version,
      archiveSha256: packages.binding.sha256,
    },
    runtime: {
      package: packages.runtime.name,
      version: packages.runtime.version,
      archiveSha256: packages.runtime.sha256,
      buildProfileSha256: packages.runtime.build?.buildProfile?.sha256,
    },
    nativeCarrier: {
      package: packages.nativeCarrier.name,
      version: packages.nativeCarrier.version,
      target: packages.nativeCarrier.target,
      archiveSha256: packages.nativeCarrier.sha256,
      binarySha256: artifact.binary.sha256,
      artifactSourceSha: artifact.artifactSourceSha,
      build: artifact.build,
    },
  };
}

function printReport(report) {
  console.log(`WASIX streaming quick benchmark (${(report.durationMs / 1000).toFixed(1)}s)`);
  console.log(`Node ${report.environment.node} · ${report.environment.cpu}`);
  console.log(
    `${report.provenance.nativeCarrier.package} (${report.provenance.nativeCarrier.target}, ` +
      `${report.provenance.nativeCarrier.binarySha256.slice(0, 12)}, source ` +
      `${report.provenance.nativeCarrier.artifactSourceSha.slice(0, 12)})`,
  );
  console.log('\nSmall round-trip latency (median / p95 / p99 ms)');
  console.log('scenario             direct                  actor                   worker');
  for (const [label, name] of [
    ['query()', 'query'],
    ['raw buffered', 'rawBuffered'],
    ['raw streamed', 'rawStreamed'],
  ]) {
    const direct = report.surfaces.direct.smallRoundTripMs[name];
    const actor = report.surfaces.actor.smallRoundTripMs[name];
    const worker = report.surfaces.worker.smallRoundTripMs[name];
    console.log(
      `${label.padEnd(20)} ${formatPair(direct).padEnd(23)} ${formatPair(actor).padEnd(23)} ${formatPair(worker)}`,
    );
    console.log(
      `${''.padEnd(20)} actor ${formatDeltaMs(report.comparison[name].actor.minusDirectMedianMs)} (${report.comparison[name].actor.toDirectMedianRatio.toFixed(2)}x), ` +
        `worker ${formatDeltaMs(report.comparison[name].worker.minusDirectMedianMs)} (${report.comparison[name].worker.toDirectMedianRatio.toFixed(2)}x)`,
    );
  }
  console.log('\nBulk protocol transfer (MiB/s; elapsed ms)');
  for (const surface of ['direct', 'actor', 'worker']) {
    for (const row of report.surfaces[surface].bulk) {
      console.log(
        `${surface.padEnd(8)} ${String(row.sizeMiB).padStart(2)} MiB  buffered ${formatTransfer(row.buffered)}  streamed ${formatTransfer(row.streamed)} (${row.streamed.chunks} chunks)`,
      );
    }
  }
  for (const surface of ['actor', 'worker']) {
    const slow = report.surfaces[surface].slowConsumer;
    console.log(
      `\n${surface} slow consumer: ${slow.chunks} chunks × ${slow.delayPerChunkMs} ms requested; ` +
        `${slow.elapsedMs.toFixed(3)} ms total`,
    );
  }
  console.log(
    `Server: open ${formatMs(report.server.openMs)}, startup ${formatMs(report.server.connectAndStartupMs)}, ` +
      `query ${formatPair(report.server.smallRoundTripMs)}`,
  );
  console.log('Actor database fanout (count / elapsed / peak RSS growth)');
  for (const row of report.fanout) {
    console.log(
      `${String(row.count).padStart(2)} databases  ${formatMs(row.elapsedMs).padEnd(12)} ${row.resources.rssGrowthMiB.toFixed(1)} MiB`,
    );
  }
  console.log(
    `Actor overload: ${report.overload.concurrency} × ${formatBytes(report.overload.inputBytesPerCall)} input, ` +
      `${formatMs(report.overload.elapsedMs)}, ${report.overload.resources.rssGrowthMiB.toFixed(1)} MiB RSS growth`,
  );
  for (const row of report.server.bulk) {
    console.log(`Server ${row.sizeMiB} MiB COPY: ${formatTransfer(row)}`);
  }
  console.log(
    `Tools: psql command ${formatMs(report.tools.psqlCommandMs)}, ` +
      `schema dump ${formatMs(report.tools.schemaDump.elapsedMs)}, ` +
      `data dump ${formatMs(report.tools.dataDump.elapsedMs)} (${formatBytes(report.tools.dataDump.bytes)}), ` +
      `restore ${formatMs(report.tools.restore.elapsedMs)}`,
  );
  console.log('\nRepresentative event-loop delay / process RSS growth');
  const representativeBulkSize = report.configuration.bulkSizesMiB.at(-1);
  for (const [label, resources] of [
    [
      `direct ${representativeBulkSize} MiB stream`,
      report.surfaces.direct.bulk.at(-1).streamed.resources,
    ],
    [
      `actor ${representativeBulkSize} MiB stream`,
      report.surfaces.actor.bulk.at(-1).streamed.resources,
    ],
    [
      `worker ${representativeBulkSize} MiB stream`,
      report.surfaces.worker.bulk.at(-1).streamed.resources,
    ],
    [`server ${representativeBulkSize} MiB COPY`, report.server.bulk.at(-1).resources],
    ['pg_dump data', report.tools.dataDump.resources],
    ['psql restore', report.tools.restore.resources],
  ]) {
    console.log(
      `${label.padEnd(22)} ${formatMs(resources.maxEventLoopDelayMs).padEnd(12)} ` +
        `${resources.rssGrowthMiB.toFixed(1)} MiB`,
    );
  }
  console.log('RSS growth is descriptive; earlier scenarios can retain allocations.');
  console.log('\nUse --json for the complete machine-readable report.');
}

function formatPair(value) {
  return `${value.median.toFixed(3)} / ${value.p95.toFixed(3)} / ${value.p99.toFixed(3)}`;
}

function formatTransfer(value) {
  return `${value.mebibytesPerSecond.toFixed(1)} MiB/s; ${value.elapsedMs.toFixed(1)} ms`;
}

function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

function formatDeltaMs(value) {
  return `${value >= 0 ? '+' : ''}${formatMs(value)}`;
}

function formatBytes(value) {
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function parseArguments(args) {
  const options = { json: false, full: false };
  for (const argument of args) {
    if (argument === '--json') options.json = true;
    else if (argument === '--full') options.full = true;
    else {
      throw new Error('usage: node tools/perf/wasix-node/streaming-quick.mjs [--json] [--full]');
    }
  }
  return options;
}

async function requireInputs() {
  const required = [
    'src/bindings/wasix-ts/lib/index.node.js',
    'src/bindings/wasix-ts/lib/direct.node.js',
    'src/bindings/wasix-ts/lib/worker-entry.node.js',
    'src/bindings/wasix-ts/lib/host/index.mjs',
    'src/bindings/wasix-ts/tools-package/lib/index.js',
    'target/oliphaunt-wasix/assets/manifest.json',
    'target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm',
    'target/oliphaunt-wasix/assets/bin/psql.wasix.wasm',
  ];
  try {
    await Promise.all(required.map((path) => access(resolve(repositoryRoot, path))));
  } catch (cause) {
    throw new Error(
      'quick WASIX streaming benchmark needs staged TypeScript packages and portable runtime assets; ' +
        'run `moon run oliphaunt-wasix-ts:package liboliphaunt-wasix:runtime-portable` first',
      { cause },
    );
  }
}

async function openRssSampler() {
  const peak = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL('./rss-sampler-worker.mjs', import.meta.url), {
    name: 'oliphaunt-wasix-quick-rss-sampler',
    workerData: peak.buffer,
  });
  await new Promise((resolveOnline, rejectOnline) => {
    worker.once('online', resolveOnline);
    worker.once('error', rejectOnline);
  });
  return {
    reset(bytes) {
      Atomics.store(peak, 0, Math.ceil(bytes / 1024));
    },
    peakBytes() {
      return Atomics.load(peak, 0) * 1024;
    },
    terminate() {
      return worker.terminate();
    },
  };
}
