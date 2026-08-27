import type { OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { pgDump } from '@oliphaunt/wasix-tools';

export async function expectBlockingPgDump(database: OliphauntDatabase): Promise<void> {
  await database.execute(
    'CREATE TABLE blocking_pg_dump_probe (id integer PRIMARY KEY, value text NOT NULL)',
  );
  await database.execute("INSERT INTO blocking_pg_dump_probe VALUES (1, 'same-realm')");

  const sql = await pgDump(database);
  if (!sql.includes('COPY public.blocking_pg_dump_probe') || !sql.includes('same-realm')) {
    throw new Error('blocking browser pg_dump did not preserve standard plain COPY output');
  }

  const result = await database.queryRaw('SELECT value FROM blocking_pg_dump_probe WHERE id = 1');
  if (result.getText(0, 'value') !== 'same-realm') {
    throw new Error('blocking browser database was not usable after pg_dump');
  }
}
