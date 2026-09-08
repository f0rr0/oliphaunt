import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function assertNativeDatabaseContract(Oliphaunt, config, label) {
  const root = await mkdtemp(join(tmpdir(), `oliphaunt-js-${label}-`));
  let database;
  try {
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: root },
    });
    await assertStructuredQueryContract(database, label);
    await assertOrmSurfaceContract(database, label);
    const backup = await database.backup();
    assert.ok(backup.byteLength > 0);
    await assertStructuredQueryContract(database, label);
    await database.close();
    database = undefined;

    const restoredRoot = join(root, 'restored');
    await Oliphaunt.restore(restoredRoot, backup);
    assert.match(await readFile(join(restoredRoot, 'pgdata', 'PG_VERSION'), 'utf8'), /^18\s*$/u);
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: restoredRoot },
    });
    await assertStructuredQueryContract(database, label);
    await database.close();
    database = undefined;

    await assert.rejects(
      Oliphaunt.restore(join(root, 'invalid'), backup.subarray(0, 8)),
      (error) => error instanceof Error && error.message.length > 0,
    );
  } finally {
    await database?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function assertStructuredQueryContract(database, label) {
  const sql = `SELECT '${label}'::text AS value`;
  const decoded = await database.query(sql);
  assert.deepEqual(decoded.rows, [{ value: label }]);

  const positional = await database.query(sql, [], { rowMode: 'array' });
  assert.deepEqual(positional.rows, [[label]]);

  const raw = await database.queryRaw(sql);
  assert.equal(raw.getText(0, 'value'), label);
}

async function assertOrmSurfaceContract(database, label) {
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
