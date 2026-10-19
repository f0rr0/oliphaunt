import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function generateAgeSql(root: string, datumBytes: 4 | 8 = 8) {
  assert(datumBytes === 4 || datumBytes === 8, 'AGE requires a 32-bit or 64-bit Datum');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const version = read('age.control').match(/^default_version\s*=\s*'([0-9.]+)'\s*$/m)?.[1];
  assert(version, 'AGE control file must declare a release version');
  const files = read('sql/sql_files').trim().split(/\s+/);
  assert(
    files.length && files.every((file) => /^[a-z0-9_]+$/.test(file)),
    'invalid AGE SQL input list',
  );
  let sql = files.map((file) => read(`sql/${file}.sql`)).join('');
  if (datumBytes === 4) {
    // Match AGE's PGXS rule: graphid is an int64 passed by reference on wasm32.
    sql = sql.replace(
      /^ {2}PASSEDBYVALUE,$/gm,
      '  -- PASSEDBYVALUE removed for 32-bit (see Makefile)',
    );
  }
  const file = `age--${version}.sql`;
  writeFileSync(path.join(root, file), sql);
  return file;
}

export function generateAgeSources(
  root: string,
  options: { datumBytes?: 4 | 8; bison?: string; flex?: string; perl?: string } = {},
) {
  const run = (program: string, args: string[]) => {
    const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
    assert(!result.error, `AGE source generation failed: ${program}: ${result.error?.message}`);
    assert.equal(result.status, 0, `AGE source generation failed: ${program}\n${result.stderr}`);
  };
  const windows = process.platform === 'win32';
  const homebrewBison =
    process.platform === 'darwin'
      ? ['/opt/homebrew/opt/bison/bin/bison', '/usr/local/opt/bison/bin/bison'].find(existsSync)
      : undefined;
  run(
    options.bison ??
      process.env.OLIPHAUNT_BISON ??
      process.env.BISON ??
      homebrewBison ??
      (windows ? 'win_bison.exe' : 'bison'),
    [
      '--defines=src/include/parser/cypher_gram_def.h',
      '-Werror',
      '-Wno-deprecated',
      '-Wno-error=conflicts-sr',
      '-Wno-error=conflicts-rr',
      '-o',
      'src/backend/parser/cypher_gram.c',
      'src/backend/parser/cypher_gram.y',
    ],
  );
  run(options.flex ?? (windows ? 'win_flex.exe' : 'flex'), [
    '-o',
    'src/backend/parser/ag_scanner.c',
    'src/backend/parser/ag_scanner.l',
  ]);
  run(options.perl ?? (windows ? 'perl.exe' : 'perl'), [
    '-I',
    'tools',
    'tools/gen_keywordlist.pl',
    '--extern',
    '--varname',
    'CypherKeyword',
    '--output',
    'src/include/parser',
    'src/include/parser/cypher_kwlist.h',
  ]);
  return generateAgeSql(root, options.datumBytes);
}

if (import.meta.main) {
  assert(process.argv.length === 3, 'usage: prepare-source.mts <AGE build directory>');
  generateAgeSources(path.resolve(process.argv[2]));
}
