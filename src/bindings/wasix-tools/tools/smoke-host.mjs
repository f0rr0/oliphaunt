import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPackedWasixConsumer,
} from '../../wasix-ts/tools/packed-node-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
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
    pathToFileURL(
      resolve(packageRoot(packed.packages.binding.name), `lib/index.${runtimeName}.js`),
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
  await verifyLogicalTools({ Oliphaunt, PostgresToolError, pgDump, psql, extension });
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

async function verifyLogicalTools({ Oliphaunt, PostgresToolError, pgDump, psql, extension }) {
  const source = await Oliphaunt.open({ execution: 'worker', extensions: [extension] });
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

  const target = await Oliphaunt.open({ execution: 'worker', extensions: [extension] });
  try {
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: psql restore`);
    await psql(target, { script: sql });
    const result = await target.query(verify);
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
      throw new Error(`logical tool round trip differed from the shared fixture: ${JSON.stringify(actual)}`);
    }
  } finally {
    await target.close();
  }
}

async function verifyServer(openServer, listen) {
  await using server = await openServer({ listen });
  const socket = connect(server.connectionString);
  try {
    await onceConnected(socket);
    for (const code of [80_877_103, 80_877_104]) {
      socket.write(controlPacket(code));
      const response = await readSingleByte(socket);
      if (response !== 'N'.charCodeAt(0)) {
        throw new Error(`local server returned ${response} for PostgreSQL negotiation request ${code}`);
      }
    }
    socket.write(startupPacket('postgres', 'postgres'));
    await readExchange(socket);
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: first startup`);
    const rejected = connect(server.connectionString);
    try {
      await onceConnected(rejected);
      const rejection = expectClosedBeforeReady(rejected);
      rejected.write(startupPacket('postgres', 'postgres'));
      await rejection;
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: concurrent client rejected`);
    } finally {
      rejected.destroy();
    }
    socket.write(simpleQuery('COPY (SELECT generate_series(1, 100000)) TO STDOUT'));
    const copied = await readExchange(socket);
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: first COPY`);
    if (copied.copyBytes < 500_000) {
      throw new Error(`local server truncated COPY output at ${copied.copyBytes} bytes`);
    }
    socket.write(simpleQuery('BEGIN'));
    await readExchange(socket);
    socket.write(simpleQuery('CREATE TABLE disconnect_must_rollback(value integer)'));
    await readExchange(socket);
    socket.destroy();
    await onceClosed(socket);
    console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: disconnect recovered`);

    const next = await connectWhenReady(server.connectionString);
    try {
      next.write(simpleQuery('CREATE TABLE disconnect_must_rollback(value integer)'));
      await readExchange(next);
      next.end(Uint8Array.of('X'.charCodeAt(0), 0, 0, 0, 4));
      console.log(`WASIX TypeScript ${runtimeName} tools/server smoke: next client accepted`);
    } finally {
      next.destroy();
    }
  } finally {
    socket.destroy();
  }
}

async function connectWhenReady(connectionString) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    const socket = connect(connectionString);
    try {
      await onceConnected(socket);
      socket.write(startupPacket('postgres', 'postgres'));
      await readExchange(socket);
      return socket;
    } catch (error) {
      lastError = error;
      socket.destroy();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error(`local server did not accept the next client: ${String(lastError)}`);
}

function connect(connectionString) {
  const url = new URL(connectionString);
  const host = url.searchParams.get('host');
  if (host !== null) {
    return createConnection(join(host, `.s.PGSQL.${url.searchParams.get('port') ?? '5432'}`));
  }
  return createConnection({ host: url.hostname, port: Number(url.port) });
}

function onceConnected(socket) {
  if (socket.readyState === 'open') return Promise.resolve();
  return new Promise((resolveConnected, rejectConnected) => {
    const onConnect = () => {
      socket.off('error', onError);
      resolveConnected();
    };
    const onError = (error) => {
      socket.off('connect', onConnect);
      rejectConnected(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function onceClosed(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolveClosed) => socket.once('close', resolveClosed));
}

function readSingleByte(socket) {
  return new Promise((resolveByte, rejectByte) => {
    const onData = (value) => {
      cleanup();
      if (value.length !== 1) {
        rejectByte(new Error(`local server returned ${value.length} negotiation bytes, expected 1`));
        return;
      }
      resolveByte(value[0]);
    };
    const onError = (error) => {
      cleanup();
      rejectByte(error);
    };
    const onClose = () => {
      cleanup();
      rejectByte(new Error('local server closed during protocol negotiation'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function expectClosedBeforeReady(socket) {
  try {
    await readExchange(socket);
  } catch (error) {
    if (String(error).includes('closed before ReadyForQuery')) return;
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED'].includes(
        String(error.code),
      )
    ) {
      return;
    }
    throw error;
  }
  throw new Error('concurrent local-server client unexpectedly reached ReadyForQuery');
}

function readExchange(socket) {
  return new Promise((resolveExchange, rejectExchange) => {
    let buffered = new Uint8Array();
    let copyBytes = 0;
    const onData = (value) => {
      const incoming = new Uint8Array(value);
      const combined = new Uint8Array(buffered.length + incoming.length);
      combined.set(buffered);
      combined.set(incoming, buffered.length);
      let offset = 0;
      try {
        while (combined.length - offset >= 5) {
          const length = new DataView(
            combined.buffer,
            combined.byteOffset + offset + 1,
            4,
          ).getInt32(0);
          if (length < 4) throw new Error(`invalid backend message length ${length}`);
          const total = length + 1;
          if (combined.length - offset < total) break;
          const tag = combined[offset];
          if (tag === 'd'.charCodeAt(0)) copyBytes += length - 4;
          if (tag === 'E'.charCodeAt(0)) throw new Error('local server returned ErrorResponse');
          if (tag === 'Z'.charCodeAt(0)) {
            cleanup();
            resolveExchange({ copyBytes });
            return;
          }
          offset += total;
        }
        buffered = combined.slice(offset);
      } catch (error) {
        cleanup();
        rejectExchange(error);
      }
    };
    const onError = (error) => {
      cleanup();
      rejectExchange(error);
    };
    const onClose = () => {
      cleanup();
      rejectExchange(new Error('local server closed before ReadyForQuery'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onClose);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onClose);
    socket.once('close', onClose);
  });
}

function startupPacket(username, database) {
  const parameters = new TextEncoder().encode(
    `user\0${username}\0database\0${database}\0client_encoding\0UTF8\0\0`,
  );
  const packet = new Uint8Array(8 + parameters.length);
  const view = new DataView(packet.buffer);
  view.setInt32(0, packet.length);
  view.setInt32(4, 196_608);
  packet.set(parameters, 8);
  return packet;
}

function controlPacket(code) {
  const packet = new Uint8Array(8);
  const view = new DataView(packet.buffer);
  view.setInt32(0, packet.length);
  view.setInt32(4, code);
  return packet;
}

function simpleQuery(sql) {
  const body = new TextEncoder().encode(`${sql}\0`);
  const packet = new Uint8Array(5 + body.length);
  packet[0] = 'Q'.charCodeAt(0);
  new DataView(packet.buffer).setInt32(1, body.length + 4);
  packet.set(body, 5);
  return packet;
}

function readRuntime(args) {
  if (args.length !== 2 || args[0] !== '--runtime' || !['node', 'bun', 'deno'].includes(args[1])) {
    throw new Error('usage: smoke-host.mjs --runtime node|bun|deno');
  }
  return args[1];
}
