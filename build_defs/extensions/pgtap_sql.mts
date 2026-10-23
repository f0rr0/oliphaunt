/** Expand the pinned pgTAP SQL inputs without running the PGXS scheduler. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// Admission guard for the qualified upstream PG18 installation recipes. A
// changed Makefile requires upstream-byte parity review before this is updated.
const QUALIFIED_MAKEFILE_SHA256 =
  '24288f38f6a50a61fa351903716bef0d76b892ca1e88f21f396adf067ef24fe7';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readText(file: string): string {
  return utf8.decode(readFileSync(file)).replace(/\r\n?/g, '\n');
}

function linesWithEnds(text: string): string[] {
  // Keep all line endings, including a final unterminated line, as splitlines
  // did in the original generator. Exact patch context must not lose bytes.
  return (
    text.match(
      /[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029])|[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]+$/g,
    ) ?? []
  );
}

/** Apply a single-file upstream compatibility patch with exact context. */
export function applyPatch(text: string, patch: string): string {
  const source = linesWithEnds(text);
  const lines = linesWithEnds(patch);
  if (lines[0] !== '--- sql/pgtap.sql\n' || lines[1] !== '+++ sql/pgtap.sql\n') {
    throw new Error('pgTAP compatibility patch must modify sql/pgtap.sql only');
  }
  const result: string[] = [];
  let cursor = 0;
  let index = 2;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n$/.exec(lines[index]);
    if (!header || header[0] !== lines[index]) {
      throw new Error('invalid pgTAP compatibility hunk');
    }
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    index += 1;
    const before: string[] = [];
    const after: string[] = [];
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      if (![' ', '+', '-'].includes(line[0])) {
        throw new Error('invalid pgTAP compatibility patch line');
      }
      if (line[0] !== '+') before.push(line.slice(1));
      if (line[0] !== '-') after.push(line.slice(1));
      index += 1;
    }
    if (before.length !== oldCount || after.length !== newCount) {
      throw new Error('pgTAP compatibility hunk counts disagree');
    }
    const matches: number[] = [];
    for (let position = cursor; position <= source.length - before.length; position += 1) {
      if (before.every((line, offset) => source[position + offset] === line)) {
        matches.push(position);
      }
    }
    if (matches.length !== 1) {
      throw new Error('pgTAP compatibility patch context is missing or ambiguous');
    }
    const position = matches[0];
    result.push(...source.slice(cursor, position), ...after);
    cursor = position + before.length;
  }
  result.push(...source.slice(cursor));
  return result.join('');
}

export function expand(text: string, osName: string, version: string, module = 'pgtap'): string {
  if (/^[a-zA-Z0-9_]+$/.exec(osName)?.[0] !== osName) {
    throw new Error('pgTAP OS must be an explicit portable target name');
  }
  if (/^\d+\.\d+\.\d+$/.exec(version)?.[0] !== version) {
    throw new Error('pgTAP default version must have three numeric components');
  }
  return text
    .replaceAll('MODULE_PATHNAME', () => module)
    .replaceAll('__OS__', osName)
    .replaceAll('__VERSION__', version.split('.').slice(0, 2).join('.'));
}

export function uninstallRecipe(makefile: string): string {
  const contents = readFileSync(makefile);
  if (createHash('sha256').update(contents).digest('hex') !== QUALIFIED_MAKEFILE_SHA256) {
    throw new Error(
      'pgTAP Makefile installation semantics require upstream-byte parity qualification',
    );
  }
  const match =
    /^sql\/uninstall_pgtap\.sql: sql\/pgtap\.sql test\/setup\.sql\n\t\$\(PERL\) -e '([^\n]+)' \$< > \$@\n(?=\n)/m.exec(
      utf8.decode(contents),
    );
  if (!match) throw new Error('unsupported upstream pgTAP uninstall recipe');
  return match[1].replaceAll('$$', '$');
}

export function runPerl(
  perl: string,
  libraries: string[],
  arguments_: string[],
  sql: string,
  options: string[] = [],
): string {
  const result = spawnSync(perl, [...options, ...arguments_], {
    input: Buffer.from(sql),
    env: {
      ...process.env,
      PERL5LIB: libraries.join(path.delimiter),
      PERL5OPT: '',
      PERL_UNICODE: '',
      LC_ALL: 'C',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pgTAP Perl generator failed: ${result.signal ?? result.status}`);
  }
  return utf8.decode(result.stdout);
}

export function generate(
  source: string,
  output: string,
  osName: string,
  version: string,
  perl: string,
  libraries: string[],
  perlOptions: string[] = [],
): void {
  const uninstall = uninstallRecipe(path.join(source, 'Makefile'));
  const control = readText(path.join(source, 'pgtap.control'));
  const actual = /^default_version\s*=\s*'([^']+)'/m.exec(control);
  if (!actual || actual[1] !== version) {
    throw new Error('pinned pgTAP control disagrees with the canonical default version');
  }
  const template = readText(path.join(source, 'sql/pgtap.sql.in'));
  const main = expand(template, osName, version);
  let staticSql = template;
  for (const patch of readdirSync(path.join(source, 'compat'))
    .filter((name) => name.startsWith('install-') && name.endsWith('.patch'))
    .sort()
    .reverse()) {
    staticSql = applyPatch(staticSql, readText(path.join(source, 'compat', patch)));
  }
  staticSql = expand(staticSql, osName, version, '$libdir/pgtap');
  const files = new Map<string, string>([
    ['pgtap.control', control],
    [`pgtap--${version}.sql`, main],
    [
      `pgtap-core--${version}.sql`,
      runPerl(perl, libraries, [path.join(source, 'compat/gencore'), '0'], staticSql, perlOptions),
    ],
    [
      `pgtap-schema--${version}.sql`,
      runPerl(perl, libraries, [path.join(source, 'compat/gencore'), '1'], staticSql, perlOptions),
    ],
    ['uninstall_pgtap.sql', runPerl(perl, libraries, ['-e', uninstall], main, perlOptions)],
  ]);
  for (const file of readdirSync(path.join(source, 'sql')).sort()) {
    if (file.startsWith('pgtap--') && (file.endsWith('.sql') || file.endsWith('.sql.in'))) {
      const name = file.endsWith('.in') ? file.slice(0, -3) : file;
      if (files.has(name)) throw new Error(`duplicate pgTAP installed SQL identity: ${name}`);
      files.set(name, readText(path.join(source, 'sql', file)));
    }
  }
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length) throw new Error('pgTAP SQL output directory must be empty');
  for (const name of [...files.keys()].sort()) {
    writeFileSync(path.join(output, name), files.get(name) as string);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: 'string' },
      output: { type: 'string' },
      os: { type: 'string' },
      version: { type: 'string' },
      perl: { type: 'string' },
      'perl-lib': { type: 'string', multiple: true, default: [] },
      'perl-option': { type: 'string', multiple: true, default: [] },
    },
    allowPositionals: false,
  });
  const { source, output, os, version, perl } = values;
  if (
    source === undefined ||
    output === undefined ||
    os === undefined ||
    version === undefined ||
    perl === undefined
  ) {
    throw new Error(
      'usage: pgtap_sql.mts --source DIR --output DIR --os OS --version VERSION --perl PATH [--perl-lib DIR ...]',
    );
  }
  generate(source, output, os, version, perl, values['perl-lib'], values['perl-option']);
}
