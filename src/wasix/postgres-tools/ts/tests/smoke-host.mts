import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { verifyRegisteredOutputCleanup } from './registered-output-cleanup.mjs';

import {
  connect,
  controlPacket,
  onceClosed,
  onceConnected,
  readExchange,
  readSingleByte,
  simpleQuery,
  startupPacket,
} from '../../../sdks/ts/tools/pgwire-client.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const runtimeName = readRuntime(process.argv.slice(3));
const entrypointRuntime = runtimeName === 'electron' ? 'node' : runtimeName;
const seed = await readFile(
  resolve(root, 'src/test-fixtures/postgres/logical-tools-seed.sql'),
  'utf8',
);
const verify = await readFile(
  resolve(root, 'src/test-fixtures/postgres/logical-tools-verify.sql'),
  'utf8',
);
const fixture = JSON.parse(
  await readFile(resolve(root, 'src/test-fixtures/postgres/logical-tools.json'), 'utf8'),
);
const socketOperationTimeoutMs = 30_000;
const queuedClientObservationMs = 100;
const packed = JSON.parse(await readFile(process.argv[2], 'utf8'));
const packageRoot = (name) => resolve(packed.consumer, 'node_modules', ...name.split('/'));
const runtime = (
  await import(pathToFileURL(resolve(packageRoot(packed.packages.runtime.name), 'index.js')).href)
).default;
const { default: Oliphaunt } = await import(
  pathToFileURL(
    resolve(packageRoot(packed.packages.binding.name), `lib/index.${entrypointRuntime}.js`),
  ).href
);
const { default: WorkerOliphaunt } = await import(
  pathToFileURL(
    resolve(packageRoot(packed.packages.binding.name), `lib/worker-entry.${entrypointRuntime}.js`),
  ).href
);
const { PostgresToolError, pgDump, psql, pgDumpToFile, psqlToFile, pgDumpToStream, psqlToStream } =
  await import(
    pathToFileURL(resolve(packageRoot(packed.packages.toolsFacade.name), 'lib/index.js')).href
  );
const { default: DirectOliphaunt } = await import(
  pathToFileURL(resolve(packageRoot(packed.packages.binding.name), 'lib/direct.node.js')).href
);
const { directory: directoryStorage } = await import(
  pathToFileURL(
    resolve(packageRoot(packed.packages.binding.name), `lib/storage/${entrypointRuntime}.js`),
  ).href
);
const { openServer } = await import(
  pathToFileURL(resolve(packageRoot(packed.packages.binding.name), 'lib/server.node.js')).href
);
const { default: extension } = await import(
  pathToFileURL(resolve(packageRoot(packed.packages.extension.name), 'index.js')).href
);

const { default: tools } = await import(
  pathToFileURL(resolve(packageRoot(packed.packages.toolsCarrier.name), 'native.js')).href
);
const [wasm, aot, manifest] = await Promise.all([
  readFile(new URL(tools.psql.source)),
  readFile(new URL(tools.psql.aot.source)),
  readFile(new URL(tools.psql.aot.manifest), 'utf8'),
]);
const addonPath = createRequire(join(packed.consumer, 'package.json')).resolve(
  `${packed.packages.nativeCarrier.name}/oliphaunt_wasix_napi.node`,
);
await verifyRegisteredOutputCleanup(addonPath, { wasm, aot, manifest }, runtimeName);

console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: logical tools`);
await verifyLogicalTools({
  Oliphaunt,
  WorkerOliphaunt,
  PostgresToolError,
  pgDump,
  psql,
  extension,
});
for (const [placement, Binding] of [
  ['root', Oliphaunt],
  ['direct', DirectOliphaunt],
  ['worker', WorkerOliphaunt],
]) {
  await verifyFileDestinations(placement, Binding);
}
console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: TCP server`);
await verifyServer(openServer, { transport: 'tcp' });
if (process.platform !== 'win32') {
  const directory = await mkdtemp(join(tmpdir(), `oliphaunt-wasix-${runtimeName}-socket-`));
  try {
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: Unix server`);
    await verifyServer(openServer, { transport: 'unix', directory, port: 6543 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: PASS`);

async function verifyFileDestinations(placement, Binding) {
  console.log(`WASIX TypeScript ${runtimeName} ${placement}: tool file destinations`);
  const directory = await mkdtemp(join(tmpdir(), `oliphaunt-wasix-tools-${placement}-`));
  const storage = directoryStorage(join(directory, 'database'));
  let source;
  let restored;
  try {
    source = await Binding.open({ storage });
    await source.execute('CREATE ROLE logical_owner LOGIN SUPERUSER');
    await source.close();
    source = await Binding.open({ storage, username: 'logical_owner' });
    await source.execute('CREATE TABLE tool_large_dump (id integer PRIMARY KEY, value text)');
    await source.execute(
      "INSERT INTO tool_large_dump SELECT i, repeat('λ', 4096) FROM generate_series(1, 8193) i",
    );
    await source.execute('CREATE TABLE tool_effects (value integer)');
    const options = { args: ['--restrict-key=OliphauntFileDestinationTest'] };
    const destination = join(directory, 'dump.sql');
    const summary = await pgDumpToFile(source, destination, options);
    const file = await readFile(destination);
    if (summary.stdoutBytes !== file.length || file.length <= 64 * 1024 * 1024) {
      throw new Error(`${placement} file dump was truncated or did not exceed 64 MiB`);
    }
    if (process.platform !== 'win32' && ((await stat(destination)).mode & 0o777) !== 0o600) {
      throw new Error(`${placement} tool output did not preserve private staging permissions`);
    }
    const sql = await pgDump(source, options);
    if (file.toString('utf8') !== sql || !sql.includes('COPY public.tool_large_dump')) {
      throw new Error(`${placement} file output differed from the complete plain COPY collector`);
    }
    restored = await Binding.open();
    await restored.execute('CREATE ROLE logical_owner LOGIN');
    await psql(restored, { script: sql });
    if (
      (await restored.queryRaw('SELECT count(*)::int AS rows FROM tool_large_dump')).getText(
        0,
        'rows',
      ) !== '8193'
    ) {
      throw new Error(`${placement} file dump did not restore all rows`);
    }
    if (placement === 'direct') {
      const rejected = await psqlToStream(source, new WritableStream(), {
        command: 'INSERT INTO tool_effects VALUES (99)',
      }).catch((error) => error);
      if (!(rejected instanceof PostgresToolError) || !rejected.message.includes('/direct'))
        throw new Error('direct async destination did not fail before execution');
      if (
        (await source.queryRaw('SELECT count(*)::int AS rows FROM tool_effects')).getText(
          0,
          'rows',
        ) !== '0'
      )
        throw new Error('unsupported direct destination executed SQL');
    } else {
      await verifyStreamDestinations(source, placement, options, file);
    }
    const largeValuePath = join(directory, 'large-value.txt');
    const largeValue = await psqlToFile(source, largeValuePath, {
      args: ['--tuples-only', '--no-align'],
      command: `SELECT repeat('X', ${65 * 1024 * 1024})`,
    });
    if (
      largeValue.stdoutBytes !== 65 * 1024 * 1024 + 1 ||
      (await stat(largeValuePath)).size !== largeValue.stdoutBytes
    ) {
      throw new Error(`${placement} file output truncated one value larger than 64 MiB`);
    }
    const existing = await psqlToFile(source, destination, {
      command: 'INSERT INTO tool_effects VALUES (1)',
    }).catch((error) => error);
    if (
      !(existing instanceof PostgresToolError) ||
      existing.exitCode !== 0 ||
      (await stat(destination)).size !== file.length
    ) {
      throw new Error(
        `${placement} existing destination lost completed-tool metadata or replaced output`,
      );
    }
    if (
      (await source.queryRaw('SELECT count(*)::int AS rows FROM tool_effects')).getText(
        0,
        'rows',
      ) !== '1'
    ) {
      throw new Error(`${placement} publication failure retried or rolled back committed SQL`);
    }
    const failedDestination = join(directory, 'failed.sql');
    const failed = await psqlToFile(source, failedDestination, { command: 'SELECT 1/0' }).catch(
      (error) => error,
    );
    if (
      !(failed instanceof PostgresToolError) ||
      !Number.isSafeInteger(failed.exitCode) ||
      failed.exitCode === 0
    ) {
      throw new Error(`${placement} failed psql did not report its real exit code`);
    }
    if (
      (await readdir(directory)).some(
        (name) => name === 'failed.sql' || name.startsWith('.oliphaunt-tool-'),
      )
    ) {
      throw new Error(`${placement} failed tool left published or owned staging output`);
    }
    const diagnostics = await psqlToFile(source, join(directory, 'warnings.txt'), {
      command:
        "DO $$ BEGIN FOR i IN 1..24 LOOP RAISE WARNING '%', repeat('diagnostic', 1024); END LOOP; RAISE WARNING 'last diagnostic'; END $$",
    });
    if (
      !diagnostics.stderrTruncated ||
      Buffer.byteLength(diagnostics.stderr) > 8192 ||
      !diagnostics.stderr.includes('last diagnostic')
    ) {
      throw new Error(`${placement} file output did not keep a marked diagnostic tail`);
    }
    if ((await source.queryRaw('SELECT 42 AS answer')).getText(0, 'answer') !== '42') {
      throw new Error(`${placement} database was not usable after file destination failures`);
    }
  } finally {
    await restored?.close();
    await source?.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function verifyStreamDestinations(source, placement, options, file) {
  let bytes = 0;
  let largest = 0;
  let firstByteMs;
  let peakRss = process.memoryUsage().rss;
  const start = performance.now();
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const hash = createHash('sha256');
  const destination = new WritableStream({
    async write(chunk) {
      if (firstByteMs === undefined) {
        firstByteMs = performance.now() - start;
        const owned = Buffer.from(chunk);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!owned.equals(chunk))
          throw new Error('output chunk lifetime ended before destination acceptance');
      }
      bytes += chunk.length;
      largest = Math.max(largest, chunk.length);
      hash.update(chunk);
    },
  });
  let summary;
  try {
    summary = await pgDumpToStream(source, destination, options);
  } finally {
    clearInterval(sample);
  }
  if (
    bytes !== file.length ||
    summary.stdoutBytes !== bytes ||
    largest > 64 * 1024 ||
    destination.locked ||
    hash.digest('hex') !== createHash('sha256').update(file).digest('hex')
  ) {
    throw new Error(`${placement} async dump differed from file output or violated owned batching`);
  }
  console.log(
    `WASIX ${runtimeName} ${placement} stream: ${JSON.stringify({ bytes, largest, firstByteMs, elapsedMs: performance.now() - start, peakRss })}`,
  );
  let hugeBytes = 0;
  await psqlToStream(
    source,
    new WritableStream({
      write(chunk) {
        if (chunk.length > 64 * 1024) throw new Error('oversized output callback');
        for (const byte of chunk) {
          if (byte !== (hugeBytes === 65 * 1024 * 1024 ? 10 : 88))
            throw new Error('huge stream value changed');
          hugeBytes++;
        }
      },
    }),
    { args: ['--tuples-only', '--no-align'], command: `SELECT repeat('X', ${65 * 1024 * 1024})` },
  );
  if (hugeBytes !== 65 * 1024 * 1024 + 1) throw new Error('huge stream value was truncated');
  const failure = new Error('installed sink failure');
  const failed = await psqlToStream(
    source,
    new WritableStream({
      write() {
        throw failure;
      },
    }),
    { command: "INSERT INTO tool_effects VALUES (2); SELECT repeat('z', 1000000)" },
  ).catch((error) => error);
  if (!(failed instanceof PostgresToolError) || failed.exitCode !== 0 || failed.cause !== failure)
    throw new Error('sink failure lost completed-tool metadata');
  if (
    (await source.queryRaw('SELECT count(*)::int AS rows FROM tool_effects')).getText(0, 'rows') !==
    '1'
  )
    throw new Error('sink failure changed committed SQL');
  await source.execute('TRUNCATE tool_effects');
  let diagnostics = 0;
  const diagnosticSummary = await psqlToStream(source, new WritableStream({ write() {} }), {
    command:
      "DO $$ BEGIN FOR i IN 1..24 LOOP RAISE WARNING '%', repeat('diagnostic', 1024); END LOOP; RAISE WARNING 'last diagnostic'; END $$",
    stderr: new WritableStream({
      write(chunk) {
        diagnostics += chunk.length;
      },
    }),
  });
  if (
    diagnostics <= 8192 ||
    !diagnosticSummary.stderrTruncated ||
    Buffer.byteLength(diagnosticSummary.stderr) > 8192 ||
    !diagnosticSummary.stderr.includes('last diagnostic')
  )
    throw new Error('full stderr or bounded marked tail was lost');
  const controller = new AbortController();
  const reason = new Error('cancel installed sink');
  const cancelled = await psqlToStream(
    source,
    new WritableStream({
      write() {
        controller.abort(reason);
        return new Promise(() => {});
      },
    }),
    {
      command: "SELECT repeat('c', 2000000)",
      signal: controller.signal,
    },
  ).catch((error) => error);
  if (!(cancelled instanceof PostgresToolError) || cancelled.cause !== reason)
    throw new Error('stalled destination cancellation lost its cause');
  if ((await source.queryRaw('SELECT 42 AS answer')).getText(0, 'answer') !== '42')
    throw new Error('database was unusable after destination cancellation');
}

async function verifyLogicalTools({
  Oliphaunt,
  WorkerOliphaunt,
  PostgresToolError,
  pgDump,
  psql,
  extension,
}) {
  const source = await WorkerOliphaunt.open({ extensions: [extension] });
  let sql;
  try {
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: psql seed`);
    await psql(source, { script: seed });
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: pg_dump`);
    sql = await pgDump(source);
    if (!sql.includes('COPY public.logical_items') || sql.includes('--inserts')) {
      throw new Error('pg_dump did not preserve standard plain COPY output');
    }
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: pg_dump schema`);
    const schema = await pgDump(source, { args: ['--schema-only'] });
    if (!schema.includes('CREATE TABLE') || schema.includes('COPY public.logical_items')) {
      throw new Error('pg_dump --schema-only returned an invalid logical dump');
    }
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: psql error`);
    try {
      await psql(source, { command: 'SELEC 1' });
      throw new Error('invalid psql command unexpectedly succeeded');
    } catch (error) {
      if (!(error instanceof PostgresToolError) || error.exitCode === null || error.stderr === '') {
        throw error;
      }
    }
  } finally {
    await source.close();
  }

  if (entrypointRuntime === 'node') {
    await verifyDirectPgDump(Oliphaunt, pgDump);
  }

  const target = await WorkerOliphaunt.open({ extensions: [extension] });
  try {
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: psql restore`);
    await psql(target, { script: sql });
    const result = await target.queryRaw(verify);
    const expected = fixture.expected;
    const actual = {
      rows: Number(result.getText(0, 'rows')),
      sum: Number(result.getText(0, 'sum')),
      sequenceLastValue: Number(result.getText(0, 'sequence_last_value')),
      quotedValue: result.getText(0, 'quoted_value'),
      normalizedMatches: Number(result.getText(0, 'normalized_matches')),
      extensionLoaded: result.getText(0, 'extension_loaded') === 't',
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `logical tool round trip differed from the shared fixture: ${JSON.stringify(actual)}`,
      );
    }
  } finally {
    await target.close();
  }
}

async function verifyDirectPgDump(Oliphaunt, pgDump) {
  console.log('WASIX TypeScript node tools/server smoke: direct pg_dump');
  const database = await Oliphaunt.open();
  try {
    await database.execute(
      'CREATE TABLE direct_dump_probe (id integer PRIMARY KEY, value text NOT NULL)',
    );
    await database.execute("INSERT INTO direct_dump_probe VALUES (1, 'same-realm')");
    const sql = await pgDump(database);
    if (!sql.includes('COPY public.direct_dump_probe') || !sql.includes('same-realm')) {
      throw new Error('direct pg_dump did not preserve standard plain COPY output');
    }
    const result = await database.queryRaw('SELECT count(*)::int AS rows FROM direct_dump_probe');
    if (result.getText(0, 'rows') !== '1') {
      throw new Error('direct database was not usable after pg_dump');
    }
  } finally {
    await database.close();
  }
}

async function verifyServer(openServer, listen) {
  const server = await openServer({ listen });
  try {
    const socket = connect(server.connectionString);
    let queued;
    let queuedStartup;
    try {
      await withSocketDeadline(socket, onceConnected(socket), 'first client connect');
      for (const code of [80_877_103, 80_877_104]) {
        const negotiation = withSocketDeadline(
          socket,
          readSingleByte(socket),
          `PostgreSQL negotiation ${code}`,
        );
        socket.write(controlPacket(code));
        const response = await negotiation;
        if (response !== 'N'.charCodeAt(0)) {
          throw new Error(
            `local server returned ${response} for PostgreSQL negotiation request ${code}`,
          );
        }
      }
      const firstStartup = withSocketDeadline(socket, readExchange(socket), 'first client startup');
      socket.write(startupPacket('postgres', 'postgres'));
      await firstStartup;
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: first startup`);

      // The Rust listener deliberately owns one complete client at a time. A
      // second TCP/Unix connection can finish its host handshake in the OS
      // backlog, but its PostgreSQL startup must wait for the active backend.
      queued = connect(server.connectionString);
      await withSocketDeadline(queued, onceConnected(queued), 'queued client connect');
      queuedStartup = readExchange(queued);
      queued.write(startupPacket('postgres', 'postgres'));
      await expectStillPending(queuedStartup, queuedClientObservationMs, 'queued client startup');
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: second client queued`);

      const copy = withSocketDeadline(socket, readExchange(socket), 'first client COPY');
      socket.write(simpleQuery('COPY (SELECT generate_series(1, 100000)) TO STDOUT'));
      const copied = await copy;
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: first COPY`);
      if (copied.copyBytes < 500_000) {
        throw new Error(`local server truncated COPY output at ${copied.copyBytes} bytes`);
      }
      const begin = withSocketDeadline(socket, readExchange(socket), 'first client BEGIN');
      socket.write(simpleQuery('BEGIN'));
      await begin;
      const create = withSocketDeadline(
        socket,
        readExchange(socket),
        'first client transaction query',
      );
      socket.write(simpleQuery('CREATE TABLE disconnect_must_rollback(value integer)'));
      await create;
      const firstClosed = withSocketDeadline(socket, onceClosed(socket), 'first client disconnect');
      socket.destroy();
      await firstClosed;
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: disconnect recovered`);

      await withSocketDeadline(queued, queuedStartup, 'queued client startup after handoff');
      const queuedQuery = withSocketDeadline(queued, readExchange(queued), 'queued client query');
      queued.write(simpleQuery('CREATE TABLE disconnect_must_rollback(value integer)'));
      await queuedQuery;
      const queuedClosed = withSocketDeadline(queued, onceClosed(queued), 'queued client close');
      queued.end(Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4));
      await queuedClosed;
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: queued client accepted`);
    } finally {
      socket.destroy();
      queued?.destroy();
      await queuedStartup?.catch(() => undefined);
    }
  } finally {
    await server.close();
  }
}

function withSocketDeadline(socket, operation, label) {
  return new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      settle(value);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectOperation(new Error(`${label} timed out after ${socketOperationTimeoutMs}ms`));
    }, socketOperationTimeoutMs);
    operation.then(
      (value) => finish(resolveOperation, value),
      (error) => finish(rejectOperation, error),
    );
  });
}

async function expectStillPending(operation, observationMs, label) {
  let timeout;
  const observed = await Promise.race([
    operation.then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolveObservation) => {
      timeout = setTimeout(() => resolveObservation({ status: 'pending' }), observationMs);
    }),
  ]);
  clearTimeout(timeout);
  if (observed.status === 'pending') return;
  if (observed.status === 'rejected') {
    throw new Error(`${label} was rejected instead of waiting behind the active client`, {
      cause: observed.error,
    });
  }
  throw new Error(`${label} completed while the first client still owned the embedded backend`);
}

function readRuntime(args) {
  if (
    args.length !== 2 ||
    args[0] !== '--runtime' ||
    !['node', 'bun', 'deno', 'electron'].includes(args[1])
  ) {
    throw new Error('usage: smoke-host.mjs --runtime node|bun|deno|electron');
  }
  return args[1];
}
