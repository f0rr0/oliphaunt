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
    assert.equal(
      (await database.query(`SELECT '${label}'::text AS value`)).getText(0, 'value'),
      label,
    );
    const backup = await database.backup();
    assert.ok(backup.byteLength > 0);
    assert.equal(
      (await database.query(`SELECT '${label}'::text AS value`)).getText(0, 'value'),
      label,
    );
    await database.close();
    database = undefined;

    const restoredRoot = join(root, 'restored');
    await Oliphaunt.restore(restoredRoot, backup);
    assert.match(await readFile(join(restoredRoot, 'pgdata', 'PG_VERSION'), 'utf8'), /^18\s*$/u);
    database = await Oliphaunt.open({
      ...config,
      storage: { kind: 'directory', path: restoredRoot },
    });
    assert.equal(
      (await database.query(`SELECT '${label}'::text AS value`)).getText(0, 'value'),
      label,
    );
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
