#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { compareText } from '../../../../shared/product-metadata/release-artifact-targets.mts';

const PREFIX = 'ios-extension-registration.mts';
const SCHEMA = 'oliphaunt-ios-extension-registration-v1';
const PORTABLE_RE = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function lines(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readRegistrationSymbols(out, stem) {
  const root = path.join(out, 'extensions', stem);
  const exported = lines(path.join(root, 'symbols.list')).map((name) => ({ name, address: name }));
  const aliasFile = path.join(root, 'symbol-aliases.list');
  const aliases = (existsSync(aliasFile) ? lines(aliasFile) : []).map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 2) {
      fail(`${aliasFile} contains an invalid alias row`);
    }
    return { name: fields[0], address: fields[1] };
  });
  const result = [...exported, ...aliases].sort((left, right) =>
    compareText(`${left.name}\0${left.address}`, `${right.name}\0${right.address}`),
  );
  for (const row of result) {
    if (!C_IDENTIFIER_RE.test(row.name) || !C_IDENTIFIER_RE.test(row.address)) {
      fail(`${root} contains a non-C registration symbol`);
    }
  }
  if (new Set(result.map(({ name }) => name)).size !== result.length) {
    fail(`${root} repeats a SQL-visible registration symbol`);
  }
  return result;
}

export function assertDefinedRegistrationAddresses(symbols, defined, label) {
  const missing = [
    ...new Set(symbols.map(({ address }) => address).filter((address) => !defined.has(address))),
  ].sort(compareText);
  if (missing.length > 0) {
    throw new Error(
      `${label} registration address(es) are not defined by its extension objects: ${missing.join(',')}`,
    );
  }
}

function definedSymbols(file) {
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) fail('nm output exceeds 64 MiB');
  const names = new Set();
  for (const raw of text.split(/\r?\n/u)) {
    const fields = raw.trim().split(/\s+/u);
    if (fields.length < 2) continue;
    const type = fields.at(-2);
    const rawName = fields.at(-1);
    if (!/^[A-Za-z]$/u.test(type) || type.toUpperCase() === 'U') continue;
    names.add(rawName.startsWith('_') ? rawName.slice(1) : rawName);
  }
  return names;
}

function registration(out, sqlName, stem, inventory) {
  const prefix = `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`;
  const names = definedSymbols(inventory);
  const magicSymbol = `${prefix}_Pg_magic_func`;
  if (!names.has(magicSymbol)) {
    fail(`${out} ${sqlName} archive does not export required ${magicSymbol}`);
  }
  const init = `${prefix}__PG_init`;
  const symbols = readRegistrationSymbols(out, stem);
  try {
    assertDefinedRegistrationAddresses(symbols, names, `${out} ${sqlName}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return {
    initSymbol: names.has(init) ? init : null,
    magicSymbol,
    symbols,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

if (import.meta.main) {
  const [sqlName, nativeModuleStem, simulatorOut, deviceOut, macosOut, outputFile, symbolsDir] =
    process.argv.slice(2);
  if (
    process.argv.length !== 9 ||
    !PORTABLE_RE.test(sqlName) ||
    !PORTABLE_RE.test(nativeModuleStem)
  )
    fail(
      'usage: ios-extension-registration.mts SQL STEM SIMULATOR DEVICE MACOS OUTPUT NM_DIRECTORY',
    );
  const [simulator, device, macos] = [simulatorOut, deviceOut, macosOut].map((out, index) =>
    registration(out, sqlName, nativeModuleStem, path.join(symbolsDir, index + '.txt')),
  );
  if (
    JSON.stringify(simulator) !== JSON.stringify(device) ||
    JSON.stringify(simulator) !== JSON.stringify(macos)
  ) {
    fail(`${sqlName} macOS, iOS simulator, and iOS device registration metadata differ`);
  }
  const output = stable({
    schema: SCHEMA,
    sqlName: sqlName,
    nativeModuleStem: nativeModuleStem,
    ...simulator,
  });
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
