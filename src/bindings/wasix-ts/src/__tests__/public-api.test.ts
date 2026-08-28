import { describe, expect, it } from 'vitest';

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
  type OpenConfig,
  type OliphauntTransaction,
  type QueryArrayRow,
  type QueryObjectRow,
  type QueryResult,
  type QueryParam,
  type QueryValue,
  type RawQueryResult,
  type TextQueryParameter,
} from '../index.js';
import WorkerOliphaunt, { Oliphaunt as NamedWorkerOliphaunt } from '../worker-entry.js';

describe('WASIX public ORM surface', () => {
  // liboliphaunt-doc-example:wasix-typescript-direct-entrypoint
  // liboliphaunt-doc-example:wasix-typescript-worker-entrypoint
  it('publishes codecs and PostgreSQL metadata from the root entrypoint', () => {
    expect(typeof Oliphaunt.open).toBe('function');
    expect(WorkerOliphaunt).toBe(NamedWorkerOliphaunt);
    expect(typeof WorkerOliphaunt.open).toBe('function');
    expect(typeof PostgresError).toBe('function');
    expect(postgresOids.jsonb).toBe(3802);
    expect(text('value', postgresOids.text).format).toBe('text');
    expect(binary(Uint8Array.of(1), postgresOids.bytea).format).toBe('binary');
    expect(json({ ok: true }).typeOid).toBe(postgresOids.jsonb);
    expect(array([1, 2], postgresOids.int4Array).typeOid).toBe(postgresOids.int4Array);
    expect(typedNull(postgresOids.uuid).format).toBe('null');
  });
});

const canonicalPostgresError = new PostgresError([
  { code: 0x43, value: '22000' },
  { code: 0x4d, value: 'invalid value' },
]);
const canonicalSqlstate: string | undefined = canonicalPostgresError.sqlstate;
const canonicalMessage: string = canonicalPostgresError.message;
void [canonicalSqlstate, canonicalMessage];

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
  const execResults: Promise<ExecResult<readonly unknown[]>> = database.exec<readonly unknown[]>(
    'SELECT 1',
    { rowMode: 'array' },
  );
  const inferredArrays: Promise<QueryResult<QueryArrayRow>> = transaction.query('SELECT 1', [], {
    rowMode: 'array',
  });
  const inferredDecoder: Promise<QueryResult<QueryObjectRow<QueryValue | Date>>> = database.query(
    'SELECT now()',
    [],
    { decoders: { [postgresOids.timestamptz]: (value) => new Date(value) } },
  );
  const description: Promise<DescribeResult> = database.describe('SELECT $1', [postgresOids.int4]);
  const streamed: Promise<void> = database.execProtocolRawStream(Uint8Array.of(1), () => undefined);
  // @ts-expect-error Stream callbacks are synchronous backpressure acknowledgements.
  const asyncStreamed = database.execProtocolRawStream(Uint8Array.of(1), async () => {});
  const widenedAsyncCallback: (chunk: Uint8Array) => unknown = async () => {};
  const widenedAsyncStreamed = database.execProtocolRawStream(
    Uint8Array.of(1),
    // @ts-expect-error Widening an async callback must not bypass the synchronous contract.
    widenedAsyncCallback,
  );
  // @ts-expect-error Raw protocol is root-only; it bypasses callback transaction ownership.
  const transactionBuffered = transaction.execProtocolRaw(Uint8Array.of(1));
  // @ts-expect-error Raw protocol is root-only; it bypasses callback transaction ownership.
  const transactionStreamed = transaction.execProtocolRawStream(Uint8Array.of(1), () => undefined);
  const rollback: Promise<void> = transaction.rollback();
  const closed: boolean = database.closed || transaction.closed;
  void [
    decoded,
    raw,
    execResults,
    inferredArrays,
    inferredDecoder,
    description,
    streamed,
    asyncStreamed,
    widenedAsyncStreamed,
    transactionBuffered,
    transactionStreamed,
    rollback,
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

const openConfig: OpenConfig = { username: 'application' };
void openConfig;
