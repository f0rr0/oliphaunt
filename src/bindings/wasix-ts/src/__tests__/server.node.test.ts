import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OliphauntDatabase } from '../types.js';

const serverMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(async () => undefined),
  openWasix: vi.fn<() => Promise<OliphauntDatabase>>(),
}));
const { closeDatabase, openWasix } = serverMocks;

vi.mock('../node-client.js', () => ({
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
    expect(server.connectionString).toMatch(
      /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?sslmode=disable$/,
    );
    await server.close();
    await server.close();
    expect(closeDatabase).toHaveBeenCalledTimes(1);
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
      isolated: true,
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
      isolated: true,
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
