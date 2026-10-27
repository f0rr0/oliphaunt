import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { databaseSql } from './proj_db.mts';

assert.equal(process.argv.length, 3, 'Expected the pinned PROJ source root File');
const source = dirname(resolve(process.argv[2]));
const sql = databaseSql(source);
assert.match(sql, /INSERT INTO "metadata" VALUES\('PROJ.VERSION', '9\.9\.0'\);/u);
assert.match(sql, /INSERT INTO "metadata" VALUES\('EPSG.DATE', '2026-08-27'\);/u);
assert.match(sql, /INSERT INTO "metadata" VALUES\('PROJ_DATA.VERSION', '1\.25'\);/u);
assert.match(sql, /INSERT INTO "metadata" VALUES\('DATABASE.LAYOUT.VERSION.MINOR', 7\);/u);
assert(!sql.includes('${PROJ_VERSION}'));

// The reviewed OFF-validation recipe installs its checks after committing the
// data and before ANALYZE/VACUUM, instead of validating each inserted row.
const commit = sql.indexOf(readFileSync(join(source, 'data/sql/commit.sql'), 'utf8'));
const analyze = sql.indexOf(readFileSync(join(source, 'data/sql/analyze_vacuum.sql'), 'utf8'));
assert(commit > 0 && analyze > commit);
for (const name of [
  'consistency_checks_triggers.sql',
  'conversion_triggers.sql',
  'conversion_triggers_hand_written.sql',
]) {
  const position = sql.indexOf(readFileSync(join(source, 'data/sql', name), 'utf8'));
  assert(position > commit && position < analyze, `${name} must follow the committed data`);
}

const fixture = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'proj-db-recipe-'));
try {
  mkdirSync(join(fixture, 'data/sql'), { recursive: true });
  for (const name of ['sql_filelist.cmake', 'generate_proj_db.cmake', 'CMakeLists.txt'])
    copyFileSync(join(source, 'data', name), join(fixture, 'data', name));
  writeFileSync(join(fixture, 'data/sql/proj.db.sql.expected.md5'), 'not-a-checksum\n');
  assert.throws(() => databaseSql(fixture), /invalid PROJ expected SQL checksum/u);
  writeFileSync(join(fixture, 'data/generate_proj_db.cmake'), '# changed upstream recipe\n');
  assert.throws(() => databaseSql(fixture), /review PROJ's upstream database recipe/u);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('PROJ pinned database SQL, metadata, order and recipe guards passed');
