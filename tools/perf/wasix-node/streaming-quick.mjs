import { access, mkdtemp, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const roundTripWarmups = 4;
const roundTripSamples = 20;
const bulkSizesMiB = [1, 4];
const slowConsumerDelayMs = 1;
const toolRows = 4_096;
const jsonOnly = parseArguments(process.argv.slice(2));
const started = performance.now();

await requireInputs();
const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-streaming-quick-'));
const rssSampler = await openRssSampler().catch(async (error) => {
  await rm(scratch, { force: true, recursive: true });
  throw error;
});

try {
  const fixture = await createPackedWasixConsumer({
    scratch,
    consumerName: 'oliphaunt-wasix-streaming-quick-consumer',
    includeTools: true,
  });
  const packageRoot = (name) => resolve(fixture.consumer, 'node_modules', ...name.split('/'));
  const bindingRoot = packageRoot(fixture.packages.binding.name);
  const toolsRoot = packageRoot(fixture.packages.toolsFacade.name);
  const { default: Oliphaunt } = await import(
    pathToFileURL(resolve(bindingRoot, 'lib/index.node.js')).href
  );
  const { openServer } = await import(
    pathToFileURL(resolve(bindingRoot, 'lib/server.node.js')).href
  );
  const { pgDump, psql } = await import(pathToFileURL(resolve(toolsRoot, 'lib/index.js')).href);

  const placements = {};
  for (const execution of ['direct', 'worker']) {
    placements[execution] = await benchmarkPlacement(Oliphaunt, execution);
  }
  const server = await benchmarkServer(openServer);
  const tools = await benchmarkTools(Oliphaunt, pgDump, psql);
  const report = {
    schema: 'oliphaunt-wasix-streaming-quick-v1',
    measuredAt: new Date().toISOString(),
    durationMs: rounded(performance.now() - started),
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
      slowConsumerDelayMs,
      toolRows,
      storage: 'memory',
      resourceSamples: 'representative 4 MiB streams, data dump, and restore',
      resourceNote:
        'RSS is process-wide growth from each scenario start; retained allocations can reduce later deltas',
    },
    placements,
    comparison: comparePlacements(placements),
    server,
    tools,
  };

  if (jsonOnly) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} finally {
  await Promise.all([
    rm(scratch, { force: true, recursive: true }),
    rssSampler.terminate().then(() => undefined),
  ]);
}

async function benchmarkPlacement(Oliphaunt, execution) {
  const opening = await timed(() => Oliphaunt.open({ execution }));
  const database = opening.value;
  try {
    const query = await samples(async () => {
      const result = await database.query('SELECT 1::int AS value');
      if (result.getText(0, 'value') !== '1')
        throw new Error('query benchmark returned wrong value');
    });
    const request = simpleQuery('SELECT 1');
    const expected = await database.execProtocolRaw(request);
    const rawBuffered = await samples(async () => {
      const response = await database.execProtocolRaw(request);
      if (response.length !== expected.length) throw new Error('buffered protocol size changed');
    });
    const rawStreamed = await samples(async () => {
      let bytes = 0;
      await database.execProtocolStream(request, (chunk) => {
        bytes += chunk.length;
      });
      if (bytes !== expected.length) throw new Error('streamed protocol size changed');
    });

    await consumeStream(database, copyQuery(0.25));
    const bulk = [];
    for (const sizeMiB of bulkSizesMiB) {
      const input = simpleQuery(copyQuery(sizeMiB));
      const expectedCopyBytes = sizeMiB * 1024 * 1024;
      const buffered = await timed(() => database.execProtocolRaw(input));
      if (buffered.value.length < expectedCopyBytes) {
        throw new Error(`${execution} buffered COPY response was truncated`);
      }
      const streamed =
        sizeMiB === bulkSizesMiB.at(-1)
          ? await resourceTimed(() => consumeStream(database, input))
          : await timed(() => consumeStream(database, input));
      if (streamed.value.bytes !== buffered.value.length) {
        throw new Error(`${execution} streamed COPY response differed from buffered response`);
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
    if (execution === 'worker') {
      const input = simpleQuery(copyQuery(1));
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const measured = await timed(async () => {
        let bytes = 0;
        let chunks = 0;
        await database.execProtocolStream(input, (chunk) => {
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
  const source = await Oliphaunt.open({ execution: 'worker' });
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

async function benchmarkRestore(Oliphaunt, psql, dump) {
  const target = await Oliphaunt.open({ execution: 'worker' });
  try {
    const restored = await resourceTimed(() => psql(target, { script: dump }));
    const rows = Number(
      (await target.query('SELECT count(*)::int AS rows FROM quick_tool_data')).getText(0, 'rows'),
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
  await database.execProtocolStream(request, (chunk) => {
    bytes += chunk.length;
    chunks += 1;
  });
  return { bytes, chunks };
}

function copyQuery(sizeMiB) {
  const rows = Math.round(sizeMiB * 1024);
  return `COPY (SELECT repeat('x', 1023) FROM generate_series(1, ${rows})) TO STDOUT`;
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

function comparePlacements(placements) {
  const direct = placements.direct.smallRoundTripMs;
  const worker = placements.worker.smallRoundTripMs;
  return Object.fromEntries(
    ['query', 'rawBuffered', 'rawStreamed'].map((name) => [
      name,
      {
        workerMinusDirectMedianMs: rounded(worker[name].median - direct[name].median),
        workerToDirectMedianRatio: rounded(worker[name].median / direct[name].median),
      },
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

function printReport(report) {
  console.log(`WASIX streaming quick benchmark (${(report.durationMs / 1000).toFixed(1)}s)`);
  console.log(`Node ${report.environment.node} · ${report.environment.cpu}`);
  console.log('\nSmall round-trip latency (median / p95 ms)');
  console.log('scenario             direct           worker           worker added');
  for (const [label, name] of [
    ['query()', 'query'],
    ['raw buffered', 'rawBuffered'],
    ['raw streamed', 'rawStreamed'],
  ]) {
    const direct = report.placements.direct.smallRoundTripMs[name];
    const worker = report.placements.worker.smallRoundTripMs[name];
    const added = report.comparison[name].workerMinusDirectMedianMs;
    console.log(
      `${label.padEnd(20)} ${formatPair(direct).padEnd(16)} ${formatPair(worker).padEnd(16)} ${formatMs(added)}`,
    );
  }
  console.log('\nBulk protocol transfer (MiB/s; elapsed ms)');
  for (const placement of ['direct', 'worker']) {
    for (const row of report.placements[placement].bulk) {
      console.log(
        `${placement.padEnd(7)} ${String(row.sizeMiB).padStart(2)} MiB  buffered ${formatTransfer(row.buffered)}  streamed ${formatTransfer(row.streamed)} (${row.streamed.chunks} chunks)`,
      );
    }
  }
  const slow = report.placements.worker.slowConsumer;
  console.log(
    `\nSlow consumer: ${slow.chunks} chunks × ${slow.delayPerChunkMs} ms requested; ` +
      `${slow.elapsedMs.toFixed(3)} ms total`,
  );
  console.log(
    `Server: open ${formatMs(report.server.openMs)}, startup ${formatMs(report.server.connectAndStartupMs)}, ` +
      `query ${formatPair(report.server.smallRoundTripMs)}`,
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
  for (const [label, resources] of [
    ['direct 4 MiB stream', report.placements.direct.bulk.at(-1).streamed.resources],
    ['worker 4 MiB stream', report.placements.worker.bulk.at(-1).streamed.resources],
    ['server 4 MiB COPY', report.server.bulk.at(-1).resources],
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
  return `${value.median.toFixed(3)} / ${value.p95.toFixed(3)}`;
}

function formatTransfer(value) {
  return `${value.mebibytesPerSecond.toFixed(1)} MiB/s; ${value.elapsedMs.toFixed(1)} ms`;
}

function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

function formatBytes(value) {
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function parseArguments(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--json') return true;
  throw new Error('usage: node tools/perf/wasix-node/streaming-quick.mjs [--json]');
}

async function requireInputs() {
  const required = [
    'src/bindings/wasix-ts/lib/index.node.js',
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
        'run `moon run oliphaunt-wasix-ts:tools-package liboliphaunt-wasix:runtime-portable` first',
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
