import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Oliphaunt } from '../index.js';
import type { OliphauntDatabase, OpenConfig } from '../types.js';

async function main(): Promise<void> {
  const libraryPath = requiredEnv('LIBOLIPHAUNT_PATH');
  if (process.env.OLIPHAUNT_TS_SMOKE_NODE_DIRECT === '1') {
    await smokeDatabase({ execution: 'direct', libraryPath }, 'direct');
  }
  const brokerExecutable = process.env.OLIPHAUNT_BROKER;
  if (brokerExecutable) {
    await smokeDatabase({ execution: 'broker', libraryPath, brokerExecutable }, 'broker');
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
      assert.match(server.connectionString, /^postgres:\/\//u);
      assert.equal((await server.query('SELECT 1 AS value')).getText(0, 'value'), '1');
      assert.equal('backup' in server, false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function smokeDatabase(config: OpenConfig, label: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `oliphaunt-js-${label}-`));
  let database: OliphauntDatabase | undefined;
  try {
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: root },
    });
    assert.equal(
      (await database.query(`SELECT '${label}'::text AS value`)).getText(0, 'value'),
      label,
    );
    const backup = await database.backup();
    assert.ok(backup.byteLength > 0);
    await database.close();
    database = undefined;

    const restoredRoot = join(root, 'restored');
    await Oliphaunt.restore(restoredRoot, backup);
    assert.match(await readFile(join(restoredRoot, 'pgdata', 'PG_VERSION'), 'utf8'), /^18\s*$/u);
  } finally {
    await database?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the TypeScript SDK native smoke check`);
  return value;
}

await main();
