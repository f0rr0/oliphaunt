/** Execute the actual installed public facade against the isolated test server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERIFY_SQL = 'SELECT count(*), sum(id) FROM logical_items';
export function expectedLogicalValue(fixture: { expected: { rows: number; sum: number } }): string {
  return `${fixture.expected.rows}|${fixture.expected.sum}`;
}

if (import.meta.main) {
  const [entry, connection, fixtureFile] = process.argv.slice(2);
  assert(entry && connection && fixtureFile);
  const tools = await import(pathToFileURL(entry).href);
  const query = await tools.psql(connection, { command: 'SELECT 42', args: ['-A', '-t'] });
  assert.equal(query.trim(), '42');
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
  // The published base runtime excludes the separately packaged pgTAP extension.
  // Preserve the shared logical fixture's row/sum oracle using ordinary tables.
  await tools.psql(connection, {
    script:
      "CREATE TABLE logical_items(id integer PRIMARY KEY, value text); INSERT INTO logical_items VALUES (40, 'alpha'), (41, 'beta'), (42, 'gamma')",
  });
  const logical = await tools.pgDump(connection, { args: ['--no-owner', '--no-privileges'] });
  assert(logical.includes('COPY public.logical_items'));
  await tools.psql(connection, { command: 'DROP TABLE logical_items' });
  await tools.psql(connection, { script: logical });
  const restored = await tools.psql(connection, { command: VERIFY_SQL, args: ['-A', '-t'] });
  assert.equal(restored.trim(), expectedLogicalValue(fixture));
}
