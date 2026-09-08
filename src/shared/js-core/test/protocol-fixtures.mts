import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function assertSharedProtocolFixtures(options) {
  const fixtureUrl = new URL('../../fixtures/protocol/query-response-cases.json', import.meta.url);
  const corpus = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.kind, 'postgres-backend-query-response');
  assert.ok(corpus.cases.length > 0, 'shared protocol corpus is empty');

  const names = new Set();
  for (const fixture of corpus.cases) {
    assert.equal(names.has(fixture.name), false, `duplicate fixture ${fixture.name}`);
    names.add(fixture.name);
    const expectation = fixture.queryExpectation;
    if (expectation === undefined) continue;

    const bytes = hexToBytes(fixture.responseHex);
    const parseQueryResponse = parserForFixture(fixture, options);
    if (expectation.ok !== undefined) {
      assertOk(fixture.name, expectation.ok, parseQueryResponse(bytes));
    } else if (expectation.postgresError !== undefined) {
      const thrown = thrownBy(() => parseQueryResponse(bytes));
      assert.ok(options.isPostgresError(thrown), `${fixture.name} should throw PostgresError`);
      assert.equal(thrown.severity, expectation.postgresError.severity, `${fixture.name} severity`);
      assert.equal(thrown.sqlstate, expectation.postgresError.sqlstate, `${fixture.name} SQLSTATE`);
      assert.equal(
        thrown.message,
        expectation.postgresError.message,
        `${fixture.name} PostgreSQL message`,
      );
    } else if (expectation.engineErrorContains !== undefined) {
      const thrown = thrownBy(() => parseQueryResponse(bytes));
      assert.ok(thrown instanceof Error, `${fixture.name} should throw Error`);
      assert.ok(
        thrown.message.includes(expectation.engineErrorContains),
        `${fixture.name} error ${JSON.stringify(thrown.message)} did not contain ${JSON.stringify(expectation.engineErrorContains)}`,
      );
    } else {
      assert.fail(`shared protocol fixture ${fixture.name} has no query expectation`);
    }
  }
}

function parserForFixture(fixture, options) {
  const modes = fixture.protocolModeExpectation;
  return modes?.extendedQuery?.outcome === 'ok' && modes?.simpleCommand?.outcome !== 'ok'
    ? options.parseExtendedQueryResponse
    : options.parseSimpleQueryResponse;
}

function assertOk(name, expected, actual) {
  assert.equal(actual.rowCount, expected.rowCount, `${name} row count`);
  assert.equal(actual.commandTag, expected.commandTag, `${name} command tag`);
  assert.equal(actual.fields.length, expected.fields.length, `${name} field count`);
  assert.equal(actual.rows.length, expected.rows.length, `${name} rows size`);

  for (const [index, expectedField] of expected.fields.entries()) {
    const actualField = actual.fields[index];
    assert.ok(actualField, `${name} missing field ${index}`);
    assert.equal(actualField.name, expectedField.name, `${name} field name`);
    assert.equal(actualField.typeOid, expectedField.typeOid, `${name} type OID`);
    if (expectedField.format === 'text') {
      assert.equal(actualField.format, 'text', `${name} field format`);
    }
  }

  for (const [rowIndex, expectedRow] of expected.rows.entries()) {
    assert.equal(expectedRow.length, expected.fields.length, `${name} expected row width`);
    for (const [columnIndex, expectedValue] of expectedRow.entries()) {
      const field = expected.fields[columnIndex];
      assert.ok(field, `${name} missing expected field ${columnIndex}`);
      assert.equal(
        actual.getText(rowIndex, field.name),
        expectedValue,
        `${name} row ${rowIndex} column ${field.name}`,
      );
    }
  }
}

function hexToBytes(hex) {
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

function thrownBy(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('expected callback to throw');
}
