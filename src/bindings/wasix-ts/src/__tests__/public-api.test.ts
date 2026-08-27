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
  type ProtocolChunkCallback,
  type OliphauntTransaction,
  type QueryResult,
  type QueryParam,
  type RawQueryResult,
  type TextQueryParameter,
} from '../index.js';
import BlockingOliphaunt, {
  Oliphaunt as NamedBlockingOliphaunt,
} from '../blocking.js';

describe('WASIX public ORM surface', () => {
  // liboliphaunt-doc-example:wasix-typescript-worker-entrypoint
  // liboliphaunt-doc-example:wasix-typescript-blocking-entrypoint
  it('publishes codecs and PostgreSQL metadata from the root entrypoint', () => {
    expect(typeof Oliphaunt.open).toBe('function');
    expect(BlockingOliphaunt).toBe(NamedBlockingOliphaunt);
    expect(typeof BlockingOliphaunt.open).toBe('function');
    expect(typeof PostgresError).toBe('function');
    expect(postgresOids.jsonb).toBe(3802);
    expect(text('value', postgresOids.text).format).toBe('text');
    expect(binary(Uint8Array.of(1), postgresOids.bytea).format).toBe('binary');
    expect(json({ ok: true }).typeOid).toBe(postgresOids.jsonb);
    expect(array([1, 2], postgresOids.int4Array).typeOid).toBe(
      postgresOids.int4Array,
    );
    expect(typedNull(postgresOids.uuid).format).toBe('null');
  });
});

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
  const execResults: Promise<ExecResult<readonly unknown[]>> = database.exec<
    readonly unknown[]
  >('SELECT 1', { rowMode: 'array' });
  const description: Promise<DescribeResult> = database.describe('SELECT $1', [
    postgresOids.int4,
  ]);
  const streamed: Promise<void> = database.execProtocolRawStream(
    Uint8Array.of(1),
    () => undefined,
  );
  const transactionStreamed: Promise<void> = transaction.execProtocolRawStream(
    Uint8Array.of(1),
    () => undefined,
  );
  const rollback: Promise<void> = transaction.rollback();
  const closed: boolean = database.closed || transaction.closed;
  void [
    decoded,
    raw,
    execResults,
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

const protocolConsumer: ProtocolChunkCallback = () => undefined;
void protocolConsumer;

const openConfig: OpenConfig = {
  username: 'application',
  // @ts-expect-error Calling semantics are selected by entrypoint, not configuration.
  execution: 'direct',
};
void openConfig;
