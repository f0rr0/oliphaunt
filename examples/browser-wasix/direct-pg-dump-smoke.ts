import type { OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { pgDump } from '@oliphaunt/wasix-tools';

export async function expectDirectPgDump(database: OliphauntDatabase): Promise<void> {
  await database.execute(
    'CREATE TABLE direct_pg_dump_probe (id integer PRIMARY KEY, value text NOT NULL)',
  );
  await database.execute("INSERT INTO direct_pg_dump_probe VALUES (1, 'same-realm')");

  const sql = await pgDump(database);
  if (!sql.includes('COPY public.direct_pg_dump_probe') || !sql.includes('same-realm')) {
    throw new Error('direct browser pg_dump did not preserve standard plain COPY output');
  }

  const result = await database.query('SELECT value FROM direct_pg_dump_probe WHERE id = 1');
  if (result.getText(0, 'value') !== 'same-realm') {
    throw new Error('direct browser database was not usable after pg_dump');
  }
}
