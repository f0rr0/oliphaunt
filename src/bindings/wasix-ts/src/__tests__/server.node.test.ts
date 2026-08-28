import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OliphauntDatabase } from '../types.js';

const serverMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(async () => undefined),
  openWasix: vi.fn<() => Promise<OliphauntDatabase>>(),
}));
const { closeDatabase, openWasix } = serverMocks;

vi.mock('../worker-node-client.js', () => ({
  openWasix: serverMocks.openWasix,
}));

import {
  closeWasixByteChannel,
  readWasixByteChannel,
  writeWasixByteChannel,
} from '../byte-channel.js';
import { WasixDatabaseImpl } from '../database.js';
import { openServer } from '../server.node.js';

type ServerListenFixture = Readonly<{
  tcp: Readonly<{ invalidPorts: readonly number[] }>;
  unix: Readonly<{ defaultPort: number; filePrefix: string }>;
}>;

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../shared/fixtures/postgres/server-listen.json', import.meta.url),
    'utf8',
  ),
) as ServerListenFixture;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  closeDatabase.mockClear();
  openWasix.mockReset();
  openWasix.mockResolvedValue({ close: closeDatabase } as unknown as OliphauntDatabase);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

// liboliphaunt-doc-example:wasix-typescript-server
describe('WASIX local server surface', () => {
  it('opens loopback TCP with an automatic port and closes idempotently', async () => {
    const server = await openServer();
    expect(server.closed).toBe(false);
    expect(server.connectionString).toMatch(
      /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?sslmode=disable$/,
    );
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    expect(server.closed).toBe(false);
    await first;
    expect(server.closed).toBe(true);
    await second;
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('becomes closed after a failed terminal close and replays that outcome', async () => {
    const databaseFailure = new Error('database close failed');
    closeDatabase.mockRejectedValueOnce(databaseFailure);
    const server = await openServer();

    const first = server.close();
    expect(server.closed).toBe(false);
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate failure');
    expect(failure.errors).toContain(databaseFailure);
    expect(server.closed).toBe(true);
    expect(server.close()).toBe(first);
    await expect(server.close()).rejects.toBe(failure);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps a live Unix listener and its socket owned after listener close is unconfirmed',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-server-'));
      temporaryDirectories.push(directory);
      const server = await openServer({ listen: { transport: 'unix', directory, port: 6544 } });
      const socketPath = join(directory, `${fixture.unix.filePrefix}6544`);
      const listenerFailure = new Error('fixture listener close failed');
      let nodeServer: Server | undefined;
      const originalClose = Server.prototype.close;
      const close = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
        this: Server,
        callback?: (error?: Error) => void,
      ) {
        nodeServer = this;
        callback?.(listenerFailure);
        return this;
      });

      try {
        const failure = await server.close().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error('expected aggregate failure');
        expect(failure.errors).toContain(listenerFailure);
        expect(server.closed).toBe(true);
        expect(nodeServer?.listening).toBe(true);
        expect((await stat(socketPath)).isSocket()).toBe(true);
        expect(closeDatabase).toHaveBeenCalledTimes(1);

        // The public outcome is terminal, but the retained exact owner may
        // safely retry listener/path cleanup without closing the database twice.
        const owned = nodeServer;
        if (owned === undefined) throw new Error('fixture did not capture the listener');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(close).toHaveBeenCalledTimes(2);
        expect(owned.listening).toBe(true);
        close.mockRestore();
        await closeServerForTest(owned, originalClose);
        expect(closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
        if (nodeServer?.listening) await closeServerForTest(nodeServer, originalClose);
      }
    },
  );

  it('aggregates failed-open and cleanup failures while retaining the live listener', async () => {
    const databaseFailure = new Error('fixture database cleanup failed');
    const listenerFailure = new Error('fixture listener cleanup failed');
    closeDatabase.mockRejectedValueOnce(databaseFailure);
    const address = vi.spyOn(Server.prototype, 'address').mockReturnValue(null);
    let nodeServer: Server | undefined;
    const originalClose = Server.prototype.close;
    const close = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ) {
      nodeServer = this;
      callback?.(listenerFailure);
      return this;
    });

    try {
      const failure = await openServer().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error('expected aggregate failure');
      expect(failure.errors[0]).toMatchObject({
        message: 'Oliphaunt WASIX TCP listener did not report a port',
      });
      expect(failure.errors).toContain(listenerFailure);
      expect(failure.errors).toContain(databaseFailure);
      expect(nodeServer?.listening).toBe(true);
      expect(closeDatabase).toHaveBeenCalledTimes(1);

      address.mockRestore();
      const owned = nodeServer;
      if (owned === undefined) throw new Error('fixture did not capture the listener');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledTimes(2);
      expect(owned.listening).toBe(true);
      close.mockRestore();
      await closeServerForTest(owned, originalClose);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      address.mockRestore();
      close.mockRestore();
      if (nodeServer?.listening) await closeServerForTest(nodeServer, originalClose);
    }
  });

  it('rejects every invalid port in the shared listener contract', async () => {
    for (const port of fixture.tcp.invalidPorts) {
      await expect(openServer({ listen: { transport: 'tcp', port } })).rejects.toThrow(
        /range 1\.\.65535/,
      );
    }
  });

  it('settles close when a backpressured socket is destroyed', async () => {
    let markServing: (() => void) | undefined;
    const serving = new Promise<void>((resolve) => {
      markServing = resolve;
    });
    const database = new WasixDatabaseImpl({
      supportsProtocolConnections: true,
      async exec() {
        return new Uint8Array();
      },
      async sync() {},
      async serve(connection) {
        markServing?.();
        await writeWasixByteChannel(connection.backend, Uint8Array.of(1));
        try {
          while ((await readWasixByteChannel(connection.frontend)).length !== 0) {
            // The regression client sends no input; keep the fake session
            // honest if that changes.
          }
        } finally {
          closeWasixByteChannel(connection.backend);
        }
      },
      async close() {},
    });
    openWasix.mockResolvedValueOnce(database);

    let markBackpressured: (() => void) | undefined;
    const backpressured = new Promise<void>((resolve) => {
      markBackpressured = resolve;
    });
    const write = vi.spyOn(Socket.prototype, 'write').mockImplementation(function () {
      markBackpressured?.();
      return false;
    });
    const server = await openServer();
    const endpoint = new URL(server.connectionString);
    const client = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      await Promise.all([serving, backpressured]);
      await expect(server.close()).resolves.toBeUndefined();
    } finally {
      client.destroy();
      write.mockRestore();
      await server.close().catch(() => undefined);
    }
  });

  it('waits for the final socket bytes to flush before destroying the connection', async () => {
    const database = new WasixDatabaseImpl({
      supportsProtocolConnections: true,
      async exec() {
        return new Uint8Array();
      },
      async sync() {},
      async serve(connection) {
        await writeWasixByteChannel(connection.backend, Uint8Array.of(1, 2, 3));
        closeWasixByteChannel(connection.backend);
      },
      async close() {},
    });
    openWasix.mockResolvedValueOnce(database);

    let endingSocket: Socket | undefined;
    let markEnding: (() => void) | undefined;
    const ending = new Promise<void>((resolve) => {
      markEnding = resolve;
    });
    const end = vi.spyOn(Socket.prototype, 'end').mockImplementation(function (this: Socket) {
      endingSocket = this;
      markEnding?.();
      return this;
    });
    const server = await openServer();
    const endpoint = new URL(server.connectionString);
    const client = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      await ending;
      if (endingSocket === undefined) throw new Error('server socket did not finish its output');
      const socket = endingSocket;
      expect(socket.destroyed).toBe(false);

      const destroyed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.emit('finish');
      await destroyed;
    } finally {
      client.destroy();
      end.mockRestore();
      await server.close().catch(() => undefined);
    }
  });

  it.runIf(process.platform !== 'win32')(
    'uses PostgreSQL Unix socket naming and removes only its socket',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-server-'));
      temporaryDirectories.push(directory);
      const server = await openServer({
        listen: { transport: 'unix', directory, port: 6543 },
      });
      const socket = join(directory, `${fixture.unix.filePrefix}6543`);
      expect((await stat(socket)).isSocket()).toBe(true);
      expect(server.connectionString).toContain(`host=${encodeURIComponent(directory)}`);
      await server.close();
      await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'uses the shared default PostgreSQL Unix socket port',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-wasix-server-'));
      temporaryDirectories.push(directory);
      const server = await openServer({ listen: { transport: 'unix', directory } });
      const socket = join(directory, `${fixture.unix.filePrefix}${fixture.unix.defaultPort}`);
      expect((await stat(socket)).isSocket()).toBe(true);
      await server.close();
    },
  );
});

function closeServerForTest(server: Server, close: Server['close']): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    close.call(server, (error) => (error === undefined ? resolve() : reject(error)));
  });
}
