import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { pgDump, PostgresToolError, psql } from '../index.js';

type LogicalToolsFixture = Readonly<{
  pgDump: Readonly<{ acceptedArgs: readonly string[]; rejectedArgs: readonly string[] }>;
  psql: Readonly<{ acceptedArgs: readonly string[]; rejectedArgs: readonly string[] }>;
}>;

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../shared/fixtures/postgres/logical-tools.json', import.meta.url),
    'utf8',
  ),
) as LogicalToolsFixture;

// liboliphaunt-doc-example:wasix-typescript-tools
describe('WASIX tools public validation', () => {
  const database = {} as never;

  it('accepts every shared ordinary pg_dump argument before invoking the runtime', async () => {
    for (const argument of fixture.pgDump.acceptedArgs) {
      const failure = await pgDump(database, { args: [argument] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
  });

  it('rejects every shared managed pg_dump argument', async () => {
    for (const argument of fixture.pgDump.rejectedArgs) {
      await expect(pgDump(database, { args: [argument] })).rejects.toThrow(/managed/);
    }
  });

  it('requires one unambiguous non-interactive psql input', async () => {
    await expect(psql(database)).rejects.toThrow(/requires non-interactive input/);
    await expect(psql(database, { command: 'select 1', script: 'select 2' })).rejects.toThrow(
      /command or script/,
    );
    for (const argument of fixture.psql.rejectedArgs) {
      await expect(psql(database, { args: [argument] })).rejects.toThrow(/managed/);
    }
  });

  it('accepts every shared ordinary psql argument before invoking the runtime', async () => {
    for (const argument of fixture.psql.acceptedArgs) {
      const failure = await psql(database, { args: [argument], command: 'select 1' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
  });
});
