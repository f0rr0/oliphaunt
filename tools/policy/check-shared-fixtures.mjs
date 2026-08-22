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

if (errors.length > 0) {
  for (const error of errors) console.error(`shared fixture contract: ${error}`);
  process.exit(1);
}

console.log(`shared fixture contract passed (${canonical.length} canonical fixtures)`);

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
