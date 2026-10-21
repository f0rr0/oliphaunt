import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { preprocessSql } from '../../../external/postgis/tools/preprocess-sql.mts';

const read = (file: string) => readFileSync(file, 'utf8');
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const quote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "\\'")}'`;
const list = (values: string[]) => values.map((value) => `  ${quote(value)}`).join(',\n');
const glob = (root: string, pattern: string) =>
  [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })].sort();
const version = (root: string, extension: string) => {
  const matches = [
    ...read(path.join(root, `${extension}.control`)).matchAll(
      /^\s*default_version\s*=\s*'([^']+)'\s*$/gm,
    ),
  ];
  assert.equal(matches.length, 1, `${extension} must declare a default_version`);
  return matches[0][1];
};
function copy(source: string, destination: string) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (file) => path.basename(file) !== '.git',
  });
}
function replace(file: string, before: string | RegExp, after: string) {
  const original = read(file);
  const updated = original.replace(before, after);
  assert.notEqual(updated, original, `missing Windows source patch anchor in ${file}`);
  write(file, updated);
}

// Only the literal object list is needed from these pinned PGXS projects.
// Reject expressions rather than attempting to implement GNU Make here.
export function pgxsSources(root: string) {
  const makefile = read(path.join(root, 'Makefile')).replace(/\\\r?\n/g, ' ');
  const objects = makefile.match(/^OBJS\s*=\s*([^\n]*)/m)?.[1];
  if (objects === undefined) {
    const modules = makefile
      .match(/^MODULES\s*=\s*([^\n]*)/m)?.[1]
      ?.trim()
      .split(/\s+/);
    assert(
      modules?.length && modules.every((value) => /^[\w-]+$/.test(value)),
      'missing literal PGXS modules',
    );
    return modules.map((module) => `${module}.c`);
  }
  const values = objects.replaceAll('$(WIN32RES)', '').trim().split(/\s+/);
  assert(
    values.length && values.every((value) => /^[\w./-]+\.o$/.test(value)),
    'unsupported PGXS object expression',
  );
  return values.map((value) => value.slice(0, -2) + '.c');
}

// Preserve the pinned tiger SQL recipe's order (and Make's $^ deduplication).
// Only literal SQL prerequisites are supported; upstream expressions need review.
export function postgisSqlInputs(root: string, target: string) {
  const makefile = read(path.join(root, 'Makefile.in')).replace(/\\\r?\n/g, ' ');
  const rule = makefile.split(/\r?\n/).find((line) => line.startsWith(`${target}:`));
  assert(rule, `missing PostGIS SQL rule ${target}`);
  const inputs = rule
    .slice(target.length + 1)
    .split('|')[0]
    .trim()
    .split(/\s+/);
  assert(
    inputs.length && inputs.every((input) => /^[\w./-]+\.sql(?:\.in)?$/.test(input)),
    `unsupported PostGIS SQL prerequisites for ${target}`,
  );
  return [...new Set(inputs)].map((input) => path.resolve(root, input));
}

type Config = { repo: string; work: string; postgres: string; install: string };
function moduleRecipe(
  config: Config,
  subdir: string,
  module: string,
  sources: string[],
  data: string[],
  cArgs: string[] = [],
  linkArgs: string[] = [],
  includes: string[] = [],
) {
  const directory = path.join(config.postgres, 'contrib/oliphaunt_external', subdir);
  const variable = subdir.replaceAll('-', '_');
  write(
    path.join(directory, 'meson.build'),
    `${variable} = shared_module(\n  ${quote(module)},\n  files(\n${list(sources)}\n  ),\n  c_pch: pch_postgres_h,\n  include_directories: [${includes.map((value) => `include_directories(${quote(value)})`).join(', ')}],\n  kwargs: contrib_mod_args + { 'c_args': [\n${list(cArgs)}\n], 'link_args': [\n${list(linkArgs)}\n] },\n)\ncontrib_targets += ${variable}\ninstall_data(\n${list(data)},\n  kwargs: contrib_data_args,\n)\n`,
  );
  appendSubdir(config, subdir);
}
function appendSubdir(config: Config, subdir: string) {
  const file = path.join(config.postgres, 'contrib/meson.build');
  const line = `subdir('oliphaunt_external/${subdir}')`;
  const text = read(file);
  if (!text.includes(line)) write(file, text.trimEnd() + '\n' + line + '\n');
}

export function prepareSimple(config: Config, extension: string) {
  const subdir = extension === 'uuid-ossp' ? 'uuid_ossp' : extension;
  const destination = path.join(config.postgres, 'contrib/oliphaunt_external', subdir);
  const cArgs: string[] = [],
    linkArgs: string[] = [],
    includes: string[] = [];
  let sources: string[], data: string[];
  if (extension === 'pgcrypto' || extension === 'uuid-ossp') {
    mkdirSync(destination, { recursive: true });
    const contrib = path.join(config.postgres, 'contrib', extension);
    data = [...glob(contrib, `${extension}--*.sql`), `${extension}.control`].map(
      (file) => `../../${extension}/${file}`,
    );
    if (extension === 'pgcrypto') {
      sources = glob(contrib, '*.c').map((file) => `../../pgcrypto/${file}`);
      cArgs.push(`/I${path.join(config.work, 'windows-dependencies/openssl/include')}`);
      linkArgs.push(
        path.join(config.work, 'windows-dependencies/openssl/lib/libcrypto.lib'),
        'crypt32.lib',
        'advapi32.lib',
        'bcrypt.lib',
        'ws2_32.lib',
        'user32.lib',
      );
    } else {
      copyFileSync(
        path.join(config.repo, 'src/extensions/contrib/portable-uuid/portable_uuid.c'),
        path.join(destination, 'portable_uuid.c'),
      );
      sources = ['../../uuid-ossp/uuid-ossp.c', 'portable_uuid.c'];
      cArgs.push(
        `/I${path.join(config.repo, 'src/extensions/contrib/portable-uuid/include')}`,
        '/DHAVE_UUID_E2FS=1',
        '/DHAVE_UUID_UUID_H=1',
      );
    }
  } else {
    const checkout = extension === 'vector' ? 'pgvector' : extension;
    copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts', checkout), destination);
    sources = pgxsSources(destination);
    if (extension === 'vector') {
      copyFileSync(
        path.join(destination, 'sql/vector.sql'),
        path.join(destination, `sql/vector--${version(destination, extension)}.sql`),
      );
      cArgs.push('/fp:fast');
    }
    data = [
      ...glob(destination, `${extension}--*.sql`),
      ...glob(destination, `sql/${extension}--*.sql`),
      `${extension}.control`,
    ];
    if (extension === 'pg_textsearch') {
      // PostgreSQL supplies the Windows APIs; upstream still includes unistd.h.
      write(path.join(destination, 'src/unistd.h'), '/* Provided by PostgreSQL on Windows. */\n');
      cArgs.push(
        '/D_CRT_SECURE_NO_WARNINGS',
        `/DPG_TEXTSEARCH_VERSION="${version(destination, extension)}"`,
      );
      includes.push('src');
    }
    if (extension === 'pg_uuidv7') {
      replace(
        path.join(destination, 'pg_uuidv7.c'),
        '#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)',
        `#define EPOCH_DIFF_USECS ((POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY)\n#ifdef _WIN32\n#ifndef CLOCK_REALTIME\n#define CLOCK_REALTIME 0\n#endif\nstatic int oliphaunt_pg_uuidv7_clock_gettime(int clock_id, struct timespec *ts) {\n  TimestampTz unix_usecs;\n  if (clock_id != CLOCK_REALTIME || ts == NULL) return -1;\n  unix_usecs = GetCurrentTimestamp() + EPOCH_DIFF_USECS;\n  ts->tv_sec = (time_t) (unix_usecs / USECS_PER_SEC);\n  ts->tv_nsec = (long) ((unix_usecs % USECS_PER_SEC) * 1000);\n  return 0;\n}\n#define clock_gettime oliphaunt_pg_uuidv7_clock_gettime\n#endif`,
      );
    }
  }
  for (const file of [...sources, ...data])
    assert(existsSync(path.join(destination, file)), `missing extension input ${file}`);
  moduleRecipe(config, subdir, extension, sources, data, cArgs, linkArgs, includes);
}

function postgisVersion(root: string) {
  const text = read(path.join(root, 'Version.config'));
  const values = ['MAJOR', 'MINOR', 'MICRO'].map((key) => {
    const value = text.match(new RegExp(`^POSTGIS_${key}_VERSION=(.+)$`, 'm'))?.[1].trim();
    assert(value && /^[0-9]+$/.test(value), `invalid PostGIS ${key} version`);
    return value;
  });
  return {
    major: values[0],
    minor: values[1],
    micro: values[2],
    version: values.join('.'),
    majorMinor: values.slice(0, 2).join('.'),
  };
}
function postgisDirectory(config: Config) {
  return path.join(config.postgres, 'contrib/oliphaunt_external/postgis');
}
function postgisTemplates(config: Config) {
  return path.join(config.repo, 'src/extensions/external/postgis/tools/windows');
}
export function postgisModuleStems(config: Pick<Config, 'repo'>) {
  const target = Bun.TOML.parse(
    read(path.join(config.repo, 'src/extensions/external/postgis/targets/native.toml')),
  );
  assert(
    Array.isArray(target.module_files) && target.module_files.length,
    'missing PostGIS native modules',
  );
  const stems = target.module_files.map((file: unknown) => {
    assert(typeof file === 'string', 'invalid PostGIS native module');
    const stem = /^lib\/postgresql\/([\w-]+)\.so$/.exec(file)?.[1];
    assert(stem, `invalid PostGIS native module ${file}`);
    return stem;
  });
  assert.equal(new Set(stems).size, stems.length, 'duplicate PostGIS native modules');
  assert(stems.includes('postgis-3'), 'missing primary PostGIS native module');
  return stems;
}
function expand(input: string, output: string, values: Record<string, string>) {
  let text = read(input);
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`@${key}@`, value);
  write(output, text);
}
function sourceDate(config: Config) {
  const pin = Bun.TOML.parse(
    read(path.join(config.repo, 'src/extensions/external/postgis/source.toml')),
  );
  assert(
    Number.isSafeInteger(pin.source_date_epoch) && pin.source_date_epoch > 0,
    'invalid PostGIS source date',
  );
  assert.equal(
    process.env.SOURCE_DATE_EPOCH,
    String(pin.source_date_epoch),
    'use the pinned PostGIS source date',
  );
  return new Date(pin.source_date_epoch * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
export function preparePostgis(config: Config) {
  const directory = postgisDirectory(config);
  copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts/postgis'), directory);
  const pgis = postgisVersion(directory);
  const source = Bun.TOML.parse(
    read(path.join(config.repo, 'src/extensions/external/postgis/source.toml')),
  );
  const componentVersion = (component: string) => {
    const pin = Bun.TOML.parse(
      read(
        path.join(
          config.repo,
          'src/extensions/external/postgis/dependencies',
          component,
          'source.toml',
        ),
      ),
    );
    const value = String(pin.branch).replace(/^v/, '');
    assert(/^\d+\.\d+\.\d+$/.test(value), `invalid pinned ${component} version`);
    return value;
  };
  const number = (value: string) =>
    value
      .split('.')
      .map((part, index) => (index ? part.padStart(2, '0') : part))
      .join('');
  const pgMajor = String(
    Bun.TOML.parse(read(path.join(config.repo, 'src/third-party/postgres/source.toml'))).postgresql
      .version,
  ).split('.')[0];
  const values = {
    LOCALE_DIR: path.join(config.install, 'share/locale').replaceAll('\\', '/'),
    BUILD_DATE: sourceDate(config),
    GEOS_VERSION: number(componentVersion('geos')),
    GDAL_VERSION: number(componentVersion('gdal')),
    LIBXML_VERSION: componentVersion('libxml2'),
    PROJ_VERSION: number(componentVersion('proj')),
    VERSION: pgis.version,
    MAJOR: pgis.major,
    MINOR: pgis.minor,
    MICRO: pgis.micro,
    POSTGIS_VERSION: `${pgis.majorMinor} USE_GEOS=1 USE_PROJ=1 USE_STATS=1`,
  };
  write(path.join(directory, 'postgis_revision.h'), `#define POSTGIS_REVISION ${source.commit}\n`);
  expand(
    path.join(postgisTemplates(config), 'postgis_config.h.in'),
    path.join(directory, 'postgis_config.h'),
    values,
  );
  const macros = {
    POSTGIS_PGSQL_VERSION: `${pgMajor}0`,
    POSTGIS_PGSQL_HR_VERSION: `${pgMajor}.0`,
    POSTGIS_GEOS_VERSION: values.GEOS_VERSION,
    POSTGIS_PROJ_VERSION: values.PROJ_VERSION,
    POSTGIS_LIB_VERSION: pgis.version,
    POSTGIS_LIBXML2_VERSION: values.LIBXML_VERSION,
    POSTGIS_SFCGAL_VERSION: '0',
    POSTGIS_VERSION: values.POSTGIS_VERSION,
    POSTGIS_BUILD_DATE: values.BUILD_DATE,
    POSTGIS_SCRIPTS_VERSION: pgis.version,
    SRID_MAX: '999999',
    SRID_USR_MAX: '998999',
    POSTGIS_MAJOR_VERSION: pgis.major,
    POSTGIS_MINOR_VERSION: pgis.minor,
  };
  for (const file of ['postgis/sqldefines.h', 'liblwgeom/liblwgeom.h'])
    expand(path.join(directory, file + '.in'), path.join(directory, file), macros);
  expand(
    path.join(directory, 'extensions/postgis/postgis.control.in'),
    path.join(directory, 'extensions/postgis/postgis.control'),
    { EXTVERSION: pgis.version, EXTENSION: 'postgis', MODULEPATH: '$libdir/postgis-3' },
  );
  write(
    path.join(directory, 'raster/raster_config.h'),
    `#ifndef POSTGIS_RASTER_CONFIG_H
#define POSTGIS_RASTER_CONFIG_H 1
#define POSTGIS_GDAL_VERSION ${values.GDAL_VERSION}
#endif
`,
  );
  expand(
    path.join(directory, 'extensions/postgis_raster/postgis_raster.control.in'),
    path.join(directory, 'extensions/postgis_raster/postgis_raster.control'),
    {
      EXTVERSION: pgis.version,
      EXTENSION: 'postgis_raster',
      MODULEPATH: '$libdir/postgis_raster-3',
    },
  );
  for (const name of ['postgis_topology', 'postgis_tiger_geocoder']) {
    expand(
      path.join(directory, `extensions/${name}/${name}.control.in`),
      path.join(directory, `extensions/${name}/${name}.control`),
      { EXTVERSION: pgis.version },
    );
  }
  for (const file of [
    'raster/rt_core/librtcore.h',
    'raster/rt_pg/rtpostgis.c',
    'topology/postgis_topology.c',
  ]) {
    replace(
      path.join(directory, file),
      '# define __attribute__ (x)',
      '# ifndef __attribute__\n#  define __attribute__(x)\n# endif',
    );
  }
  copyFileSync(
    path.join(postgisTemplates(config), 'postgis-compat.h'),
    path.join(directory, 'oliphaunt_postgis_windows_compat.h'),
  );
  copyFileSync(
    path.join(postgisTemplates(config), 'flatgeobuf-compat.h'),
    path.join(directory, 'oliphaunt_flatgeobuf_windows_compat.h'),
  );
  for (const folder of [
    'postgis',
    'libpgcommon',
    'liblwgeom',
    'raster/rt_core',
    'raster/rt_pg',
    'topology',
  ]) {
    for (const file of glob(path.join(directory, folder), '**/*.{c,h}')) {
      const target = path.join(directory, folder, file),
        text = read(target);
      const updated = text.replace(
        /^[ \t]*(?!(?:extern\s+)?PGDLLEXPORT\s+)(?:extern\s+)?Datum\s+(\w+)\s*\(PG_FUNCTION_ARGS\);\r?$/gm,
        'extern PGDLLEXPORT Datum $1(PG_FUNCTION_ARGS);',
      );
      if (updated !== text) write(target, updated);
    }
  }
  for (const hook of ['_PG_init', '_PG_fini']) {
    replace(
      path.join(directory, 'topology/postgis_topology.c'),
      `void ${hook}(void);`,
      `PGDLLEXPORT void ${hook}(void);`,
    );
  }
  replace(
    path.join(directory, 'postgis/postgis_legacy.c'),
    /^([ \t]*)Datum[ \t]+funcname[ \t]*\(PG_FUNCTION_ARGS\);[ \t]*\\\r?$/gm,
    '$1extern PGDLLEXPORT Datum funcname(PG_FUNCTION_ARGS); \\',
  );
  for (const variables of [
    ['x', 'y', 'z', 'm'],
    ['xv', 'yv', 'zv', 'mv'],
  ]) {
    replace(
      path.join(directory, 'deps/flatgeobuf/geometryreader.cpp'),
      `pt = (POINT4D) { ${variables.join(', ')} };`,
      ['x', 'y', 'z', 'm'].map((field, index) => `pt.${field} = ${variables[index]};`).join('\n'),
    );
  }
  const comments = path.join(directory, 'doc/postgis_comments.sql');
  if (!existsSync(comments))
    write(comments, '-- Optional SQL comments are not generated by the Windows producer.\n');
}

function firstLibrary(root: string, names: string[]) {
  for (const name of names) {
    const found = glob(root, `**/${name}`)[0];
    if (found) return path.join(root, found);
  }
  throw new Error(`missing library ${names.join('/')} under ${root}`);
}
export function postgisMeson(config: Config) {
  const directory = postgisDirectory(config),
    pgis = postgisVersion(directory);
  const dependencies = path.join(config.work, 'windows-dependencies/postgis');
  const cArgs = [
    '/D_CRT_SECURE_NO_WARNINGS',
    '/D_USE_MATH_DEFINES',
    '/DLIBXML_STATIC',
    '/DRYU_NO_TRAILING_ZEROS',
    `/FI${path.join(directory, 'oliphaunt_postgis_windows_compat.h')}`,
  ];
  // Keep liblwgeom before the similarly named PostgreSQL module headers.
  cArgs.push(
    ...[
      '',
      'liblwgeom',
      'postgis',
      'libpgcommon',
      'deps',
      'deps/flatgeobuf',
      'deps/flatgeobuf/include',
      'deps/ryu',
      'raster',
      'raster/rt_core',
      'raster/rt_pg',
    ].map((file) => `/I${path.join(directory, file)}`),
  );
  cArgs.push(
    ...[
      'gdal/include',
      'geos/include',
      'proj/include',
      'json-c/include',
      'json-c/include/json-c',
      'libxml2/include/libxml2',
    ].map((file) => `/I${path.join(dependencies, file)}`),
  );
  const linkArgs = [
    firstLibrary(path.join(dependencies, 'flatgeobuf'), ['flatgeobuf.lib']),
    firstLibrary(path.join(dependencies, 'gdal'), ['gdal.lib']),
    firstLibrary(path.join(dependencies, 'geos'), ['geos_c.lib']),
    firstLibrary(path.join(dependencies, 'geos'), ['geos.lib']),
    firstLibrary(path.join(dependencies, 'proj'), ['proj.lib', 'libproj.lib']),
    firstLibrary(path.join(dependencies, 'sqlite'), ['sqlite3.lib', 'libsqlite3.lib']),
    firstLibrary(path.join(dependencies, 'json-c'), ['json-c.lib', 'json-c-static.lib']),
    firstLibrary(path.join(dependencies, 'libxml2'), ['libxml2s.lib', 'libxml2.lib', 'xml2.lib']),
    'ws2_32.lib',
    'bcrypt.lib',
    'advapi32.lib',
    'shell32.lib',
    'user32.lib',
    'ole32.lib',
    'oleaut32.lib',
    'uuid.lib',
    'msvcprt.lib',
  ];
  const data = [
    'extensions/postgis/postgis.control',
    ...glob(directory, 'extensions/postgis/sql/postgis--*.sql'),
    'extensions/postgis_raster/postgis_raster.control',
    ...glob(directory, 'extensions/postgis_raster/sql/postgis_raster--*.sql'),
    'extensions/postgis_topology/postgis_topology.control',
    ...glob(directory, 'extensions/postgis_topology/sql/postgis_topology--*.sql'),
    'extensions/postgis_tiger_geocoder/postgis_tiger_geocoder.control',
    ...glob(directory, 'extensions/postgis_tiger_geocoder/sql/postgis_tiger_geocoder--*.sql'),
  ];
  const contrib = [
    'postgis/legacy.sql',
    'postgis/legacy_gist.sql',
    'postgis/legacy_minimal.sql',
    'postgis/postgis.sql',
    'postgis/postgis_upgrade.sql',
    'spatial_ref_sys.sql',
    'postgis/uninstall_legacy.sql',
    'postgis/uninstall_postgis.sql',
    'doc/postgis_comments.sql',
    'topology/topology.sql',
    'topology/topology_upgrade.sql',
    'topology/uninstall_topology.sql',
  ];
  expand(
    path.join(postgisTemplates(config), 'meson.build.in'),
    path.join(directory, 'meson.build'),
    {
      C_ARGS: list(cArgs),
      LINK_ARGS: list(linkArgs),
      EXTENSION_DATA: list(data),
      CONTRIB_DATA: list(contrib),
      MAJOR_MINOR: pgis.majorMinor,
    },
  );
  mkdirSync(path.join(directory, 'share/proj'), { recursive: true });
  copyFileSync(
    path.join(dependencies, 'proj/share/proj/proj.db'),
    path.join(directory, 'share/proj/proj.db'),
  );
  copy(path.join(dependencies, 'gdal/share/gdal'), path.join(directory, 'share/gdal'));
  appendSubdir(config, 'postgis');
}

const withoutTransactions = (text: string) =>
  text.replaceAll('BEGIN;', '').replaceAll('COMMIT;', '');
const joined = (...texts: string[]) =>
  texts.map((text) => (text.endsWith('\n') ? text : text + '\n')).join('');

function extensionDropGuards(text: string, extension: string) {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const drop = line.match(/^(DROP .*);/);
      return drop
        ? [
            `SELECT @extschema@.postgis_extension_drop_if_exists('${extension}', '${drop[1]}');`,
            line,
          ]
        : [line];
    })
    .join('\n');
}

export function postgisSql(config: Config, phase: string) {
  const directory = postgisDirectory(config),
    pgis = postgisVersion(directory);
  const pg = path.join(directory, 'postgis'),
    sql = path.join(directory, 'extensions/postgis/sql');
  const raster = path.join(directory, 'raster/rt_pg');
  const rasterSql = path.join(directory, 'extensions/postgis_raster/sql');
  const topology = path.join(directory, 'topology');
  const topologyExtension = path.join(directory, 'extensions/postgis_topology');
  const topologySql = path.join(topologyExtension, 'sql');
  const tigerExtension = path.join(directory, 'extensions/postgis_tiger_geocoder');
  const tigerSql = path.join(tigerExtension, 'sql');
  const topologyBody = (text: string) =>
    withoutTransactions(text).replace(/^CREATE SCHEMA[^\r\n]*(?:\r?\n|$)/gm, '');
  const tigerDropSchema =
    "SELECT postgis_extension_drop_if_exists('postgis_tiger_geocoder', 'DROP SCHEMA tiger_data');";
  for (const folder of [sql, rasterSql, topologySql, tigerSql])
    mkdirSync(folder, { recursive: true });
  if (phase === 'postgis-sql-preprocess') {
    const template = (
      input: string,
      output: string,
      includes: string[],
      module: string,
      strip: boolean,
      removeSchema: boolean,
    ) => {
      let text = preprocessSql(input, includes).replaceAll('MODULE_PATHNAME', module);
      if (strip) text = withoutTransactions(text);
      if (removeSchema) text = text.replaceAll('@extschema@.', '');
      write(output, text);
    };
    template(
      path.join(directory, 'extensions/postgis_extension_helper.sql.in'),
      path.join(directory, 'extensions/postgis_extension_helper.sql'),
      [directory, pg],
      '',
      false,
      false,
    );
    for (const name of ['postgis', 'legacy_minimal', 'legacy', 'legacy_gist']) {
      template(
        path.join(pg, name + '.sql.in'),
        path.join(pg, name + '.sql'),
        [pg],
        '$libdir/postgis-3',
        false,
        true,
      );
    }
    template(
      path.join(pg, 'postgis.sql.in'),
      path.join(sql, 'postgis_for_extension.sql'),
      [pg],
      '$libdir/postgis-3',
      true,
      false,
    );
    write(
      path.join(sql, 'spatial_ref_sys.sql'),
      withoutTransactions(read(path.join(directory, 'spatial_ref_sys.sql'))),
    );
    for (const name of ['rtpostgis', 'rtpostgis_upgrade_cleanup', 'rtpostgis_drop']) {
      template(
        path.join(raster, name + '.sql.in'),
        path.join(raster, name + '.sql'),
        [pg, raster],
        '$libdir/postgis_raster-3',
        false,
        true,
      );
    }
    template(
      path.join(raster, 'rtpostgis.sql.in'),
      path.join(rasterSql, 'rtpostgis.sql'),
      [pg, raster],
      '$libdir/postgis_raster-3',
      true,
      false,
    );
    for (const name of ['topology', 'topology_before_upgrade', 'topology_after_upgrade']) {
      template(
        path.join(topology, name + '.sql.in'),
        path.join(topology, name + '.sql'),
        [pg, directory],
        '$libdir/postgis_topology-3',
        false,
        false,
      );
    }
    write(
      path.join(topologySql, 'topology.sql'),
      topologyBody(read(path.join(topology, 'topology.sql'))),
    );
    copyFileSync(
      path.join(tigerExtension, 'sql_bits/add_search_path.sql.in'),
      path.join(tigerSql, 'add_search_path.sql'),
    );
    for (const name of ['tiger_geocoder', 'tiger_geocoder_minor']) {
      const inputs = postgisSqlInputs(tigerExtension, `sql/${name}.sql.in`);
      const tail =
        name === 'tiger_geocoder'
          ? [
              tigerDropSchema,
              read(path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql')),
            ]
          : [];
      write(
        path.join(tigerSql, `${name}.sql`),
        withoutTransactions(joined(inputs.map(read).join(''), ...tail)),
      );
    }
    write(
      path.join(tigerSql, 'postgis_tiger_geocoder_pre.sql'),
      joined(
        read(path.join(tigerSql, 'tiger_geocoder.sql')),
        read(path.join(tigerExtension, 'sql_bits/mark_editable_objects.sql.in')),
      ),
    );
  } else if (phase === 'postgis-sql-upgrade') {
    const upgrade = (body: string) =>
      joined(
        ...[
          path.join(pg, 'common_before_upgrade.sql'),
          path.join(pg, 'postgis_before_upgrade.sql'),
          body,
          path.join(pg, 'postgis_after_upgrade.sql'),
          path.join(pg, 'common_after_upgrade.sql'),
        ].map(read),
      );
    write(
      path.join(pg, 'postgis_upgrade.sql'),
      joined('BEGIN;', upgrade(path.join(pg, 'postgis_upgrade.sql.in')), 'COMMIT;'),
    );
    const extensionUpgrade = withoutTransactions(
      upgrade(path.join(sql, 'postgis_upgrade_for_extension.sql.in')),
    );
    write(path.join(sql, 'postgis_upgrade_for_extension.sql'), extensionUpgrade);
    write(path.join(sql, 'postgis_upgrade.sql'), extensionDropGuards(extensionUpgrade, 'postgis'));
    write(
      path.join(rasterSql, 'rtpostgis_upgrade.sql'),
      extensionDropGuards(
        withoutTransactions(
          joined(
            ...[
              path.join(pg, 'common_before_upgrade.sql'),
              path.join(raster, 'rtpostgis_upgrade_cleanup.sql'),
              path.join(rasterSql, 'rtpostgis_upgrade.sql.in'),
              path.join(raster, 'rtpostgis_drop.sql'),
              path.join(pg, 'common_after_upgrade.sql'),
            ].map(read),
          ),
        ),
        'postgis_raster',
      ),
    );
    write(
      path.join(sql, 'raster_drop_all.sql'),
      joined(
        ...['rtpostgis_upgrade_cleanup.sql', 'rtpostgis_drop.sql', 'uninstall_rtpostgis.sql'].map(
          (file) => read(path.join(raster, file)),
        ),
      ),
    );
    const topologyUpgrade = joined(
      ...[
        path.join(pg, 'common_before_upgrade.sql'),
        path.join(topology, 'topology_before_upgrade.sql'),
        path.join(topology, 'topology_upgrade.sql.in'),
        path.join(topology, 'topology_after_upgrade.sql'),
        path.join(pg, 'common_after_upgrade.sql'),
      ].map(read),
    );
    write(
      path.join(topology, 'topology_upgrade.sql'),
      joined('BEGIN;', topologyUpgrade, 'COMMIT;'),
    );
    write(path.join(topologySql, 'topology_upgrade.sql'), topologyBody(topologyUpgrade));
  } else if (phase === 'postgis-sql-install') {
    const template = read(
      path.join(directory, 'extensions/postgis/unpackage_raster_if_needed.sql'),
    );
    const marker = template.indexOf('\n', template.indexOf('UNPACKAGE_CODE'));
    assert(
      template.includes('UNPACKAGE_CODE') && marker !== -1,
      'missing raster unpackage insertion marker',
    );
    write(
      path.join(sql, 'raster_unpackage.sql'),
      template.slice(0, marker + 1) +
        joined(read(path.join(sql, 'raster_unpackage_body.sql'))) +
        template.slice(marker + 1),
    );
    const guard = '\\echo Use "CREATE EXTENSION postgis" to load this file. \\quit';
    const joinFiles = (output: string, inputs: string[]) =>
      write(path.join(sql, output), joined(guard, ...inputs.map(read)));
    joinFiles(
      `postgis--${pgis.version}.sql`,
      ['postgis_for_extension.sql', 'spatial_ref_sys_config_dump.sql', 'spatial_ref_sys.sql'].map(
        (file) => path.join(sql, file),
      ),
    );
    joinFiles(`postgis--ANY--${pgis.version}.sql`, [
      path.join(directory, 'extensions/postgis_extension_helper.sql'),
      ...[
        'raster_unpackage.sql',
        'postgis_upgrade.sql',
        'spatial_ref_sys.sql',
        'spatial_ref_sys_config_dump.sql',
      ].map((file) => path.join(sql, file)),
      path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql'),
    ]);
    const tag = `-- Just tag extension postgis version as "ANY"\n-- Installed by postgis ${pgis.version}\n-- Built on ${sourceDate(config)}\n`;
    write(path.join(sql, 'postgis--TEMPLATED--TO--ANY.sql'), tag);
    write(path.join(sql, `postgis--${pgis.version}--ANY.sql`), tag);
    write(path.join(sql, 'postgis--unpackaged.sql'), '-- Nothing to do here\n');
    const rasterGuard = '\\echo Use "CREATE EXTENSION postgis_raster" to load this file. \\quit';
    write(
      path.join(rasterSql, `postgis_raster--${pgis.version}.sql`),
      joined(rasterGuard, read(path.join(rasterSql, 'rtpostgis.sql'))),
    );
    write(
      path.join(rasterSql, `postgis_raster--ANY--${pgis.version}.sql`),
      joined(
        rasterGuard,
        ...[
          path.join(directory, 'extensions/postgis_extension_helper.sql'),
          path.join(rasterSql, 'rtpostgis_upgrade.sql'),
          path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql'),
        ].map(read),
      ),
    );
    const rasterTag = tag.replaceAll('extension postgis ', 'extension postgis_raster ');
    write(path.join(rasterSql, 'postgis_raster--TEMPLATED--TO--ANY.sql'), rasterTag);
    write(path.join(rasterSql, `postgis_raster--${pgis.version}--ANY.sql`), rasterTag);
    write(path.join(rasterSql, 'postgis_raster--unpackaged.sql'), '-- Nothing to do here\n');
    write(
      path.join(topologySql, `postgis_topology--${pgis.version}.sql`),
      joined(
        ...[
          path.join(topologyExtension, 'extlock.sql'),
          path.join(topologySql, 'topology.sql'),
          path.join(topologyExtension, 'sql_bits/mark_editable_objects.sql.in'),
        ].map(read),
      ),
    );
    write(
      path.join(topologySql, `postgis_topology--ANY--${pgis.version}.sql`),
      joined(
        ...[
          path.join(topologyExtension, 'extlock.sql'),
          path.join(directory, 'extensions/postgis_extension_helper.sql'),
          path.join(topologySql, 'topology_upgrade.sql'),
          path.join(topologyExtension, 'sql_bits/mark_editable_objects.sql.in'),
          path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql'),
        ].map(read),
      ),
    );
    write(path.join(topologySql, 'postgis_topology--unpackaged.sql'), '-- Nothing to do here\n');
    copyFileSync(
      path.join(tigerSql, 'postgis_tiger_geocoder.sql'),
      path.join(tigerSql, `postgis_tiger_geocoder--${pgis.version}.sql`),
    );
    write(
      path.join(tigerSql, `postgis_tiger_geocoder--ANY--${pgis.version}.sql`),
      joined(
        read(path.join(directory, 'extensions/postgis_extension_helper.sql')),
        read(path.join(tigerSql, 'tiger_geocoder_minor.sql')),
        read(path.join(tigerExtension, 'sql_bits/mark_editable_objects.sql.in')),
        tigerDropSchema,
        read(path.join(directory, 'extensions/postgis_extension_helper_uninstall.sql')),
      ),
    );
    copyFileSync(
      path.join(tigerExtension, 'sql_bits/tiger_geocoder--unpackaged.sql.in'),
      path.join(tigerSql, `postgis_tiger_geocoder--unpackaged--${pgis.version}.sql`),
    );
    for (const [name, folder] of [
      ['postgis_topology', topologySql],
      ['postgis_tiger_geocoder', tigerSql],
    ]) {
      const extensionTag = tag.replaceAll('extension postgis ', `extension ${name} `);
      write(path.join(folder, `${name}--TEMPLATED--TO--ANY.sql`), extensionTag);
      write(path.join(folder, `${name}--${pgis.version}--ANY.sql`), extensionTag);
    }
  } else if (phase === 'postgis-sql-unpackaged') {
    for (const [name, folder] of [
      ['postgis', sql],
      ['postgis_raster', rasterSql],
    ]) {
      const file = path.join(folder, `${name}--unpackaged--${pgis.version}.sql`);
      write(file, joined(read(file), read(path.join(folder, `${name}--ANY--${pgis.version}.sql`))));
    }
    const topologyUnpackaged = path.join(
      topologySql,
      `postgis_topology--unpackaged--${pgis.version}.sql`,
    );
    write(
      topologyUnpackaged,
      joined(read(topologyUnpackaged), read(path.join(topologySql, 'topology_upgrade.sql'))),
    );
  } else throw new Error(`unknown SQL phase ${phase}`);
}

export function pgtap(config: Config, install = false) {
  const directory = path.join(config.work, 'pgtap-windows'),
    sql = path.join(directory, 'sql');
  if (!install) {
    copy(path.join(config.repo, 'target/oliphaunt-sources/checkouts/pgtap'), directory);
    const expandPgtap = (module: string) =>
      read(path.join(sql, 'pgtap.sql.in'))
        .replaceAll('MODULE_PATHNAME', module)
        .replaceAll('__OS__', 'MSWin32')
        .replaceAll('__VERSION__', version(directory, 'pgtap').split('.').slice(0, 2).join('.'));
    write(path.join(sql, 'pgtap.sql'), expandPgtap('pgtap'));
    for (const input of glob(sql, '*.sql.in')) {
      const output = path.join(sql, input.slice(0, -3));
      if (!existsSync(output)) copyFileSync(path.join(sql, input), output);
    }
    write(path.join(sql, 'pgtap-static.sql'), expandPgtap('$libdir/pgtap'));
  } else {
    const release = version(directory, 'pgtap');
    for (const name of ['pgtap', 'pgtap-core', 'pgtap-schema'])
      copyFileSync(path.join(sql, `${name}.sql`), path.join(sql, `${name}--${release}.sql`));
  }
}

if (import.meta.main) {
  const phase = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: Object.fromEntries(
      ['repo', 'work', 'postgres', 'install', 'extension'].map((key) => [key, { type: 'string' }]),
    ),
  });
  for (const key of ['repo', 'work', 'postgres', 'install'])
    assert(typeof values[key] === 'string' && values[key], `missing --${key}`);
  const config = Object.fromEntries(
    ['repo', 'work', 'postgres', 'install'].map((key) => [
      key,
      path.resolve(values[key] as string),
    ]),
  ) as Config;
  switch (phase) {
    case 'simple':
      assert(typeof values.extension === 'string', 'missing --extension');
      prepareSimple(config, values.extension);
      break;
    case 'postgis-config':
      preparePostgis(config);
      break;
    case 'postgis-meson':
      postgisMeson(config);
      break;
    case 'postgis-module-stems':
      console.log(postgisModuleStems(config).join('\n'));
      break;
    case 'postgis-version':
      console.log(postgisVersion(postgisDirectory(config)).version);
      break;
    case 'postgres-major':
      console.log(
        String(
          Bun.TOML.parse(read(path.join(config.repo, 'src/third-party/postgres/source.toml')))
            .postgresql.version,
        ).split('.')[0] + '0',
      );
      break;
    case 'postgis-sql-preprocess':
    case 'postgis-sql-upgrade':
    case 'postgis-sql-install':
    case 'postgis-sql-unpackaged':
      postgisSql(config, phase);
      break;
    case 'pgtap':
      pgtap(config);
      break;
    case 'pgtap-install':
      pgtap(config, true);
      break;
    default:
      throw new Error(`unknown Windows extension phase ${phase}`);
  }
}
