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
  type OliphauntTransaction,
  type OpenConfig,
  type ProtocolChunkCallback,
  type QueryResult,
  type QueryParam,
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
  assert.equal(
    array([1, 2], postgresOids.int4Array).typeOid,
    postgresOids.int4Array,
  );
  assert.equal(typedNull(postgresOids.uuid).format, 'null');
});

// Compile-time proof from the external root surface. Keeping this function
// uncalled verifies declarations without needing a native runtime in the test.
function assertPublicDatabaseTypes(
  database: OliphauntDatabase,
  transaction: OliphauntTransaction,
): void {
  const decoded: Promise<QueryResult<{ value: number }>> = database.query<{
    value: number;
  }>('SELECT $1::int4 AS value', [1], { rowMode: 'object' });
  const raw: Promise<RawQueryResult> = database.queryRaw('SELECT $1::bytea', [
    binary(Uint8Array.of(1), postgresOids.bytea),
  ]);
  const execution: Promise<ExecResult<readonly unknown[]>> = database.exec<
    readonly unknown[]
  >('SELECT 1', { rowMode: 'array' });
  const description: Promise<DescribeResult> = database.describe('SELECT $1', [
    postgresOids.int4,
  ]);
  const streamed: Promise<void> = database.execProtocolRawStream(
    Uint8Array.of(0x51),
    () => undefined,
  );
  const transactionStreamed: Promise<void> = transaction.execProtocolRawStream(
    Uint8Array.of(0x51),
    () => undefined,
  );
  const rollback: Promise<void> = transaction.rollback();
  const closed: boolean = database.closed || transaction.closed;
  void [
    decoded,
    raw,
    execution,
    description,
    streamed,
    transactionStreamed,
    rollback,
    closed,
  ];
}

void assertPublicDatabaseTypes;

const publicHelperTypes: [
  TextQueryParameter,
  BinaryQueryParameter,
  NullQueryParameter,
] = [text('value'), binary(Uint8Array.of(1)), typedNull(postgresOids.text)];
void publicHelperTypes;

const publicProtocolCallback: ProtocolChunkCallback = (_chunk) => undefined;
const publicRestoreOptions: RestoreOptions = { libraryPath: '/opt/liboliphaunt.so' };
const publicTopology: OpenConfig = { topology: 'broker' };
// @ts-expect-error Server selection is explicit through Oliphaunt.openServer().
const removedServerTopology: OpenConfig = { topology: 'server' };
// @ts-expect-error The native selector is topology; execution is not a compatibility alias.
const removedExecutionSelector: OpenConfig = { execution: 'broker' };
void [
  publicProtocolCallback,
  publicRestoreOptions,
  publicTopology,
  removedServerTopology,
  removedExecutionSelector,
];

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
