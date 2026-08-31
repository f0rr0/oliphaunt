import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPackedWasixConsumer } from '../../tools/packed-node-fixture.mjs';
import {
  connect,
  controlPacket,
  onceClosed,
  onceConnected,
  readExchange,
  readSingleByte,
  simpleQuery,
  startupPacket,
} from '../../tools/pgwire-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const runtimeName = readRuntime(process.argv.slice(2));
const seed = await readFile(
  resolve(root, 'src/shared/fixtures/postgres/logical-tools-seed.sql'),
  'utf8',
);
const verify = await readFile(
  resolve(root, 'src/shared/fixtures/postgres/logical-tools-verify.sql'),
  'utf8',
);
const fixture = JSON.parse(
  await readFile(resolve(root, 'src/shared/fixtures/postgres/logical-tools.json'), 'utf8'),
);
const socketOperationTimeoutMs = 30_000;
const queuedClientObservationMs = 100;
const scratch = await mkdtemp(join(tmpdir(), `oliphaunt-wasix-${runtimeName}-tools-`));

try {
  const packed = await createPackedWasixConsumer({
    scratch,
    consumerName: `oliphaunt-wasix-${runtimeName}-tools-consumer`,
    includePgtap: true,
    includeTools: true,
  });
  const packageRoot = (name) => resolve(packed.consumer, 'node_modules', ...name.split('/'));
  const runtime = (
    await import(pathToFileURL(resolve(packageRoot(packed.packages.runtime.name), 'index.js')).href)
  ).default;
  const { default: Oliphaunt } = await import(
    pathToFileURL(resolve(packageRoot(packed.packages.binding.name), `lib/index.${runtimeName}.js`))
      .href
  );
  const { default: WorkerOliphaunt } = await import(
    pathToFileURL(
      resolve(packageRoot(packed.packages.binding.name), `lib/worker-entry.${runtimeName}.js`),
    ).href
  );
  const { PostgresToolError, pgDump, psql } = await import(
    pathToFileURL(resolve(packageRoot(packed.packages.toolsFacade.name), 'lib/index.js')).href
  );
  const { openServer } = await import(
    pathToFileURL(resolve(packageRoot(packed.packages.binding.name), 'lib/server.node.js')).href
  );
  const { default: extension } = await import(
    pathToFileURL(resolve(packageRoot(packed.packages.extension.name), 'index.js')).href
  );

  console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: logical tools`);
  await verifyLogicalTools({
    Oliphaunt,
    WorkerOliphaunt,
    PostgresToolError,
    pgDump,
    psql,
    extension,
  });
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
} finally {
  await rm(scratch, { force: true, recursive: true });
}

console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: PASS`);

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

  if (runtimeName === 'node') {
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
  if (args.length !== 2 || args[0] !== '--runtime' || !['node', 'bun', 'deno'].includes(args[1])) {
    throw new Error('usage: smoke-host.mjs --runtime node|bun|deno');
  }
  return args[1];
}
