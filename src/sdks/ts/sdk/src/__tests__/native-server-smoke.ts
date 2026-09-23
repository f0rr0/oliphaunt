import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Oliphaunt } = await import(
  process.env.OLIPHAUNT_SMOKE_SDK
    ? pathToFileURL(process.env.OLIPHAUNT_SMOKE_SDK).href
    : new URL('../index.js', import.meta.url).href
);

export async function assertNativeServerContract(serverExecutable: string): Promise<void> {
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
        const connection = new pg.Client({
          connectionString: server.connectionString,
          connectionTimeoutMillis: 10_000,
          query_timeout: 10_000,
        });
        let identifier: string;
        try {
          await connection.connect();
          if (index === 0) {
            const one = await connection.query('SELECT $1::integer AS value', [1]);
            assert.equal(one.rows[0]?.value, 1);
          }
          const identity = await connection.query<{ system_identifier: string }>(
            'SELECT system_identifier::text AS system_identifier FROM pg_control_system()',
          );
          identifier = identity.rows[0]?.system_identifier ?? '';
        } finally {
          await connection.end();
        }
        assert.match(identifier, /^\d+$/u);
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

if (import.meta.main) {
  const postgres = process.env.OLIPHAUNT_POSTGRES;
  if (!postgres) throw new Error('OLIPHAUNT_POSTGRES is required for the native server smoke');
  await assertNativeServerContract(postgres);
}
