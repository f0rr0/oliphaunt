import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Oliphaunt } from '../index.js';
import { simpleQuery } from '../protocol.js';
import { parseSimpleQueryRawResponse } from '../query.js';
import { PostgresWireClient } from '../runtime/pgwire.js';
import { assertNativeDatabaseContract } from './native-direct-contract.mjs';

async function main(): Promise<void> {
  const libraryPath = requiredEnv('LIBOLIPHAUNT_PATH');
  await assertNativeDatabaseContract(Oliphaunt, { topology: 'direct', libraryPath }, 'node-direct');
  const brokerExecutable = process.env.OLIPHAUNT_BROKER;
  if (brokerExecutable) {
    await assertNativeDatabaseContract(
      Oliphaunt,
      { topology: 'broker', libraryPath, brokerExecutable },
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
          assert.equal('query' in server, false);
          assert.equal('cancel' in server, false);
          assert.equal('backup' in server, false);
          const connection = await connectToServer(server.connectionString);
          let identifier: string | null;
          try {
            if (index === 0) {
              const one = parseSimpleQueryRawResponse(
                await connection.execProtocolRaw(simpleQuery('SELECT 1 AS value')),
              );
              assert.equal(one.getText(0, 'value'), '1');
            }
            identifier = parseSimpleQueryRawResponse(
              await connection.execProtocolRaw(
                simpleQuery(
                  'SELECT system_identifier::text AS system_identifier FROM pg_control_system()',
                ),
              ),
            ).getText(0, 'system_identifier');
          } finally {
            await connection.terminate();
          }
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

async function connectToServer(connectionString: string): Promise<PostgresWireClient> {
  const endpoint = new URL(connectionString);
  if (endpoint.hostname.length === 0) {
    throw new Error('native server smoke requires a TCP connection string');
  }
  return PostgresWireClient.connect(
    {
      kind: 'tcp',
      host: endpoint.hostname,
      port: Number.parseInt(endpoint.port, 10),
    },
    decodeURIComponent(endpoint.username),
    decodeURIComponent(endpoint.pathname.slice(1)),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the TypeScript SDK native smoke check`);
  return value;
}

await main();
