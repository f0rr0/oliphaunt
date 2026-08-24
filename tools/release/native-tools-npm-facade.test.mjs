import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PostgresToolError,
  pgDump,
  psql,
} from '../../src/runtimes/liboliphaunt/native/tools-npm/index.js';

const fixture = JSON.parse(
  await readFile(
    new URL('../../src/shared/fixtures/postgres/logical-tools.json', import.meta.url),
    'utf8',
  ),
);

test('native npm tools accept every shared ordinary argument before process startup', async () => {
  for (const argument of fixture.pgDump.acceptedArgs) {
    await assert.rejects(
      pgDump('postgresql://postgres@127.0.0.1:1/postgres', { args: [argument] }),
      (error) => error instanceof PostgresToolError && error.tool === 'pg_dump',
      argument,
    );
  }
  for (const argument of fixture.psql.acceptedArgs) {
    await assert.rejects(
      psql('postgresql://postgres@127.0.0.1:1/postgres', {
        args: [argument],
        command: 'SELECT 1',
      }),
      (error) => error instanceof PostgresToolError && error.tool === 'psql',
      argument,
    );
  }
});

test('native npm tools reject every shared managed pg_dump argument', async () => {
  for (const argument of fixture.pgDump.rejectedArgs) {
    await assert.rejects(
      pgDump('postgresql://postgres@127.0.0.1/postgres', { args: [argument] }),
      /conflicts with Oliphaunt's managed/u,
      argument,
    );
  }
});

test('native npm tools reject every shared managed psql argument', async () => {
  for (const argument of fixture.psql.rejectedArgs) {
    await assert.rejects(
      psql('postgresql://postgres@127.0.0.1/postgres', {
        args: [argument],
        command: 'SELECT 1',
      }),
      /conflicts with Oliphaunt's managed/u,
      argument,
    );
  }
});

test('native npm psql requires one non-interactive input form', async () => {
  await assert.rejects(
    psql('postgresql://postgres@127.0.0.1/postgres'),
    /requires non-interactive input/u,
  );
  await assert.rejects(
    psql('postgresql://postgres@127.0.0.1/postgres', {
      command: 'SELECT 1',
      script: 'SELECT 2;',
    }),
    /command or script, not both/u,
  );
});

test('native npm tools preserve a structured process failure', async () => {
  await assert.rejects(
    pgDump('postgresql://postgres@127.0.0.1:1/postgres'),
    (error) => error instanceof PostgresToolError && error.tool === 'pg_dump',
  );
});
