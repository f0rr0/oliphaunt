/** Orchestrate guarded upstream PostGIS SQL recipes and actual Perl generators. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string' },
    perl: { type: 'string' },
    'perl-option': { type: 'string', multiple: true },
  },
});
if (!values.spec || !values.perl) throw new Error('required: --spec --perl');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const read = (path: string) => decoder.decode(readFileSync(path));
const spec = JSON.parse(read(values.spec)) as {
  source: string;
  extension: string;
  data: string;
  preprocessed: Record<string, string>;
  source_date_epoch: number;
  version: string;
  postgres_version: number;
};
const source = resolve(spec.source),
  extension = resolve(spec.extension),
  data = resolve(spec.data);
const perl = resolve(values.perl),
  options = values['perl-option'] ?? [];
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'postgis-sql-'));
const postgisWork = join(work, 'postgis');
const extensionWork = join(work, 'extensions', 'postgis');
const rasterWork = join(work, 'raster', 'rt_pg');
for (const directory of [postgisWork, join(extensionWork, 'sql'), rasterWork])
  mkdirSync(directory, { recursive: true });
// Upstream generators print $0 and input names in their output. Preserve their
// source-relative invocation paths rather than embedding a sandbox directory.
symlinkSync(join(source, 'utils'), join(work, 'utils'));
symlinkSync(join(source, 'spatial_ref_sys.sql'), join(work, 'spatial_ref_sys.sql'));
const recipes = {
  'postgis/Makefile.in': 'ac57d73d0905731ca270e6cbfc730292c40ffa059958ab334e476c3d7d526f24',
  'extensions/Makefile.in': 'f1d5c44837e1395181e8f21bfb14ac8a19faab2ea433fbea997b3a661bbbd6a5',
  'extensions/postgis/Makefile.in':
    'c127707c0d30ab2cf3a787ed6149703b722d86b143bd8bbb2618d4fb17f844f9',
  'extensions/upgrade-paths-rules.mk':
    '6653c117a96c45c26cfd028c4e5bba3bf4a8dd4f7652b1a3f08d131575da88fa',
  'raster/rt_pg/Makefile.in': '21fc84b18248f4ee7d345541900aff4f59aa3832a2b048be6d46ad8c5b370a1d',
};
for (const [path, digest] of Object.entries(recipes)) {
  if (
    createHash('sha256')
      .update(readFileSync(join(source, path)))
      .digest('hex') !== digest
  ) {
    throw new Error(`review the upstream PostGIS SQL recipe before changing ${path}`);
  }
}
if (
  !/^\d+\.\d+\.\d+$/.test(spec.version) ||
  !Number.isSafeInteger(spec.source_date_epoch) ||
  spec.postgres_version !== 180
) {
  throw new Error('unsupported PostGIS SQL source identity');
}
function run(args: string[], stdin?: string, cwd = postgisWork): string {
  const result = Bun.spawnSync([perl, ...options, ...args], {
    cwd,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: String(spec.source_date_epoch),
      LC_ALL: 'C',
      TZ: 'UTC',
      PERL5LIB: '',
      PERL5OPT: '',
      PERL_UNICODE: '',
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`PostGIS upstream Perl failed: ${result.stderr.toString('utf8')}`);
  return decoder.decode(result.stdout);
}
const transform = (program: string, text: string, lines = false) =>
  run([lines ? '-lpe' : '-pe', program], text);
const strip = (text: string) => transform('s/BEGIN\\;//g ; s/COMMIT\\;//g', text);
const upstream = (name: string, args: string[], stdin?: string, cwd = postgisWork) =>
  run([`${cwd === postgisWork ? '..' : '../..'}/utils/${name}.pl`, ...args], stdin, cwd);
const file = (name: string, text: string, cwd = postgisWork) => {
  writeFileSync(join(cwd, name), text);
  return name;
};
function preprocessed(name: string, module: string, removeSchema: boolean): string {
  const input = spec.preprocessed[`${name}.sql`];
  if (!input) throw new Error(`missing declared preprocessed SQL ${name}`);
  const text = read(resolve(input)).replace(/^#.*\n?/gm, '');
  const replaced = transform(`s'MODULE_PATHNAME'${module}'g`, text, true);
  return removeSchema ? transform("s'@extschema@\\.''g", replaced, true) : replaced;
}
try {
  mkdirSync(extension, { recursive: true });
  mkdirSync(data, { recursive: true });
  const module = `$libdir/postgis-${spec.version.split('.')[0]}`;
  const main = preprocessed('postgis', module, true);
  file('postgis.sql', main);
  writeFileSync(join(data, 'postgis.sql'), main);
  for (const name of ['legacy', 'legacy_minimal', 'legacy_gist']) {
    const text = preprocessed(name, module, true);
    file(`${name}.sql`, text);
    writeFileSync(join(data, `${name}.sql`), text);
  }
  for (const name of ['postgis', 'legacy']) {
    const text = upstream('create_uninstall', [`${name}.sql`, String(spec.postgres_version)]);
    writeFileSync(join(data, `uninstall_${name}.sql`), text);
    if (name === 'postgis') writeFileSync(join(extension, 'uninstall_postgis.sql'), text);
  }
  copyFileSync(join(source, 'spatial_ref_sys.sql'), join(data, 'spatial_ref_sys.sql'));
  const upgradeParts = (body: string) =>
    ['common_before_upgrade.sql', 'postgis_before_upgrade.sql']
      .map((name) => read(join(source, 'postgis', name)))
      .join('') +
    body +
    ['postgis_after_upgrade.sql', 'common_after_upgrade.sql']
      .map((name) => read(join(source, 'postgis', name)))
      .join('');
  writeFileSync(
    join(data, 'postgis_upgrade.sql'),
    `BEGIN;\n${upgradeParts(upstream('create_upgrade', ['postgis.sql']))}COMMIT;\n`,
  );
  const forExtension = strip(preprocessed('postgis', module, false));
  file('sql/postgis_for_extension.sql', forExtension, extensionWork);
  const spatial = strip(read(join(source, 'spatial_ref_sys.sql')));
  const dump = upstream(
    'create_spatial_ref_sys_config_dump',
    ['../../spatial_ref_sys.sql'],
    undefined,
    extensionWork,
  );
  const guard = '\\echo Use "CREATE EXTENSION postgis" to load this file. \\quit\n';
  const install = guard + forExtension + dump + spatial;
  writeFileSync(join(extension, `postgis--${spec.version}.sql`), install);
  const extensionUpgrade = strip(
    upgradeParts(
      upstream('create_upgrade', ['sql/postgis_for_extension.sql'], undefined, extensionWork),
    ),
  );
  const safeUpgrade = transform(
    "s/^(DROP .*)\\;/SELECT \\@extschema\\@.postgis_extension_drop_if_exists('postgis', '\\1');\\n\\1\\;/",
    extensionUpgrade,
    true,
  );
  const rasterModule = `$libdir/rtpostgis-${spec.version.split('.')[0]}`;
  const rasterMain = preprocessed('rtpostgis', rasterModule, true);
  file('rtpostgis.sql', rasterMain, rasterWork);
  const rasterDrops =
    preprocessed('rtpostgis_upgrade_cleanup', rasterModule, true) +
    preprocessed('rtpostgis_drop', rasterModule, true) +
    upstream(
      'create_uninstall',
      ['rtpostgis.sql', String(spec.postgres_version)],
      undefined,
      rasterWork,
    );
  const unpackage = read(join(source, 'extensions/postgis/unpackage_raster_if_needed.sql'));
  const markers = Array.from(unpackage.matchAll(/^.*UNPACKAGE_CODE.*\n/gm));
  if (markers.length !== 1)
    throw new Error('unsupported upstream raster unpackage insertion recipe');
  const marker = markers[0].index + markers[0][0].length;
  const rasterUnpackage =
    unpackage.slice(0, marker) +
    upstream('create_extension_unpackage', ['postgis'], rasterDrops, extensionWork) +
    unpackage.slice(marker);
  const anyUpgrade =
    guard +
    preprocessed('postgis_extension_helper', '', false) +
    rasterUnpackage +
    safeUpgrade +
    spatial +
    dump +
    read(join(source, 'extensions/postgis_extension_helper_uninstall.sql'));
  writeFileSync(join(extension, `postgis--ANY--${spec.version}.sql`), anyUpgrade);
  writeFileSync(
    join(extension, `postgis--unpackaged--${spec.version}.sql`),
    upstream('create_unpackaged', ['postgis'], install, extensionWork) + anyUpgrade,
  );
  writeFileSync(join(extension, 'postgis--unpackaged.sql'), '-- Nothing to do here\n');
  const date = new Date(spec.source_date_epoch * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const template = `-- Just tag extension postgis version as "ANY"\n-- Installed by postgis ${spec.version}\n-- Built on ${date}\n`;
  writeFileSync(join(extension, 'postgis--TEMPLATED--TO--ANY.sql'), template);
  writeFileSync(join(extension, `postgis--${spec.version}--ANY.sql`), template);
} finally {
  rmSync(work, { recursive: true, force: true });
}
