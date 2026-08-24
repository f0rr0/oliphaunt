import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Oliphaunt } from '../index.js';
import { assertNativeDatabaseContract } from './native-direct-contract.mjs';

async function main(): Promise<void> {
  const libraryPath = requiredEnv('LIBOLIPHAUNT_PATH');
  await assertNativeDatabaseContract(
    Oliphaunt,
    { execution: 'direct', libraryPath },
    'node-direct',
  );
  const brokerExecutable = process.env.OLIPHAUNT_BROKER;
  if (brokerExecutable) {
    await assertNativeDatabaseContract(
      Oliphaunt,
      { execution: 'broker', libraryPath, brokerExecutable },
      'broker',
    );
  }
  const serverExecutable = process.env.OLIPHAUNT_POSTGRES;
  if (serverExecutable) {
    const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-native-server-'));
    const server = await Oliphaunt.openServer({
      storage: { kind: 'directory', path: root },
      serverExecutable,
      runtimeDirectory: process.env.OLIPHAUNT_POSTGRES_TOOL_DIR ?? dirname(serverExecutable),
    });
    try {
      assert.match(server.connectionString, /^postgresql:\/\//u);
      assert.equal((await server.query('SELECT 1 AS value')).getText(0, 'value'), '1');
      assert.equal('backup' in server, false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the TypeScript SDK native smoke check`);
  return value;
}

await main();
