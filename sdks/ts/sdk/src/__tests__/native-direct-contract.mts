import assert from 'node:assert/strict';
import { join } from 'node:path';
import { simpleQuery } from '@oliphaunt/ts-query/protocol';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from '../types.js';

export async function assertNativeDatabaseContract(
  Oliphaunt: OliphauntClient,
  config: Omit<OpenConfig, 'storage'>,
  label: string,
) {
  // Direct close detaches a logical session; only process exit releases its root.
  // The Shell caller runs each phase in a fresh host and cleans up after exit.
  const workspace = process.env.OLIPHAUNT_SMOKE_ROOT;
  const phase = process.env.OLIPHAUNT_SMOKE_PHASE;
  assert.ok(workspace, 'OLIPHAUNT_SMOKE_ROOT is required');
  assert.ok(phase === 'source' || phase === 'restored', 'expected source or restored smoke phase');
  const root = join(workspace, label);
  const sourceRoot = join(root, 'source');
  const restoredRoot = join(root, 'restored');
  let database: OliphauntDatabase | undefined;
  try {
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: phase === 'source' ? sourceRoot : restoredRoot },
    });
    await assertStructuredQueryContract(database, label);
    await assertOrmSurfaceContract(database, label);
    if (phase === 'restored') {
      const restored = await database.query('SELECT value FROM backup_probe');
      assert.deepEqual(restored.rows, [{ value: label }]);
      return;
    }
    const callbackError = new Error('stream consumer stopped');
    let callbacks = 0;
    await assert.rejects(
      database.execProtocolRawStream(simpleQuery('SELECT generate_series(1, 1000)'), () => {
        callbacks += 1;
        throw callbackError;
      }),
      (error) => error === callbackError,
    );
    assert.equal(callbacks, 1);
    assert.deepEqual((await database.query('SELECT 42 AS answer')).rows, [{ answer: 42 }]);
    await database.exec('CREATE TABLE backup_probe (value text NOT NULL)');
    await database.query('INSERT INTO backup_probe VALUES ($1)', [label]);
    const backup = await database.backup();
    assert.ok(backup.byteLength > 0);
    await assertStructuredQueryContract(database, label);
    await database.close();
    database = undefined;

    await Oliphaunt.restore(restoredRoot, backup);
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: sourceRoot },
    });
    await assertStructuredQueryContract(database, label);
    await database.close();
    database = undefined;

    await assert.rejects(
      Oliphaunt.restore(join(root, 'invalid'), backup.subarray(0, 8)),
      (error) => error instanceof Error && error.message.length > 0,
    );
  } finally {
    await database?.close();
  }
}

async function assertStructuredQueryContract(database: OliphauntDatabase, label: string) {
  const sql = `SELECT '${label}'::text AS value`;
  const decoded = await database.query(sql);
  assert.deepEqual(decoded.rows, [{ value: label }]);

  const positional = await database.query(sql, [], { rowMode: 'array' });
  assert.deepEqual(positional.rows, [[label]]);

  const raw = await database.queryRaw(sql);
  assert.equal(raw.getText(0, 'value'), label);
}

async function assertOrmSurfaceContract(database: OliphauntDatabase, label: string) {
  const decoded = await database.query(
    'SELECT $1::text AS label, $2::int8 AS wide, $3::jsonb AS document, $4::int4[] AS numbers',
    [label, 9007199254740993n, { ok: true }, [1, 2, 3]],
  );
  assert.deepEqual(decoded.rows, [
    {
      label,
      wide: '9007199254740993',
      document: { ok: true },
      numbers: [1, 2, 3],
    },
  ]);

  const custom = await database.query('SELECT 42::int4 AS answer', [], {
    decoders: { 23: (value, field) => `custom:${value}:${field.typeOid}` },
  });
  assert.deepEqual(custom.rows, [{ answer: 'custom:42:23' }]);

  const description = await database.describe('SELECT $1::int4 AS answer');
  assert.deepEqual(description.parameterTypeOids, [23]);
  assert.equal(description.fields?.[0]?.typeOid, 23);

  const execution = await database.exec('SELECT 1::int4 AS first; SELECT 2::int4 AS second');
  assert.deepEqual(
    execution.statements.map((statement) => statement.rows),
    [[{ first: 1 }], [{ second: 2 }]],
  );
}
