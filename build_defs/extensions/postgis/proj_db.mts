/** Bounded translation of the pinned PROJ database-only CMake recipe.
 * Recipe bytes are guarded; the SQL file list remains upstream-owned.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function read(path: string): string {
  return decoder.decode(readFileSync(path));
}

export function databaseSql(source: string): string {
  const recipes = {
    'data/sql_filelist.cmake': 'd187728c432ce56160083f4ffab4329c34f4adb0404bbf03f1a8343aa82f59f6',
    'data/generate_proj_db.cmake':
      'eb458b6a382dbd394ce35b0f6b6d66a5068cad92f72dc70c3d3daeee6fe9dfbf',
    'data/CMakeLists.txt': '709bb6a4e24d5a198c721269e9557abdf2bfa05cd5a0343a917c1463d89e5da7',
  };
  for (const [path, expected] of Object.entries(recipes)) {
    if (
      createHash('sha256')
        .update(readFileSync(join(source, path)))
        .digest('hex') !== expected
    ) {
      throw new Error(`review PROJ's upstream database recipe before changing ${path}`);
    }
  }
  const vars: Record<string, string[]> = { CMAKE_CURRENT_LIST_DIR: [join(source, 'data')] };
  let enabled = true;
  const recipe = read(join(source, 'data/sql_filelist.cmake')).replace(/^\s*#.*$/gm, '');
  for (const match of recipe.matchAll(/(set|list|if|else|endif)\s*\(([^)]*)\)/g)) {
    const [, command, body] = match;
    if (command === 'if') {
      if (!['PROJ_DB_EXTRA_VALIDATION', 'NOT PROJ_DB_EXTRA_VALIDATION'].includes(body.trim())) {
        throw new Error('unexpected PROJ SQL list condition');
      }
      enabled = body.trim().startsWith('NOT ');
    } else if (command === 'else') {
      enabled = !enabled;
    } else if (command === 'endif') {
      enabled = true;
    } else if (enabled) {
      const tokens = Array.from(
        body.matchAll(/"([^"]*)"|([^\s"]+)/g),
        (token) => token[1] ?? token[2],
      );
      if (command === 'list' && tokens.shift() !== 'APPEND')
        throw new Error('unexpected PROJ SQL list operation');
      const name = tokens.shift();
      if (!name) throw new Error('missing PROJ SQL list variable');
      const values = tokens.flatMap((token) => {
        const variable = /^\$\{(\w+)\}$/.exec(token);
        if (variable) {
          if (!vars[variable[1]]) throw new Error(`unknown PROJ SQL variable ${variable[1]}`);
          return vars[variable[1]];
        }
        return [
          token.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
            if (vars[key]?.length !== 1) throw new Error(`unknown PROJ SQL path ${key}`);
            return vars[key][0];
          }),
        ];
      });
      vars[name] = command === 'list' ? [...(vars[name] ?? []), ...values] : values;
    }
  }
  const paths = vars.SQL_FILES;
  if (!paths?.length || new Set(paths).size !== paths.length)
    throw new Error('invalid PROJ SQL input list');
  const sql = paths.map((path) => read(path)).join('');
  const expectedMd5 = /set\(PROJ_DB_SQL_EXPECTED_MD5 "([a-f0-9]{32})"\)/.exec(
    read(join(source, 'data/CMakeLists.txt')),
  )?.[1];
  // Exact upstream generate_proj_db.cmake metadata-independent SQL checksum.
  const md5 = createHash('md5')
    .update(sql.replace(/INSERT INTO "metadata"[^\n]*\n?/g, ''))
    .digest('hex');
  if (md5 !== expectedMd5) throw new Error(`PROJ SQL checksum differs from upstream: ${md5}`);
  const header = read(join(source, 'src/proj.h'));
  const version = ['MAJOR', 'MINOR', 'PATCH']
    .map((component) => {
      const value = new RegExp(`#define PROJ_VERSION_${component} (\\d+)`).exec(header)?.[1];
      if (!value) throw new Error('missing PROJ source version');
      return value;
    })
    .join('.');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal upstream CMake variable.
  return sql.replaceAll('${PROJ_VERSION}', () => version);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, output: { type: 'string' }, sqlite: { type: 'string' } },
  });
  if (!values.source || !values.output || !values.sqlite)
    throw new Error('required: --source --output --sqlite');
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  const result = Bun.spawnSync([resolve(values.sqlite), '-bail', output], {
    stdin: Buffer.from(databaseSql(resolve(values.source))),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C', SQLITE_HISTORY: '/dev/null' },
  });
  if (result.exitCode !== 0)
    throw new Error(`PROJ database construction failed: ${result.stderr.toString('utf8')}`);
}
