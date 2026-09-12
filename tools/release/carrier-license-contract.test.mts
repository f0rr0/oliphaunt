import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BROKER_PAYLOAD_LICENSE } from '../../broker/tools/broker-dependency-license-contract.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const CODE_LICENSE = 'MIT';
const NATIVE_RUNTIME_LICENSE = 'MIT AND PostgreSQL AND Unicode-3.0';
const NATIVE_TOOLS_LICENSE = 'MIT AND PostgreSQL';
const ICU_CARRIER_LICENSE = 'MIT AND Unicode-3.0';

function readCargoLicense(relative) {
  const file = path.join(ROOT, relative);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${relative} must be a regular manifest`);
  const manifest = Bun.TOML.parse(readFileSync(file, 'utf8'));
  assert.equal(typeof manifest?.package?.name, 'string', `${relative} must declare package.name`);
  return manifest.package.license;
}

function readNpmLicense(relative) {
  const file = path.join(ROOT, relative);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${relative} must be a regular manifest`);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(typeof manifest?.name, 'string', `${relative} must declare name`);
  return manifest.license;
}

function childManifests(relative, manifestName) {
  const directory = path.join(ROOT, relative);
  const entries = readdirSync(directory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(directories.length > 0, `${relative} must contain platform carrier directories`);
  return directories.map((name) => `${relative}/${name}/${manifestName}`);
}

function assertCargoLicenses(files, expected) {
  for (const file of files) {
    assert.equal(readCargoLicense(file), expected, `${file} must declare ${expected}`);
  }
}

function assertNpmLicenses(files, expected) {
  for (const file of files) {
    assert.equal(readNpmLicense(file), expected, `${file} must declare ${expected}`);
  }
}

test('broker source is MIT and compiled payload carriers declare their exact dependency license closure', () => {
  assertCargoLicenses(['broker/Cargo.toml'], CODE_LICENSE);
  assertCargoLicenses(childManifests('broker/crates', 'Cargo.toml'), BROKER_PAYLOAD_LICENSE);
  assertNpmLicenses(childManifests('broker/packages', 'package.json'), BROKER_PAYLOAD_LICENSE);
});

test('native source facades and payload carriers declare their exact role licenses', () => {
  assertCargoLicenses(['postgres-tools/native/crates/tools/Cargo.toml'], CODE_LICENSE);
  assertNpmLicenses(
    childManifests('runtimes/liboliphaunt-native/packages', 'package.json'),
    NATIVE_RUNTIME_LICENSE,
  );
  assertNpmLicenses(
    childManifests('postgres-tools/native/npm-platforms', 'package.json'),
    NATIVE_TOOLS_LICENSE,
  );
});

test('portable ICU carrier declares its exact data-only license closure', () => {
  assertNpmLicenses(['database-resources/icu/npm/package.json'], ICU_CARRIER_LICENSE);
  const podspec = readFileSync(
    path.join(ROOT, 'database-resources/icu/npm/OliphauntICU.podspec'),
    'utf8',
  );
  const declarations = [
    ...podspec.matchAll(
      /^[ \t]*s[.]license[ \t]*=[ \t]*\{[ \t]*:type[ \t]*=>[ \t]*'([^']+)'[ \t]*\}[ \t]*$/gmu,
    ),
  ];
  assert.equal(
    declarations.length,
    1,
    'OliphauntICU.podspec must declare exactly one simple license type',
  );
  assert.equal(declarations[0][1], ICU_CARRIER_LICENSE);
});
