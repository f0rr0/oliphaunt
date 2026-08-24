import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const closeDatabase = vi.fn(async () => undefined);

vi.mock('../node-client.js', () => ({
  openWasix: vi.fn(async () => ({ close: closeDatabase })),
}));

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

afterEach(async () => {
  closeDatabase.mockClear();
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
