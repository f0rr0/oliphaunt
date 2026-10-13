import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [headerPath, declarationsPath] = process.argv.slice(2);
assert(headerPath && declarationsPath, 'expected generated probes.h and upstream probes.d');
const header = readFileSync(headerPath, 'utf8').replaceAll('\r\n', '\n');
const declarations = readFileSync(declarationsPath, 'utf8');
const probes = [...declarations.matchAll(/^\s*probe\s+([A-Za-z_][A-Za-z0-9_]*)\([^;]*\);/gm)];
assert(probes.length > 0, 'upstream probes.d must declare probes');
const macros = new Map(
  [...header.matchAll(/^#define (TRACE_POSTGRESQL_[A-Z0-9_]+)\([^)]*\) ([^\n]*)$/gm)].map(
    ([, name, body]) => [name, body],
  ),
);

for (const [, probe] of probes) {
  const name = `TRACE_POSTGRESQL_${probe.replaceAll('__', '_').toUpperCase()}`;
  assert.equal(macros.get(name), 'do {} while (0)', `${name} must be a generated no-op`);
  assert.equal(macros.get(`${name}_ENABLED`), '(0)', `${name}_ENABLED must return zero`);
}
