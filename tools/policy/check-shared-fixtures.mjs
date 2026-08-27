#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '../..');
const fixtureRoot = path.join(root, 'src/shared/fixtures');
const manifestPath = path.join(fixtureRoot, 'manifest.toml');
const manifest = Bun.TOML.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];

if (manifest.schema_version !== 1) {
  errors.push('src/shared/fixtures/manifest.toml must declare schema_version = 1');
}

const fixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
if (fixtures.length === 0) {
  errors.push('src/shared/fixtures/manifest.toml must declare at least one fixture');
}

const ids = new Set();
const paths = new Set();
const canonical = [];
for (const fixture of fixtures) {
  if (typeof fixture?.id !== 'string' || fixture.id.length === 0) {
    errors.push('every shared fixture must declare a non-empty id');
    continue;
  }
  if (ids.has(fixture.id)) errors.push(`duplicate shared fixture id ${JSON.stringify(fixture.id)}`);
  ids.add(fixture.id);

  if (typeof fixture?.path !== 'string' || fixture.path.length === 0) {
    errors.push(`shared fixture ${JSON.stringify(fixture.id)} must declare a non-empty path`);
    continue;
  }
  if (path.isAbsolute(fixture.path) || fixture.path.split('/').includes('..')) {
    errors.push(`shared fixture ${JSON.stringify(fixture.id)} must stay inside src/shared/fixtures`);
    continue;
  }
  if (paths.has(fixture.path)) {
    errors.push(`duplicate shared fixture path ${JSON.stringify(fixture.path)}`);
  }
  paths.add(fixture.path);

  const absolute = path.join(fixtureRoot, fixture.path);
  if (!existsSync(absolute)) {
    errors.push(`missing shared fixture src/shared/fixtures/${fixture.path}`);
    continue;
  }
  canonical.push({ absolute, relative: `src/shared/fixtures/${fixture.path}` });
}

const candidates = [];
for (const entry of walk(path.join(root, 'src'))) {
  if (!entry.startsWith(`${fixtureRoot}${path.sep}`)) candidates.push(entry);
}

for (const fixture of canonical) {
  if (path.extname(fixture.absolute) === '.json') {
    validateUniqueJsonKeys(readFileSync(fixture.absolute, 'utf8'), fixture.relative);
  }
  const expected = readFileSync(fixture.absolute);
  for (const candidate of candidates) {
    if (path.extname(candidate) !== path.extname(fixture.absolute)) continue;
    const actual = readFileSync(candidate);
    if (actual.length === expected.length && actual.equals(expected)) {
      errors.push(
        `${path.relative(root, candidate)} duplicates canonical shared fixture ${fixture.relative}`,
      );
    }
  }
}

validateQueryResponseContract();
validateJsonKeyScannerSelfCheck();

if (errors.length > 0) {
  for (const error of errors) console.error(`shared fixture contract: ${error}`);
  process.exit(1);
}

console.log(`shared fixture contract passed (${canonical.length} canonical fixtures)`);

function validateQueryResponseContract() {
  const relative = 'protocol/query-response-cases.json';
  const absolute = path.join(fixtureRoot, relative);
  if (!existsSync(absolute)) return;

  let contract;
  try {
    contract = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    errors.push(`${relative} must be valid JSON: ${error.message}`);
    return;
  }
  if (contract.schemaVersion !== 1) {
    errors.push(`${relative} must declare schemaVersion 1`);
  }
  if (contract.kind !== 'postgres-backend-query-response') {
    errors.push(`${relative} must declare the postgres-backend-query-response kind`);
  }

  const expectedTypeOids = {
    xmlArray: 143,
    charArray: 1002,
    nameArray: 1003,
    timetz: 1266,
    timetzArray: 1270,
  };
  for (const [name, value] of Object.entries(expectedTypeOids)) {
    if (contract.typeOids?.[name] !== value) {
      errors.push(`${relative} typeOids.${name} must equal ${value}`);
    }
  }

  if (!Array.isArray(contract.cases)) {
    errors.push(`${relative} must declare a cases array`);
    return;
  }
  const cases = new Map();
  for (const fixture of contract.cases) {
    if (typeof fixture?.name !== 'string' || fixture.name.length === 0) {
      errors.push(`${relative} cases must have non-empty names`);
      continue;
    }
    if (cases.has(fixture.name)) {
      errors.push(`${relative} has duplicate case ${JSON.stringify(fixture.name)}`);
    }
    cases.set(fixture.name, fixture);
  }

  for (const name of [
    'extended_controls_insert',
    'bare_empty_without_extended_controls',
    'async_controls_before_command',
  ]) {
    validateProtocolModes(relative, name, cases.get(name)?.protocolModeExpectation);
  }

  const errorDiagnostic =
    cases.get('postgres_error_localized_severity_is_primary')?.queryExpectation?.postgresError;
  validateFiniteDiagnostic(relative, 'PostgreSQL error', errorDiagnostic, 'ERREUR', 'ERROR');

  const notices =
    cases.get('notice_with_finite_standard_diagnostics')?.queryExpectation?.ok?.notices;
  if (!Array.isArray(notices) || notices.length !== 1) {
    errors.push(`${relative} must declare exactly one finite standard notice diagnostic`);
  } else {
    validateFiniteDiagnostic(relative, 'PostgreSQL notice', notices[0], 'AVERTISSEMENT', 'WARNING');
  }
}

function validateProtocolModes(relative, caseName, expectation) {
  if (!expectation || typeof expectation !== 'object') {
    errors.push(`${relative} case ${caseName} must declare protocolModeExpectation`);
    return;
  }
  for (const mode of ['simpleCommand', 'extendedCommand', 'extendedQuery']) {
    const result = expectation[mode];
    if (!result || !['ok', 'engineError'].includes(result.outcome)) {
      errors.push(`${relative} case ${caseName} must declare ${mode} outcome`);
      continue;
    }
    if (result.outcome === 'ok' && !Object.hasOwn(result, 'commandTag')) {
      errors.push(`${relative} case ${caseName} ${mode} must declare commandTag`);
    }
    if (result.outcome === 'engineError' && !(typeof result.contains === 'string' && result.contains)) {
      errors.push(`${relative} case ${caseName} ${mode} must declare an error substring`);
    }
  }
}

function validateFiniteDiagnostic(relative, label, diagnostic, localized, nonlocalized) {
  const expected = {
    severity: localized,
    localizedSeverity: localized,
    nonlocalizedSeverity: nonlocalized,
    internalPosition: '12',
    internalQuery: 'SELECT broken',
    file: 'parse_expr.c',
    line: '123',
    routine: 'transformExpr',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (diagnostic?.[field] !== value) {
      errors.push(`${relative} ${label} ${field} must equal ${JSON.stringify(value)}`);
    }
  }
}

function validateUniqueJsonKeys(source, relative) {
  errors.push(...scanUniqueJsonKeys(source, relative));
}

function validateJsonKeyScannerSelfCheck() {
  const duplicate = scanUniqueJsonKeys('{"plain":1,"\\u0070lain":2}', '<duplicate-key-self-check>');
  if (!duplicate.some((error) => error.includes('duplicate JSON key $.plain'))) {
    errors.push('duplicate JSON key scanner must detect escaped-equivalent keys');
  }
  const invalidWhitespace = scanUniqueJsonKeys('{\u00a0"key":1}', '<whitespace-self-check>');
  if (!invalidWhitespace.some((error) => error.includes('must be valid JSON'))) {
    errors.push('duplicate JSON key scanner must reject non-JSON whitespace');
  }
}

function scanUniqueJsonKeys(source, relative) {
  let index = 0;
  const findings = [];

  function isJsonWhitespace(character) {
    return character === ' ' || character === '\t' || character === '\r' || character === '\n';
  }

  function skipWhitespace() {
    while (isJsonWhitespace(source[index])) index += 1;
  }

  function parseString() {
    skipWhitespace();
    const start = index;
    if (source[index] !== '"') throw new Error(`expected a string at byte ${index}`);
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error(`unterminated string at byte ${start}`);
  }

  function parseValue(jsonPath) {
    skipWhitespace();
    if (source[index] === '{') {
      parseObject(jsonPath);
      return;
    }
    if (source[index] === '[') {
      parseArray(jsonPath);
      return;
    }
    if (source[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (
      index < source.length &&
      !isJsonWhitespace(source[index]) &&
      ![',', ']', '}'].includes(source[index])
    ) {
      index += 1;
    }
    if (start === index) throw new Error(`expected a value at byte ${index}`);
    JSON.parse(source.slice(start, index));
  }

  function parseObject(jsonPath) {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (source[index] === '}') {
      index += 1;
      return;
    }
    while (index < source.length) {
      const key = parseString();
      const childPath = `${jsonPath}.${key}`;
      if (keys.has(key)) findings.push(`${relative} has duplicate JSON key ${childPath}`);
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ':') throw new Error(`expected ':' at byte ${index}`);
      index += 1;
      parseValue(childPath);
      skipWhitespace();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      if (source[index] !== ',') throw new Error(`expected ',' at byte ${index}`);
      index += 1;
    }
    throw new Error(`unterminated object at byte ${index}`);
  }

  function parseArray(jsonPath) {
    index += 1;
    skipWhitespace();
    if (source[index] === ']') {
      index += 1;
      return;
    }
    let element = 0;
    while (index < source.length) {
      parseValue(`${jsonPath}[${element}]`);
      element += 1;
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      if (source[index] !== ',') throw new Error(`expected ',' at byte ${index}`);
      index += 1;
    }
    throw new Error(`unterminated array at byte ${index}`);
  }

  try {
    parseValue('$');
    skipWhitespace();
    if (index !== source.length) throw new Error(`trailing data at byte ${index}`);
  } catch (error) {
    findings.push(`${relative} must be valid JSON: ${error.message}`);
  }
  return findings;
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'build' && entry.name !== 'lib') {
        yield* walk(absolute);
      }
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}
