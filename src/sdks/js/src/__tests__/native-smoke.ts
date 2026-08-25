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
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), 'oliphaunt-js-native-server-first-')),
      mkdtemp(join(tmpdir(), 'oliphaunt-js-native-server-second-')),
    ]);
    try {
      const systemIdentifiers: string[] = [];
      for (const [index, root] of roots.entries()) {
        const server = await Oliphaunt.openServer({
          storage: { kind: 'directory', path: root },
          serverExecutable,
          runtimeDirectory: process.env.OLIPHAUNT_POSTGRES_TOOL_DIR ?? dirname(serverExecutable),
        });
        try {
          assert.match(server.connectionString, /^postgresql:\/\//u);
          if (index === 0) {
            assert.equal((await server.query('SELECT 1 AS value')).getText(0, 'value'), '1');
            assert.equal('backup' in server, false);
          }
          const identifier = (
            await server.query(
              'SELECT system_identifier::text AS system_identifier FROM pg_control_system()',
            )
          ).getText(0, 'system_identifier');
          assert.match(identifier ?? '', /^\d+$/u);
          assert.ok(identifier !== null);
          systemIdentifiers.push(identifier);
        } finally {
          await server.close();
        }
      }
      assert.notEqual(
        systemIdentifiers[0],
        systemIdentifiers[1],
        'independent fresh server roots must not clone one PostgreSQL system identifier',
      );
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the TypeScript SDK native smoke check`);
  return value;
}

await main();
