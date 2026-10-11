/** Compare the actual installed tree with qualified upstream PG18 recipes. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readText(file: string): string {
  return utf8.decode(readFileSync(file)).replace(/\r\n?/g, '\n');
}

export function compare(
  control: string,
  installed: string,
  perl: string,
  patch: string,
  perlOptions: string[] = [],
): void {
  const source = path.dirname(control);
  const libraries = readdirSync(path.dirname(perl))
    .filter((name) => name.startsWith('perl_lib_'))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
    .map((name) => path.join(path.dirname(perl), name));
  const environment = {
    ...process.env,
    PERL5LIB: libraries.join(path.delimiter),
    PERL5OPT: '',
    PERL_UNICODE: '',
    LC_ALL: 'C',
  };
  const version = /^default_version\s*=\s*'([^']+)'/m.exec(readText(control))?.[1];
  if (!version) throw new Error('pinned pgTAP control has no default version');
  const numeric = version.split('.').slice(0, 2).join('.');
  const template = readText(path.join(source, 'sql/pgtap.sql.in'));
  const main = template
    .replaceAll('MODULE_PATHNAME', 'pgtap')
    .replaceAll('__OS__', 'linux')
    .replaceAll('__VERSION__', numeric);
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-pgtap-parity-'));
  try {
    mkdirSync(path.join(root, 'sql'));
    const staticPath = path.join(root, 'sql/pgtap.sql');
    writeFileSync(staticPath, template);
    // Actual upstream patch execution is independent of the production
    // TypeScript patch implementation. Refuse fuzzy matches in this proof.
    for (const compatibility of readdirSync(path.join(source, 'compat'))
      .filter((name) => name.startsWith('install-') && name.endsWith('.patch'))
      .sort()
      .reverse()) {
      const result = spawnSync(realpathSync(patch), ['--batch', '--fuzz=0', '-p0'], {
        input: readFileSync(path.join(source, 'compat', compatibility)),
        cwd: root,
        env: environment,
        stdio: ['pipe', 'ignore', 'inherit'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`upstream pgTAP patch failed: ${result.signal ?? result.status}`);
      }
    }
    const staticSql = readText(staticPath)
      .replaceAll('MODULE_PATHNAME', '$libdir/pgtap')
      .replaceAll('__OS__', 'linux')
      .replaceAll('__VERSION__', numeric);
    const recipe =
      /^sql\/uninstall_pgtap\.sql: sql\/pgtap\.sql test\/setup\.sql\n\t\$\(PERL\) -e '([^\n]+)' \$< > \$@\n/m.exec(
        readText(path.join(source, 'Makefile')),
      )?.[1];
    if (!recipe) throw new Error('pinned pgTAP Makefile has no uninstall recipe');
    const expected = new Map<string, Buffer>([
      ['pgtap.control', readFileSync(control)],
      [`pgtap--${version}.sql`, Buffer.from(main)],
    ]);
    // Use the pinned upstream Perl scripts directly; do not import the generator.
    const runPerl = (arguments_: string[], input: string): Buffer => {
      const result = spawnSync(perl, [...perlOptions, ...arguments_], {
        input: Buffer.from(input),
        env: environment,
        stdio: ['pipe', 'pipe', 'inherit'],
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`upstream pgTAP Perl failed: ${result.signal ?? result.status}`);
      }
      return result.stdout;
    };
    for (const [kind, invert] of [
      ['core', '0'],
      ['schema', '1'],
    ]) {
      expected.set(
        `pgtap-${kind}--${version}.sql`,
        runPerl([path.join(source, 'compat/gencore'), invert], staticSql),
      );
    }
    expected.set('uninstall_pgtap.sql', runPerl(['-e', recipe.replaceAll('$$', '$')], main));
    for (const file of readdirSync(path.join(source, 'sql'))) {
      if (file.startsWith('pgtap--') && (file.endsWith('.sql') || file.endsWith('.sql.in'))) {
        const name = file.endsWith('.in') ? file.slice(0, -3) : file;
        expected.set(name, readFileSync(path.join(source, 'sql', file)));
      }
    }
    const actual = new Map(
      readdirSync(installed).map((name) => [name, readFileSync(path.join(installed, name))]),
    );
    if (actual.size !== expected.size || [...expected.keys()].some((name) => !actual.has(name))) {
      throw new Error('installed resource set differs from pinned upstream');
    }
    for (const [name, data] of expected) {
      if (!actual.get(name)?.equals(data)) {
        throw new Error(`installed resource differs from upstream bytes: ${name}`);
      }
    }
    console.log(`Upstream-byte parity: ${expected.size} installed resources`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      control: { type: 'string' },
      installed: { type: 'string' },
      perl: { type: 'string' },
      patch: { type: 'string' },
      'perl-options': { type: 'string' },
    },
    allowPositionals: false,
  });
  const { control, installed, perl, patch } = values;
  if (
    control === undefined ||
    installed === undefined ||
    perl === undefined ||
    patch === undefined
  ) {
    throw new Error(
      'usage: pgtap_upstream_parity_test.mts --control PATH --installed DIR --perl PATH --patch PATH',
    );
  }
  const options = values['perl-options'] ? JSON.parse(readText(values['perl-options'])) : [];
  if (!Array.isArray(options) || !options.every((value) => typeof value === 'string'))
    throw new Error('execution Perl options must be a string array');
  compare(control, installed, perl, patch, options);
}
