import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  array,
  binary,
  json,
  Oliphaunt,
  PostgresError,
  postgresOids,
  text,
  typedNull,
  type BinaryQueryParameter,
  type DescribeResult,
  type EncodedQueryParameter,
  type ExecResult,
  type NullQueryParameter,
  type OliphauntDatabase,
  type OliphauntServer,
  type OliphauntTransaction,
  type OpenConfig,
  type QueryArrayRow,
  type QueryObjectRow,
  type QueryResult,
  type QueryParam,
  type QueryValue,
  type RawQueryResult,
  type RestoreOptions,
  type TextQueryParameter,
} from '../index.js';

test('root entrypoint publishes the ORM-facing values', () => {
  assert.equal(typeof Oliphaunt.open, 'function');
  assert.equal(typeof PostgresError, 'function');
  assert.equal(postgresOids.jsonb, 3802);
  assert.equal(text('value', postgresOids.text).format, 'text');
  assert.equal(binary(Uint8Array.of(1), postgresOids.bytea).format, 'binary');
  assert.equal(json({ ok: true }).typeOid, postgresOids.jsonb);
  assert.equal(array([1, 2], postgresOids.int4Array).typeOid, postgresOids.int4Array);
  assert.equal(typedNull(postgresOids.uuid).format, 'null');
});

const canonicalPostgresError = new PostgresError([
  { code: 0x43, value: '22000' },
  { code: 0x4d, value: 'invalid value' },
]);
const canonicalSqlstate: string | undefined = canonicalPostgresError.sqlstate;
const canonicalMessage: string = canonicalPostgresError.message;
void [canonicalSqlstate, canonicalMessage];

// Compile-time proof from the external root surface. Keeping this function
// uncalled verifies declarations without needing a native runtime in the test.
function assertPublicDatabaseTypes(
  database: OliphauntDatabase,
  server: OliphauntServer,
  transaction: OliphauntTransaction,
): void {
  const decoded: Promise<QueryResult<{ value: number }>> = database.query<{
    value: number;
  }>('SELECT $1::int4 AS value', [1], { rowMode: 'object' });
  const raw: Promise<RawQueryResult> = database.queryRaw('SELECT $1::bytea', [
    binary(Uint8Array.of(1), postgresOids.bytea),
  ]);
  const execution: Promise<ExecResult<readonly unknown[]>> = database.exec<readonly unknown[]>(
    'SELECT 1',
    { rowMode: 'array' },
  );
  const inferredArrays: Promise<QueryResult<QueryArrayRow>> = database.query('SELECT 1', [], {
    rowMode: 'array',
  });
  const inferredDecoder: Promise<QueryResult<QueryObjectRow<QueryValue | Date>>> = database.query(
    'SELECT now()',
    [],
    { decoders: { [postgresOids.timestamptz]: (value) => new Date(value) } },
  );
  const description: Promise<DescribeResult> = database.describe('SELECT $1', [postgresOids.int4]);
  const streamed: Promise<void> = database.execProtocolRawStream(
    Uint8Array.of(0x51),
    () => undefined,
  );
  // @ts-expect-error Stream callbacks are synchronous backpressure acknowledgements.
  const asyncStreamed = database.execProtocolRawStream(Uint8Array.of(0x51), async () => {});
  const widenedAsyncCallback: (chunk: Uint8Array) => unknown = async () => {};
  const widenedAsyncStreamed = database.execProtocolRawStream(
    Uint8Array.of(0x51),
    // @ts-expect-error Widening an async callback must not bypass the synchronous contract.
    widenedAsyncCallback,
  );
  // @ts-expect-error Raw protocol is database/root-only; it bypasses callback transaction ownership.
  const transactionBuffered = transaction.execProtocolRaw(Uint8Array.of(0x51));
  // @ts-expect-error Raw protocol is database/root-only; it bypasses callback transaction ownership.
  const transactionStreamed = transaction.execProtocolRawStream(
    Uint8Array.of(0x51),
    () => undefined,
  );
  const rollback: Promise<void> = transaction.rollback();
  const serverConnectionString: string = server.connectionString;
  const serverClose: Promise<void> = server.close();
  // @ts-expect-error Server handles own lifecycle, not a privileged database connection.
  const serverQuery = server.query('SELECT 1');
  // @ts-expect-error External driver connections own their own cancellation.
  const serverCancel = server.cancel();
  // @ts-expect-error Server handles do not expose the embedded database backup format.
  const serverBackup = server.backup();
  // @ts-expect-error Raw protocol belongs to database connections, not listener ownership.
  const serverRaw = server.execProtocolRaw(Uint8Array.of(0x51));
  // @ts-expect-error Transactions belong to caller-owned database connections.
  const serverTransaction = server.transaction(() => undefined);
  const closed: boolean = database.closed || server.closed || transaction.closed;
  void [
    decoded,
    raw,
    execution,
    inferredArrays,
    inferredDecoder,
    description,
    streamed,
    asyncStreamed,
    widenedAsyncStreamed,
    transactionBuffered,
    transactionStreamed,
    rollback,
    serverConnectionString,
    serverClose,
    serverQuery,
    serverCancel,
    serverBackup,
    serverRaw,
    serverTransaction,
    closed,
  ];
}

void assertPublicDatabaseTypes;

const publicHelperTypes: [TextQueryParameter, BinaryQueryParameter, NullQueryParameter] = [
  text('value'),
  binary(Uint8Array.of(1)),
  typedNull(postgresOids.text),
];
void publicHelperTypes;

const publicRestoreOptions: RestoreOptions = { libraryPath: '/opt/liboliphaunt.so' };
const publicTopology: OpenConfig = { topology: 'broker' };
void [publicRestoreOptions, publicTopology];

const plainJsonParameter: QueryParam = {
  format: 'text',
  value: 'plain JSON data',
};
// @ts-expect-error Encoded parameters must be created by an exported helper.
const forgedEncodedParameter: EncodedQueryParameter = {
  format: 'text',
  value: 'forged',
};
void [plainJsonParameter, forgedEncodedParameter];
