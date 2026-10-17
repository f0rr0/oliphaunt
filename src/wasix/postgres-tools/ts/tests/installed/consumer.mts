import assert from 'node:assert/strict';
import { PostgresToolError, psql } from '@oliphaunt/wasix-tools';
import Oliphaunt from '@oliphaunt/wasix-ts';
import { expectDirectPgDump } from '../direct-pg-dump-smoke.ts';

assert.equal(new PostgresToolError('psql', 'installed probe').tool, 'psql');
const database = await Oliphaunt.open();
try {
  await expectDirectPgDump(database);
  assert.match(await psql(database, { command: 'SELECT 42 AS answer' }), /42/u);
  assert.equal((await database.queryRaw('SELECT 43 AS answer')).getText(0, 'answer'), '43');
} finally {
  await database.close();
}
