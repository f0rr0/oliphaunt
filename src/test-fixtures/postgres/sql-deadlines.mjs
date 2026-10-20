import { PostgresError } from '@oliphaunt/wasix-ts';
import fixture from './sql-deadlines.json' with { type: 'json' };

/** @param {import('@oliphaunt/wasix-ts').OliphauntDatabase} database */
export async function expectSqlDeadlines(database) {
  for (const sql of [fixture.cpuQuery, fixture.waitQuery]) {
    await database.execute(`SET statement_timeout = ${fixture.timeoutMilliseconds}`);
    await expectTimeout(() => database.queryRaw(sql));
    await database.execute('SET statement_timeout = 0');
    await database.queryRaw(fixture.completedQuery);
  }

  // Replacing a pending deadline must not retain the earlier expiry.
  await database.execute(`SET statement_timeout = ${fixture.timeoutMilliseconds}`);
  await database.execute('SET statement_timeout = 500');
  await database.queryRaw(fixture.completedQuery);
  await database.execute('SET statement_timeout = 0');

  await database.execute('CREATE TABLE deadline_rollback_probe(value integer)');
  await database.execute('INSERT INTO deadline_rollback_probe VALUES (1)');
  await expectTimeout(() =>
    database.transaction(async (transaction) => {
      await transaction.execute('INSERT INTO deadline_rollback_probe VALUES (2)');
      await transaction.execute(`SET LOCAL statement_timeout = ${fixture.timeoutMilliseconds}`);
      await transaction.queryRaw(fixture.cpuQuery);
    }),
  );
  const count = (
    await database.queryRaw('SELECT count(*)::text AS value FROM deadline_rollback_probe')
  ).getText(0, 'value');
  if (count !== '1') throw new Error(`SQL timeout failed to roll back: ${count}`);
  await database.execute('DROP TABLE deadline_rollback_probe');
  const answer = (await database.queryRaw('SELECT 42::text AS value')).getText(0, 'value');
  if (answer !== '42') throw new Error(`SQL timeout failed to recover: ${answer}`);
}

/** @param {() => Promise<unknown>} operation */
async function expectTimeout(operation) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof PostgresError && error.sqlstate === fixture.expectedSqlstate) return;
    throw error;
  }
  throw new Error('statement_timeout did not cancel the statement');
}
