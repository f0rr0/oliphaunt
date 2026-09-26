import { type OliphauntDatabase, postgresOids } from '@oliphaunt/wasix-ts';

type StructuredObjectRow = {
  answer: number;
  wide: string;
  document: { ok: boolean };
  numbers: number[];
};

/** Exercise the ORM-facing structured API against a real WASIX database. */
export async function expectStructuredApi(
  database: OliphauntDatabase,
  label: string,
): Promise<void> {
  const walSyncMethod = (await database.queryRaw('SHOW wal_sync_method')).getText(
    0,
    'wal_sync_method',
  );
  if (walSyncMethod !== 'fdatasync') {
    throw new Error(
      `${label} expected the compiled WASIX wal_sync_method default, received ${JSON.stringify(walSyncMethod)}`,
    );
  }

  const decoded = await database.query<StructuredObjectRow>(
    'SELECT $1::int4 AS answer, $2::int8 AS wide, $3::jsonb AS document, $4::int4[] AS numbers',
    [42, 9007199254740993n, { ok: true }, [1, 2, 3]],
  );
  const objectRow = decoded.rows[0];
  if (
    objectRow?.answer !== 42 ||
    objectRow.wide !== '9007199254740993' ||
    objectRow.document.ok !== true ||
    JSON.stringify(objectRow.numbers) !== '[1,2,3]'
  ) {
    throw new Error(`${label} decoded object-row contract failed: ${JSON.stringify(objectRow)}`);
  }

  const positional = await database.query<readonly unknown[]>(
    'SELECT 41::int4 AS left, 42::int4 AS right',
    [],
    { rowMode: 'array' },
  );
  if (JSON.stringify(positional.rows) !== '[[41,42]]') {
    throw new Error(
      `${label} decoded array-row contract failed: ${JSON.stringify(positional.rows)}`,
    );
  }

  const custom = await database.query<{ answer: string }>('SELECT 42::int4 AS answer', [], {
    decoders: {
      [postgresOids.int4]: (value, field) => `custom:${value}:${field.typeOid}`,
    },
  });
  if (custom.rows[0]?.answer !== 'custom:42:23') {
    throw new Error(`${label} OID decoder contract failed: ${JSON.stringify(custom.rows)}`);
  }

  const description = await database.describe('SELECT $1::int4 AS answer');
  if (
    description.parameterTypeOids[0] !== postgresOids.int4 ||
    description.fields?.[0]?.typeOid !== postgresOids.int4
  ) {
    throw new Error(`${label} describe contract failed: ${JSON.stringify(description)}`);
  }

  const execution = await database.exec('SELECT 1::int4 AS first; SELECT 2::int4 AS second');
  if (
    execution.statements.length !== 2 ||
    execution.statements[0]?.rows[0]?.first !== 1 ||
    execution.statements[1]?.rows[0]?.second !== 2
  ) {
    throw new Error(`${label} multi-statement exec contract failed: ${JSON.stringify(execution)}`);
  }
}
