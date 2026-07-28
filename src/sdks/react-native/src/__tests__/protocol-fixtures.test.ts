import assert from 'node:assert/strict';
import { test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseQueryResponse, PostgresError } from '../query';

function testQueryParserMatchesSharedProtocolFixtures(): void {
  const fixturePath = sharedProtocolFixturePath();
  if (fixturePath === undefined) {
    return;
  }

  const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as SharedProtocolFixtureCorpus;
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.kind, 'postgres-backend-query-response');
  assert.ok(corpus.cases.length > 0, 'shared protocol corpus is empty');

  const names = new Set<string>();
  for (const fixture of corpus.cases) {
    assert.equal(names.has(fixture.name), false, `duplicate fixture ${fixture.name}`);
    names.add(fixture.name);
    const expectation = fixture.queryExpectation;
    if (expectation === undefined) {
      continue;
    }
    const bytes = hexToBytes(fixture.responseHex);
    if (expectation.ok !== undefined) {
      assertSharedProtocolOkFixture(fixture, expectation.ok, bytes);
    } else if (expectation.postgresError !== undefined) {
      assertSharedProtocolPostgresErrorFixture(fixture, expectation.postgresError, bytes);
    } else if (expectation.engineErrorContains !== undefined) {
      assertSharedProtocolEngineErrorFixture(fixture, expectation.engineErrorContains, bytes);
    } else {
      assert.fail(`shared protocol fixture ${fixture.name} has no query expectation`);
    }
  }
}

function assertSharedProtocolOkFixture(
  fixture: SharedProtocolFixtureCase,
  expected: SharedProtocolOkExpectation,
  bytes: Uint8Array,
): void {
  const result = parseQueryResponse(bytes);
  assert.equal(result.rowCount, expected.rowCount, `${fixture.name} row count`);
  assert.equal(result.commandTag, expected.commandTag, `${fixture.name} command tag`);
  assert.equal(result.fields.length, expected.fields.length, `${fixture.name} field count`);
  assert.equal(result.rows.length, expected.rows.length, `${fixture.name} rows size`);

  for (const [index, expectedField] of expected.fields.entries()) {
    const actual = result.fields[index];
    assert.ok(actual, `${fixture.name} missing field ${index}`);
    assert.equal(actual.name, expectedField.name, `${fixture.name} field name`);
    assert.equal(actual.typeOid, expectedField.typeOid, `${fixture.name} type OID`);
    if (expectedField.format === 'text') {
      assert.equal(actual.format, 'text', `${fixture.name} field format`);
    }
  }

  for (const [rowIndex, expectedRow] of expected.rows.entries()) {
    assert.equal(expectedRow.length, expected.fields.length, `${fixture.name} expected row width`);
    for (const [columnIndex, expectedValue] of expectedRow.entries()) {
      const field = expected.fields[columnIndex];
      assert.ok(field, `${fixture.name} missing expected field ${columnIndex}`);
      assert.equal(
        result.getText(rowIndex, field.name),
        expectedValue,
        `${fixture.name} row ${rowIndex} column ${field.name}`,
      );
    }
  }
}

function assertSharedProtocolPostgresErrorFixture(
  fixture: SharedProtocolFixtureCase,
  expected: SharedProtocolPostgresErrorExpectation,
  bytes: Uint8Array,
): void {
  const thrown = thrownBy(() => parseQueryResponse(bytes));
  assert.ok(thrown instanceof PostgresError, `${fixture.name} should throw PostgresError`);
  assert.equal(thrown.severity, expected.severity, `${fixture.name} severity`);
  assert.equal(thrown.sqlstate, expected.sqlstate, `${fixture.name} SQLSTATE`);
  assert.equal(thrown.postgresMessage, expected.message, `${fixture.name} PostgreSQL message`);
}

function assertSharedProtocolEngineErrorFixture(
  fixture: SharedProtocolFixtureCase,
  expected: string,
  bytes: Uint8Array,
): void {
  const thrown = thrownBy(() => parseQueryResponse(bytes));
  assert.ok(thrown instanceof Error, `${fixture.name} should throw Error`);
  assert.ok(
    thrown.message.includes(expected),
    `${fixture.name} error ${JSON.stringify(thrown.message)} did not contain ${JSON.stringify(
      expected,
    )}`,
  );
}

function sharedProtocolFixturePath(): string | undefined {
  const candidates = [
    path.resolve(
      process.cwd(),
      '..',
      '..',
      '..',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      '..',
      '..',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      'shared',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      '..',
      'shared',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      '..',
      'src',
      'shared',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
    path.resolve(
      process.cwd(),
      'src',
      'shared',
      'fixtures',
      'protocol',
      'query-response-cases.json',
    ),
  ];
  return candidates.find(existsSync);
}

function hexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/\s+/g, '');
  assert.equal(compact.length % 2, 0, 'hex fixture must have an even digit count');
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    assert.ok(Number.isInteger(byte), 'hex fixture contains invalid byte');
    bytes[index] = byte;
  }
  return bytes;
}

function thrownBy(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('expected callback to throw');
}

type SharedProtocolFixtureCorpus = {
  schemaVersion: number;
  kind: string;
  cases: SharedProtocolFixtureCase[];
};

type SharedProtocolFixtureCase = {
  name: string;
  responseHex: string;
  queryExpectation?: SharedProtocolQueryExpectation;
};

type SharedProtocolQueryExpectation = {
  ok?: SharedProtocolOkExpectation;
  postgresError?: SharedProtocolPostgresErrorExpectation;
  engineErrorContains?: string;
};

type SharedProtocolOkExpectation = {
  fields: SharedProtocolFieldExpectation[];
  rows: Array<Array<string | null>>;
  commandTag?: string;
  rowCount: number;
};

type SharedProtocolFieldExpectation = {
  name: string;
  typeOid: number;
  format?: string;
};

type SharedProtocolPostgresErrorExpectation = {
  severity: string;
  sqlstate: string;
  message: string;
};

test('protocol fixtures', () => {
  testQueryParserMatchesSharedProtocolFixtures();
});
